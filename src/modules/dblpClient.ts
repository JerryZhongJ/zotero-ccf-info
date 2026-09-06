/**
 * DBLP 官方 API 客户端（限流调度器）
 *
 * 直连 dblp.org 及其两个官方镜像（uni-trier / dagstuhl）。DBLP 按客户端
 * IP 限流（连续几个请求即 429/503），因此：
 *   - 所有请求经过一个串行队列，最小间隔 + 随机抖动
 *   - 三主机轮转，收到 429/503 的主机进入指数冷却
 *   - 所有主机都在冷却时，若最近的解冻时间在容忍窗口内则挂起等待，
 *     否则本轮查询判定失败
 *
 * 状态机: healthy → cooldown(截止时间) → 疑似死亡(周期侦察) → 复活
 */

/** 单个查询结果条目（DBLP hits[].info 的相关子集） */
export interface DblpHit {
  /** DBLP 记录键，如 "journals/pacmpl/FallinB25" */
  key: string;
  /** 原始标题（含标点） */
  title: string;
  /** 期刊专刊号（如 PACMPL 的 "PLDI"），会议论文为 undefined */
  number?: string;
}

const HOSTS = [
  "https://dblp.org",
  "https://dblp.uni-trier.de",
  "https://dblp.dagstuhl.de",
] as const;

/** 相邻请求最小间隔（ms），按实测 DBLP 在 ~4 连发后开始 429 */
const MIN_INTERVAL_MS = 2500;
/** 间隔抖动上限（ms），避免节拍过于规律 */
const JITTER_MS = 800;
/** 冷却时间序列（ms）：5s → 10s → 20s → 40s */
const COOLDOWN_STEPS_MS = [5_000, 10_000, 20_000, 40_000];
/** 连续冷却失败这么多次后标记疑似死亡 */
const SUSPECT_AFTER_FAILURES = 5;
/** 疑似死亡主机的侦察间隔（ms） */
const PROBE_INTERVAL_MS = 120_000;
/** 全部主机冷却时，最多挂起等待最近解冻的时间（ms） */
const MAX_WAIT_FOR_HOST_MS = 90_000;
/** 单请求超时（ms） */
const REQUEST_TIMEOUT_MS = 15_000;

interface HostState {
  /** 冷却截止时间戳（ms），0 表示不在冷却 */
  cooldownUntil: number;
  /** 连续冷却失败计数（成功后清零） */
  consecutiveFailures: number;
  /** 上次侦察疑似死亡主机的时间戳 */
  lastProbe: number;
}

type Timer = { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };

/**
 * 可注入定时器与 fetch，便于测试中虚拟推进时间。
 * Zotero 环境用默认全局实现。
 */
export interface DblpClientDeps {
  fetchFn?: typeof fetch;
  timers?: Timer;
  now?: () => number;
}

export class DblpClient {
  private readonly fetchFn: typeof fetch;
  private readonly timers: Timer;
  private readonly now: () => number;

  private readonly hostStates: HostState[] = HOSTS.map(() => ({
    cooldownUntil: 0,
    consecutiveFailures: 0,
    lastProbe: 0,
  }));
  /** 轮转游标 */
  private nextHost = 0;
  /** 队列尾部的调度时间戳，保证串行 + 最小间隔 */
  private queueFreeAt = 0;
  /** 查询结果缓存：cleaned title → hits（命中过的标题不重复查） */
  private readonly cache = new Map<string, DblpHit[]>();

  constructor(deps: DblpClientDeps = {}) {
    this.fetchFn = deps.fetchFn ?? fetch;
    this.timers = deps.timers ?? {
      setTimeout: setTimeout,
      clearTimeout: clearTimeout,
    };
    this.now = deps.now ?? Date.now;
  }

  /**
   * 按标题查询论文。串行限速，自动处理主机轮转、退避与挂起等待。
   * 返回 null 表示网络层面彻底失败（所有主机不可用且无法等待）。
   */
  async search(title: string): Promise<DblpHit[] | null> {
    const cached = this.cache.get(title);
    if (cached) return cached;

    const hits = await this.dispatch(title);
    if (hits) this.cache.set(title, hits);
    return hits;
  }

  // ---------------------------------------------------------------------------
  // 调度：串行队列 + 主机选择
  // ---------------------------------------------------------------------------

  private async dispatch(query: string): Promise<DblpHit[] | null> {
    // 等到队列空闲（串行 + 间隔），同时确保有主机可用
    await this.waitForSlot();

    const host = this.pickHost();
    // pickHost 前已由 waitForSlot 保证有可用主机；防御性兜底
    if (host === -1) return null;

    try {
      const hits = await this.request(host, query);
      this.markSuccess(host);
      return hits;
    } catch {
      this.markFailure(host);
      // 换下一个主机重试一次（本请求已出队，直接内部重试）
      return this.retryOnNextHost(query, host);
    }
  }

  private async retryOnNextHost(
    query: string,
    failedHost: number,
  ): Promise<DblpHit[] | null> {
    for (let attempt = 0; attempt < HOSTS.length - 1; attempt++) {
      await this.waitForSlot();
      const host = this.pickHostExcluding(failedHost);
      if (host === -1) return null;
      try {
        const hits = await this.request(host, query);
        this.markSuccess(host);
        return hits;
      } catch {
        this.markFailure(host);
        failedHost = host;
      }
    }
    return null;
  }

  /** 等到本请求可以出队的时刻，保证此时至少有一个主机不在冷却 */
  private async waitForSlot(): Promise<void> {
    const scheduledAt = Math.max(this.now(), this.queueFreeAt);
    const sleepMs = scheduledAt - this.now();
    if (sleepMs > 0) await this.sleep(sleepMs);
    // 释放队列时间推进到本请求之后
    this.queueFreeAt = scheduledAt + MIN_INTERVAL_MS + this.rand();

    // 所有主机都在冷却 → 挂起等待最近解冻，或判定失败
    const waitNeeded = this.msUntilAnyHostReady();
    if (waitNeeded > 0) {
      if (waitNeeded > MAX_WAIT_FOR_HOST_MS) {
        throw new Error(
          `all DBLP hosts cooling down (retry in ${Math.round(waitNeeded / 1000)}s)`,
        );
      }
      await this.sleep(waitNeeded);
    }
  }

  /** 距最近的可用主机还有多少 ms；0 表示现在就有 */
  private msUntilAnyHostReady(): number {
    const t = this.now();
    return Math.min(
      ...this.hostStates.map((s) => {
        if (s.consecutiveFailures >= SUSPECT_AFTER_FAILURES) {
          // 疑似死亡：侦察时刻或冷却截止，取较晚
          const probeAt = Math.max(s.cooldownUntil, s.lastProbe + PROBE_INTERVAL_MS);
          return Math.max(0, probeAt - t);
        }
        return Math.max(0, s.cooldownUntil - t);
      }),
    );
  }

  private pickHost(): number {
    for (let i = 0; i < HOSTS.length; i++) {
      const idx = (this.nextHost + i) % HOSTS.length;
      if (this.isUsable(idx)) {
        this.nextHost = (idx + 1) % HOSTS.length;
        return idx;
      }
    }
    return -1;
  }

  private pickHostExcluding(exclude: number): number {
    const saved = this.nextHost;
    if (saved === exclude) this.nextHost = (saved + 1) % HOSTS.length;
    const host = this.pickHost();
    return host === exclude ? -1 : host;
  }

  private isUsable(idx: number): boolean {
    const s = this.hostStates[idx];
    const t = this.now();
    if (s.consecutiveFailures >= SUSPECT_AFTER_FAILURES) {
      // 侦察窗口已到才允许复用（由 waitForSlot 保证时间已推进）
      return t >= s.lastProbe + PROBE_INTERVAL_MS;
    }
    return t >= s.cooldownUntil;
  }

  // ---------------------------------------------------------------------------
  // 主机状态流转
  // ---------------------------------------------------------------------------

  private markSuccess(host: number): void {
    this.hostStates[host] = {
      cooldownUntil: 0,
      consecutiveFailures: 0,
      lastProbe: this.now(),
    };
  }

  private markFailure(host: number): void {
    const s = this.hostStates[host];
    const step = Math.min(s.consecutiveFailures, COOLDOWN_STEPS_MS.length - 1);
    s.cooldownUntil = this.now() + COOLDOWN_STEPS_MS[step];
    s.consecutiveFailures++;
  }

  // ---------------------------------------------------------------------------
  // HTTP
  // ---------------------------------------------------------------------------

  private async request(host: number, query: string): Promise<DblpHit[]> {
    const url =
      `${HOSTS[host]}/search/publ/api?format=json&h=30&q=${encodeURIComponent(query)}`;
    const ctrl = new AbortController();
    const timer = this.timers.setTimeout(
      () => ctrl.abort(),
      REQUEST_TIMEOUT_MS,
    );
    try {
      const resp = await this.fetchFn(url, { signal: ctrl.signal });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = (await resp.json()) as any;
      return parseHits(data);
    } finally {
      this.timers.clearTimeout(timer);
    }
  }

  // ---------------------------------------------------------------------------
  // 杂项
  // ---------------------------------------------------------------------------

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => this.timers.setTimeout(resolve, ms));
  }

  private rand(): number {
    return MIN_INTERVAL_MS > 0 ? Math.random() * JITTER_MS : 0;
  }
}

// ---------------------------------------------------------------------------
// 响应解析（导出以便测试）
// ---------------------------------------------------------------------------

export function parseHits(apiResponse: any): DblpHit[] {
  const hits = apiResponse?.result?.hits?.hit;
  if (!Array.isArray(hits)) return [];
  return hits
    .map((h: any) => h?.info)
    .filter((info: any) => info?.key && info?.title)
    .map((info: any) => ({
      key: info.key as string,
      title: info.title as string,
      ...(info.number ? { number: info.number as string } : {}),
    }));
}
