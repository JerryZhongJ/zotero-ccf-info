/**
 * Crossref API 客户端（限速队列）
 *
 * Crossref 对程序化访问友好（无需认证），仅需礼貌限速。所有请求经过
 * 一个串行队列，相邻请求最小间隔 + 随机抖动，避免给公共 API 施压。
 *
 * 注：不使用 AbortController（Zotero 插件沙箱无此全局对象），超时用
 * Promise.race 实现。
 */

/** 单个查询结果条目（Crossref message.items 的相关子集） */
export interface CrossrefHit {
  /** 原始标题（含标点） */
  title: string;
  /** 发表 venue 名（container-title），如 "Proceedings of the ACM on Programming Languages" */
  venue?: string;
  /** 期刊专刊号（如 PACMPL 的 "PLDI"），来自 issue 字段 */
  issue?: string;
}

/**
 * 网络层查询失败。携带最后一次失败的具体原因，
 * 便于区分限流（429）、代理认证（407）、DNS 失败等场景。
 */
export class CrossrefNetworkError extends Error {
  /** 最后一次尝试失败的具体原因（HTTP 状态码或异常名） */
  readonly lastReason: string;

  constructor(lastReason: string) {
    super(`Crossref request failed (${lastReason})`);
    this.name = "CrossrefNetworkError";
    this.lastReason = lastReason;
  }
}

const API_BASE = "https://api.crossref.org/works";

/** 相邻请求最小间隔（ms），Crossref 礼貌限速 */
const MIN_INTERVAL_MS = 1_000;
/** 间隔抖动上限（ms），避免节拍过于规律 */
const JITTER_MS = 400;
/** 单请求超时（ms） */
const REQUEST_TIMEOUT_MS = 30_000;
/** 拉取的候选条数：同名预印本/书章可能压住正式版本，需要足够候选 */
const MAX_ROWS = 20;

type Timer = { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };

/**
 * 可注入定时器与 fetch，便于测试中虚拟推进时间。
 * Zotero 环境用默认全局实现。
 */
export interface CrossrefClientDeps {
  fetchFn?: typeof fetch;
  timers?: Timer;
  now?: () => number;
}

/** 从 fetch 异常提取简短原因，用于用户可见的报错信息 */
function describeError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError") return "timeout";
    // request() 对非 2xx / 非 JSON 手动设置了 cause（如 "HTTP 429"）
    if (typeof (err as { cause?: unknown }).cause === "string") {
      return (err as { cause: string }).cause;
    }
    // Zotero/Firefox 网络异常形如 TypeError，cause 可能带底层错误码
    const cause = (err as { cause?: { code?: string; name?: string } }).cause;
    if (cause?.code) return cause.code; // 如 EAI_AGAIN（DNS 失败）
    if (err.message && err.message !== "Network Error") return err.message.slice(0, 120);
  }
  return "network error";
}

export class CrossrefClient {
  private readonly fetchFn: typeof fetch;
  private readonly timers: Timer;
  private readonly now: () => number;

  /** 队列尾部的调度时间戳，保证串行 + 最小间隔 */
  private queueFreeAt = 0;
  /** 查询结果缓存：title → hits（命中过的标题不重复查） */
  private readonly cache = new Map<string, CrossrefHit[]>();

  constructor(deps: CrossrefClientDeps = {}) {
    this.fetchFn = deps.fetchFn ?? fetch;
    this.timers = deps.timers ?? {
      setTimeout: setTimeout,
      clearTimeout: clearTimeout,
    };
    this.now = deps.now ?? Date.now;
  }

  /**
   * 按标题查询论文。串行限速。
   * 网络层失败时抛出 CrossrefNetworkError，携带具体原因。
   */
  async search(title: string): Promise<CrossrefHit[]> {
    const cached = this.cache.get(title);
    if (cached) return cached;

    const hits = await this.dispatch(title);
    if (hits) this.cache.set(title, hits);
    return hits;
  }

  // ---------------------------------------------------------------------------
  // 调度：串行队列
  // ---------------------------------------------------------------------------

  private async dispatch(query: string): Promise<CrossrefHit[]> {
    // 等到队列空闲（串行 + 间隔）
    const scheduledAt = Math.max(this.now(), this.queueFreeAt);
    const sleepMs = scheduledAt - this.now();
    if (sleepMs > 0) await this.sleep(sleepMs);
    this.queueFreeAt = scheduledAt + MIN_INTERVAL_MS + this.rand();

    try {
      const hits = await this.request(query);
      return hits;
    } catch (err) {
      // 429/5xx 是瞬时状态，换一次立即重试的机会（等待一个间隔）
      const reason = describeError(err);
      if (reason === "timeout" || reason.startsWith("HTTP 5") || reason.startsWith("HTTP 429")) {
        await this.sleep(MIN_INTERVAL_MS + this.rand());
        try {
          return await this.request(query);
        } catch (retryErr) {
          throw new CrossrefNetworkError(describeError(retryErr));
        }
      }
      throw new CrossrefNetworkError(reason);
    }
  }

  // ---------------------------------------------------------------------------
  // HTTP
  // ---------------------------------------------------------------------------

  private async request(query: string): Promise<CrossrefHit[]> {
    const url =
      `${API_BASE}?query.title=${encodeURIComponent(query)}&rows=${MAX_ROWS}` +
      `&select=title,container-title,issue`;

    // Zotero 插件沙箱里没有 AbortController，用 Promise.race 实现超时。
    // 超时后底层请求仍在后台进行，但不影响结果（本请求已判定失败）。
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = this.timers.setTimeout(() => {
        const err = new Error("timeout");
        err.name = "TimeoutError";
        reject(err);
      }, REQUEST_TIMEOUT_MS);
    });

    try {
      const resp = await Promise.race([this.fetchFn(url), timeout]);
      const body = await resp.text();

      if (!resp.ok) {
        const err = new Error(`HTTP ${resp.status}`) as Error & {
          cause?: string;
        };
        // 407 = 代理要求认证，429/5xx 等原样透传，用户可据此排查
        err.cause = `HTTP ${resp.status}${resp.status === 407 ? " (proxy auth required)" : ""}`;
        throw err;
      }

      let data: any;
      try {
        data = JSON.parse(body);
      } catch {
        // 响应不是 JSON：多半是代理/拦截页等 HTML，透出开头片段便于定位
        const snippet = body.trim().slice(0, 80).replace(/\s+/g, " ");
        const err = new Error("non-JSON response") as Error & {
          cause?: string;
        };
        err.cause = `non-JSON response: "${snippet}"`;
        throw err;
      }
      return parseHits(data);
    } finally {
      if (timer !== undefined) this.timers.clearTimeout(timer);
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

export function parseHits(apiResponse: any): CrossrefHit[] {
  const items = apiResponse?.message?.items;
  if (!Array.isArray(items)) return [];
  const hits: CrossrefHit[] = [];
  for (const item of items) {
    const title = (item?.title as string[] | undefined)?.[0];
    if (!title) continue;
    const venue = (item?.["container-title"] as string[] | undefined)?.[0];
    const issue = item?.issue != null ? String(item.issue) : undefined;
    hits.push({
      title,
      ...(venue ? { venue } : {}),
      ...(issue ? { issue } : {}),
    });
  }
  return hits;
}
