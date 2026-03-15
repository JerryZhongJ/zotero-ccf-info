import { ccfRankList } from "./ccfRankList";

const DBLP_API = "https://dblp.timetrap.workers.dev/";

export interface CCFResult {
  rank: string;
  abbr: string;
}

function cleanString(input: string): string {
  return input.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function resolveCCFRank(
  urls: { title: string; url: string }[],
  title: string,
): CCFResult {
  let ccfNoneInfo: string | undefined;

  for (const entry of urls) {
    if (entry.title !== title) continue;
    const dblpPath = "/" + entry.url.substring(0, entry.url.lastIndexOf("/"));
    const rankInfo = ccfRankList[dblpPath];
    if (rankInfo) {
      return { rank: `CCF-${rankInfo.rank}`, abbr: rankInfo.abbr };
    }
    const abbr = dblpPath
      .substring(dblpPath.indexOf("/", 1) + 1)
      .toUpperCase();
    if (!ccfNoneInfo || abbr !== "CORR") {
      ccfNoneInfo = abbr;
    }
  }

  return ccfNoneInfo
    ? { rank: "CCF-None", abbr: ccfNoneInfo }
    : { rank: "Not Found", abbr: "" };
}

export const PaperInfo = {
  async getPaperCCFRank(title: string): Promise<CCFResult> {
    const cleaned = cleanString(title);
    if (!cleaned) return { rank: "Not Found", abbr: "" };

    const resp = await fetch(
      `${DBLP_API}?query=${encodeURIComponent(cleaned)}`,
    );
    if (!resp.ok) return { rank: `Net Error: ${resp.status}`, abbr: "" };

    const data = await resp.json() as unknown as any;
    return resolveCCFRank(data.urls, cleaned);
  },

  async batchGetPaperCCFRank(titles: string[]): Promise<CCFResult[]> {
    const cleaned = titles.map(cleanString);

    const resp = await fetch(DBLP_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ queries: cleaned }),
    });
    if (!resp.ok) {
      return cleaned.map(() => ({ rank: `Net Error: ${resp.status}`, abbr: "" }));
    }

    const data = (await resp.json()) as unknown as any[];
    return cleaned.map((title, i) => resolveCCFRank(data[i].urls, title));
  },
};
