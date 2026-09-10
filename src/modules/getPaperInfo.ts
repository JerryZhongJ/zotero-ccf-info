import { ccfRankList, type RankInfo } from "./ccfRankList";
import {
  CrossrefClient,
  CrossrefNetworkError,
  type CrossrefHit,
} from "./crossrefClient";

export interface CCFResult {
  rank: string;
  abbr: string;
}

function cleanString(input: string): string {
  return input.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

// ---------------------------------------------------------------------------
// venue 名称匹配：与 ccfRankList 的官方 CCF 名称做归一化 token 重叠
// （Jaccard）匹配。原则：宁缺毋滥——只做高置信命中，认不出的返回 null
// 交给 Crossref 兜底，绝不冒认错 venue 的风险。
// ---------------------------------------------------------------------------

/** 匹配时忽略的功能词与纯数字（年份）token */
const STOPWORDS = new Set(["the", "of", "on", "in", "and", "for", "a", "an"]);

function tokenize(input: string): Set<string> {
  return new Set(
    input
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t && !STOPWORDS.has(t) && !/^\d+$/.test(t)),
  );
}

interface VenueIndexEntry {
  info: RankInfo;
  tokens: Set<string>;
  abbrLower: string;
}

/** venue 索引，懒构建一次 */
let venueIndex: VenueIndexEntry[] | null = null;

function getVenueIndex(): VenueIndexEntry[] {
  if (!venueIndex) {
    venueIndex = Object.values(ccfRankList).map((info) => ({
      info,
      tokens: tokenize(info.full),
      abbrLower: info.abbr.toLowerCase(),
    }));
  }
  return venueIndex;
}

/**
 * 归一化 token 重叠（Jaccard）+ 缩写出现加分。
 * 阈值取高（0.6）保证准确性：venue 名与官方名差异过大时返回 null，
 * 由 Crossref 兜底，避免误配成其他期刊/会议。
 */
const MATCH_THRESHOLD = 0.6;
const ABBR_BONUS = 0.5;

export function matchVenue(venueName: string): RankInfo | null {
  const venueTokens = tokenize(venueName);
  let best: RankInfo | null = null;
  let bestScore = 0;

  for (const entry of getVenueIndex()) {
    let inter = 0;
    for (const t of entry.tokens) if (venueTokens.has(t)) inter++;
    const union = entry.tokens.size + venueTokens.size - inter;
    if (union === 0) continue;

    let score = inter / union;
    if (venueTokens.has(entry.abbrLower)) score += ABBR_BONUS;
    if (score > bestScore) {
      bestScore = score;
      best = entry.info;
    }
  }
  return bestScore >= MATCH_THRESHOLD ? best : null;
}

/**
 * PACMPL 以专刊形式出版各会议论文，整体被 CCF 标为 C 类期刊，
 * 但其中 PLDI/POPL/OOPSLA/ICFP 专刊应按对应会议的等级计算。
 * Crossref 的 issue 字段直接给出专刊号（如 "PLDI"）。
 */
const PACMPL_ISSUE_MAP: Record<string, string> = {
  PLDI: "/conf/pldi",
  POPL: "/conf/popl",
  OOPSLA1: "/conf/oopsla",
  OOPSLA2: "/conf/oopsla",
  OOPSLA: "/conf/oopsla",
  ICFP: "/conf/icfp",
};

/** venue 名是否为 PACMPL（Proceedings of the ACM on Programming Languages） */
function isPacmpl(venue: string): boolean {
  const v = venue.toLowerCase();
  return v.includes("programming languages") && v.includes("acm");
}

/**
 * 从 venue 名提取括号中的缩写作 CCF-None 的展示（如 "… (CVPR)" → "CVPR"）。
 * 仅展示用途：CCF-A/B/C 的缩写全部来自 ccfRankList 预定义，不走这里。
 */
function extractAbbr(venue: string): string {
  const matches = venue.match(/\(([^)]{2,12})\)/g);
  if (matches && matches.length > 0) {
    return matches[matches.length - 1].slice(1, -1).toUpperCase();
  }
  return "";
}

/**
 * 用 Crossref 命中列表解析 CCF 等级。
 * 标题归一化精确匹配；venue 名匹配 ccfRankList；
 * PACMPL 专刊按 issue 号映射到对应会议等级。
 */
function resolveCCFRank(hits: CrossrefHit[], title: string): CCFResult {
  const cleaned = cleanString(title);
  let ccfNoneAbbr: string | undefined;

  for (const hit of hits) {
    if (cleanString(hit.title) !== cleaned) continue;
    const venue = hit.venue ?? "";

    // PACMPL 专刊：按 issue 号映射到对应会议
    if (hit.issue && venue && isPacmpl(venue)) {
      const confKey = PACMPL_ISSUE_MAP[hit.issue.toUpperCase()];
      if (confKey && ccfRankList[confKey]) {
        return { rank: `CCF-${ccfRankList[confKey].rank}`, abbr: ccfRankList[confKey].abbr };
      }
    }

    const rankInfo = venue ? matchVenue(venue) : null;
    if (rankInfo) {
      return { rank: `CCF-${rankInfo.rank}`, abbr: rankInfo.abbr };
    }

    const abbr = venue ? extractAbbr(venue) : "";
    if (abbr && !ccfNoneAbbr) ccfNoneAbbr = abbr;
  }

  return ccfNoneAbbr
    ? { rank: "CCF-None", abbr: ccfNoneAbbr }
    : { rank: "Not Found", abbr: "" };
}

export const PaperInfo = {
  client: new CrossrefClient(),

  /**
   * 查询单篇论文的 CCF 等级。优先用本地 venue 匹配（零网络请求）；
   * 本地未命中时走 Crossref 标题查询，网络也无果时用本地 venue 的
   * 括号缩写兜底显示 CCF-None。
   * 抛出 CrossrefNetworkError 表示网络层面失败，
   * 异常 message 中含最后一次失败的具体原因。
   */
  async getPaperCCFRank(
    title: string,
    localVenue?: string,
    localIssue?: string,
  ): Promise<CCFResult> {
    if (!cleanString(title)) return { rank: "Not Found", abbr: "" };

    // 本地 venue 优先：Zotero 条目自带的发表 venue（publicationTitle /
    // proceedingsTitle / conferenceName），无需联网且无标题歧义。
    if (localVenue) {
      // PACMPL 专刊：按 issue 号映射到对应会议（issue 元数据随条目自带）
      if (localIssue && isPacmpl(localVenue)) {
        const confKey = PACMPL_ISSUE_MAP[localIssue.toUpperCase()];
        if (confKey && ccfRankList[confKey]) {
          return {
            rank: `CCF-${ccfRankList[confKey].rank}`,
            abbr: ccfRankList[confKey].abbr,
          };
        }
      }

      const rankInfo = matchVenue(localVenue);
      // 命中即返回；未命中（含 CCF-None 场景）继续走 Crossref，
      // 网络也无果时再用本地缩写兜底
      if (rankInfo) {
        return { rank: `CCF-${rankInfo.rank}`, abbr: rankInfo.abbr };
      }
    }

    const hits = await this.client.search(title);
    const result = resolveCCFRank(hits, title);

    if (result.rank === "Not Found" && localVenue) {
      const abbr = extractAbbr(localVenue);
      if (abbr) return { rank: "CCF-None", abbr };
    }
    return result;
  },

  /**
   * 批量查询。单项失败不中断批次：网络失败的项以 CrossrefNetworkError
   * 实例表示，其余正常。
   */
  async batchGetPaperCCFRank(
    entries: { title: string; venue?: string; issue?: string }[],
  ): Promise<(CCFResult | CrossrefNetworkError)[]> {
    const results = await Promise.all(
      entries.map(async (entry) => {
        try {
          return await this.getPaperCCFRank(entry.title, entry.venue, entry.issue);
        } catch (err) {
          return err instanceof CrossrefNetworkError
            ? err
            : new CrossrefNetworkError(String(err));
        }
      }),
    );
    return results;
  },
};
