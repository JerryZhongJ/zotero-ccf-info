import { ccfRankList } from "./ccfRankList";
import { DblpClient, type DblpHit } from "./dblpClient";

export interface CCFResult {
  rank: string;
  abbr: string;
}

function cleanString(input: string): string {
  return input.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

/**
 * PACMPL 以专刊形式出版各会议论文，整体被 CCF 标为 C 类期刊，
 * 但其中 PLDI/POPL/OOPSLA/ICFP 专刊应按对应会议的等级计算。
 * 映射到 ccfRankList 的会议键，复用其等级数据。
 */
const PACMPL_ISSUE_MAP: Record<string, string> = {
  PLDI: "/conf/pldi",
  POPL: "/conf/popl",
  OOPSLA1: "/conf/oopsla",
  OOPSLA2: "/conf/oopsla",
  OOPSLA: "/conf/oopsla",
  ICFP: "/conf/icfp",
};

/**
 * DBLP 记录键 → ccfRankList 键 + 专刊覆盖。
 * 例：key "journals/pacmpl/FallinB25", number "PLDI"
 *   → 主键 "/journals/pacmpl"（CCF-C），专刊覆盖 "/conf/pldi"（CCF-A）
 */
function resolveVenue(key: string, number?: string): string | undefined {
  const path = "/" + key.substring(0, key.lastIndexOf("/"));

  // PACMPL 专刊：按 issue 号映射到对应会议
  if (number && path === "/journals/pacmpl") {
    const confKey = PACMPL_ISSUE_MAP[number.toUpperCase()];
    if (confKey && ccfRankList[confKey]) return confKey;
  }
  return path;
}

/** 用 DBLP 官方 API 的命中列表解析 CCF 等级（标题归一化精确匹配） */
function resolveCCFRank(hits: DblpHit[], title: string): CCFResult {
  const cleaned = cleanString(title);
  let ccfNoneInfo: string | undefined;

  for (const hit of hits) {
    if (cleanString(hit.title) !== cleaned) continue;
    const venueKey = resolveVenue(hit.key, hit.number);
    const rankInfo = venueKey ? ccfRankList[venueKey] : undefined;
    if (rankInfo) {
      return { rank: `CCF-${rankInfo.rank}`, abbr: rankInfo.abbr };
    }
    const abbr = (venueKey ?? hit.key)
      .split("/")[2]
      ?.toUpperCase();
    if (abbr && (!ccfNoneInfo || abbr !== "CORR")) {
      ccfNoneInfo = abbr;
    }
  }

  return ccfNoneInfo
    ? { rank: "CCF-None", abbr: ccfNoneInfo }
    : { rank: "Not Found", abbr: "" };
}

export const PaperInfo = {
  client: new DblpClient(),

  /**
   * 查询单篇论文的 CCF 等级。
   * 返回 null 表示网络层面失败（所有 DBLP 主机不可用）。
   */
  async getPaperCCFRank(title: string): Promise<CCFResult | null> {
    if (!cleanString(title)) return { rank: "Not Found", abbr: "" };

    const hits = await this.client.search(title);
    if (hits === null) return null;
    return resolveCCFRank(hits, title);
  },

  /** 批量查询；单项为 null 表示该篇网络失败 */
  async batchGetPaperCCFRank(titles: string[]): Promise<(CCFResult | null)[]> {
    const results = await Promise.all(
      titles.map(async (title) => this.getPaperCCFRank(title)),
    );
    return results;
  },
};
