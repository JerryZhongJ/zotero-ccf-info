import { describe, expect, it, vi } from "vitest";
import {
  CrossrefClient,
  CrossrefNetworkError,
  parseHits,
} from "../src/modules/crossrefClient";

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
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function okBody(hits: { title: string; venue?: string; issue?: string }[]) {
  return {
    message: {
      items: hits.map((h) => ({
        title: [h.title],
        ...(h.venue ? { "container-title": [h.venue] } : {}),
        ...(h.issue ? { issue: h.issue } : {}),
      })),
    },
  };
}

function makeClient(clock: FakeClock, fetchMock: ReturnType<typeof vi.fn>) {
  return new CrossrefClient({
    fetchFn: fetchMock as unknown as typeof fetch,
    timers: clock.timers,
    now: clock.nowFn,
  });
}

// 固定随机数，让抖动确定化
vi.spyOn(Math, "random").mockReturnValue(0.5);

describe("parseHits", () => {
  it("extracts title/venue/issue and drops titleless entries", () => {
    const hits = parseHits({
      message: {
        items: [
          { title: ["A Paper."], "container-title": ["Venue X"], issue: "PLDI" },
          { "container-title": ["No Title"] },
          null,
        ],
      },
    });
    expect(hits).toEqual([
      { title: "A Paper.", venue: "Venue X", issue: "PLDI" },
    ]);
  });

  it("returns empty array when no items", () => {
    expect(parseHits({ message: {} })).toEqual([]);
    expect(parseHits(undefined)).toEqual([]);
  });
});

describe("CrossrefClient", () => {
  it("queries, parses and caches results", async () => {
    const clock = new FakeClock();
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse(okBody([{ title: "Paper One.", venue: "Venue X" }])),
    );
    const client = makeClient(clock, fetchMock);

    const p = client.search("paper one");
    await clock.advance(5_000);
    const hits = await p;
    expect(hits).toEqual([{ title: "Paper One.", venue: "Venue X" }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      "https://api.crossref.org/works?query.title=paper%20one",
    );

    // 第二次同标题查询走缓存
    const again = await client.search("paper one");
    expect(again).toEqual(hits);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("serializes concurrent searches with minimum spacing", async () => {
    const clock = new FakeClock();
    const fetchMock = vi.fn().mockImplementation(async () =>
      okResponse(okBody([])),
    );
    const client = makeClient(clock, fetchMock);

    const ps = [client.search("a"), client.search("b"), client.search("c")];
    await clock.advance(10_000);
    await Promise.all(ps);

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries once on 5xx and succeeds", async () => {
    const clock = new FakeClock();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () => "Service Unavailable",
      } as unknown as Response)
      .mockResolvedValueOnce(okResponse(okBody([{ title: "Retry Paper." }])));
    const client = makeClient(clock, fetchMock);

    const p = client.search("retry paper");
    await clock.advance(15_000);
    const hits = await p;
    expect(hits).toEqual([{ title: "Retry Paper." }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws CrossrefNetworkError with the concrete reason when retries fail", async () => {
    const clock = new FakeClock();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "Too Many Requests",
    } as unknown as Response);
    const client = makeClient(clock, fetchMock);

    const p = client.search("doomed");
    await clock.advance(120_000);
    await expect(p).rejects.toBeInstanceOf(CrossrefNetworkError);
    await expect(p).rejects.toThrow(/HTTP 429/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports a snippet on non-JSON responses (e.g. proxy block page)", async () => {
    const clock = new FakeClock();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "<html>Making sure you're not a bot!</html>",
    } as unknown as Response);
    const client = makeClient(clock, fetchMock);

    const p = client.search("blocked");
    await clock.advance(30_000);
    await expect(p).rejects.toThrow(/not a bot/);
  });

  it("does not reference AbortController (Zotero sandbox lacks it)", async () => {
    const clock = new FakeClock();
    const origAbort = globalThis.AbortController;
    // @ts-expect-error -- simulate the Zotero plugin sandbox
    delete globalThis.AbortController;
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okResponse(okBody([{ title: "No Abort." }])));
    const client = makeClient(clock, fetchMock);

    try {
      const p = client.search("no abort");
      await clock.advance(10_000);
      const hits = await p;
      expect(hits).toEqual([{ title: "No Abort." }]);
    } finally {
      globalThis.AbortController = origAbort;
    }
  });

  it("times out a hanging request", async () => {
    const clock = new FakeClock();
    const fetchMock = vi.fn().mockImplementation(() => new Promise(() => {}));
    const client = makeClient(clock, fetchMock);

    const p = client.search("hanging");
    await clock.advance(200_000);
    await expect(p).rejects.toBeInstanceOf(CrossrefNetworkError);
    await expect(p).rejects.toThrow(/timeout/);
  });
});
