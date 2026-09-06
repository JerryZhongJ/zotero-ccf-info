import { describe, expect, it, vi } from "vitest";
import { DblpClient, parseHits } from "../src/modules/dblpClient";

// ---------------------------------------------------------------------------
// 虚拟时钟：记录 setTimeout 回调，手动推进，避免测试真实等待
// ---------------------------------------------------------------------------

class FakeClock {
  private now = 1_000_000;
  private queue: { id: number; at: number; fn: () => void }[] = [];
  private nextId = 1;

  readonly timers = {
    setTimeout: (fn: () => void, ms: number) => {
      const id = this.nextId++;
      this.queue.push({ id, at: this.now + ms, fn });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (id: unknown) => {
      this.queue = this.queue.filter((t) => t.id !== id);
    },
  };

  nowFn = () => this.now;

  /** 推进时间并触发到期回调 */
  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    while (this.now < target) {
      this.now = Math.min(target, this.now + 100);
      const due = this.queue.filter((t) => t.at <= this.now);
      for (const t of due) {
        this.queue = this.queue.filter((x) => x !== t);
        t.fn();
      }
      // 让 promise 微任务链跑几轮
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    }
  }
}

function okResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response;
}

function okBody(hits: { key: string; title: string; number?: string }[]) {
  return { result: { hits: { hit: hits.map((h) => ({ info: { ...h } })) } } };
}

function makeClient(clock: FakeClock, fetchMock: ReturnType<typeof vi.fn>) {
  return new DblpClient({
    fetchFn: fetchMock as unknown as typeof fetch,
    timers: clock.timers,
    now: clock.nowFn,
  });
}

// 固定随机数，让抖动确定化
vi.spyOn(Math, "random").mockReturnValue(0.5);

describe("parseHits", () => {
  it("extracts key/title/number and drops malformed entries", () => {
    const hits = parseHits({
      result: {
        hits: {
          hit: [
            { info: null },
            { info: {} },
            { info: { key: "journals/pacmpl/X25", title: "A Paper.", number: "PLDI" } },
          ],
        },
      },
    });
    expect(hits).toEqual([
      { key: "journals/pacmpl/X25", title: "A Paper.", number: "PLDI" },
    ]);
  });

  it("returns empty array when no hits", () => {
    expect(parseHits({ result: { hits: {} } })).toEqual([]);
    expect(parseHits(undefined)).toEqual([]);
  });
});

describe("DblpClient scheduling", () => {
  it("queries, parses and caches results", async () => {
    const clock = new FakeClock();
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse(okBody([{ key: "conf/pldi/X25", title: "Paper One." }])),
    );
    const client = makeClient(clock, fetchMock);

    const p = client.search("paper one");
    await clock.advance(10_000);
    const hits = await p;
    expect(hits).toEqual([{ key: "conf/pldi/X25", title: "Paper One." }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      "https://dblp.org/search/publ/api",
    );

    // 第二次同标题查询走缓存
    const again = await client.search("paper one");
    expect(again).toEqual(hits);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("serializes concurrent searches with minimum spacing and host rotation", async () => {
    const clock = new FakeClock();
    const fetchMock = vi.fn().mockImplementation(async () => okResponse(okBody([])));
    const client = makeClient(clock, fetchMock);

    const ps = [client.search("a"), client.search("b"), client.search("c")];
    await clock.advance(30_000);
    await Promise.all(ps);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const hosts = fetchMock.mock.calls.map((c) => new URL(String(c[0])).host);
    expect(new Set(hosts).size).toBe(3);
  });

  it("fails over to the next host on 429 and cools the failed one", async () => {
    const clock = new FakeClock();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({}) } as Response)
      .mockResolvedValueOnce(
        okResponse(okBody([{ key: "conf/pldi/X25", title: "Retry Paper." }])),
      );
    const client = makeClient(clock, fetchMock);

    const p = client.search("retry paper");
    await clock.advance(15_000);
    const hits = await p;
    expect(hits).toEqual([{ key: "conf/pldi/X25", title: "Retry Paper." }]);

    const hosts = fetchMock.mock.calls.map((c) => new URL(String(c[0])).host);
    expect(hosts[0]).toBe("dblp.org");
    expect(hosts[1]).toBe("dblp.uni-trier.de");
  });

  it("returns null when every host fails and cooldowns exceed the wait window", async () => {
    const clock = new FakeClock();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
    } as Response);
    const client = makeClient(clock, fetchMock);

    const p = client.search("doomed");
    await clock.advance(120_000);
    await expect(p).resolves.toBe(null);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("waits for a host to leave cooldown instead of failing (within window)", async () => {
    const clock = new FakeClock();
    let call = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      call++;
      if (call <= 2) {
        return { ok: false, status: 429, json: async () => ({}) } as Response;
      }
      return okResponse(okBody([{ key: "conf/pldi/X25", title: "After Cooldown." }]));
    });
    const client = makeClient(clock, fetchMock);

    const p = client.search("after cooldown");
    await clock.advance(60_000);
    const hits = await p;
    expect(hits).toEqual([{ key: "conf/pldi/X25", title: "After Cooldown." }]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
