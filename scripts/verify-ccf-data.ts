/**
 * CCF 数据验证脚本
 *
 * 用法：npx tsx scripts/verify-ccf-data.ts
 *
 * 从 ccf.atom.im 抓取官方数据，一次性检查：
 *   - full name 匹配
 *   - abbr 一致性
 *   - rank 一致性
 *   - DBLP 路径一致性（从 ccf.atom.im 的 <a href> 提取）
 */

import { ccfRankList, type RankInfo } from "../src/modules/ccfRankList";
import { ProxyAgent, setGlobalDispatcher } from "undici";

const proxyUrl =
  process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy;
if (proxyUrl) {
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
  console.log(`🔗 使用代理: ${proxyUrl}\n`);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CcfEntry {
  abbr: string;
  full: string;
  rank: string;
  type: string; // "会议" | "期刊"
  dblpPath: string; // 从 <a href> 提取的 DBLP 路径，如 "/conf/ppopp"
}

interface CompareResult {
  rankMismatch: { abbr: string; type: string; codeRank: string; ccfRank: string }[];
  abbrMismatch: { full: string; type: string; codeAbbr: string; ccfAbbr: string }[];
  urlMismatch: { abbr: string; type: string; codeUrl: string; ccfUrl: string }[];
  onlyInCode: { key: string; abbr: string; full: string; rank: string }[];
  onlyInCcf: { abbr: string; full: string; rank: string; type: string }[];
}

// ---------------------------------------------------------------------------
// fetchCcfList — 抓取 ccf.atom.im 并解析 HTML 表格（含 DBLP 链接）
// ---------------------------------------------------------------------------

async function fetchCcfList(): Promise<CcfEntry[]> {
  const res = await fetch("https://ccf.atom.im/");
  if (!res.ok) {
    throw new Error(`Failed to fetch ccf.atom.im: ${res.status}`);
  }
  const html = await res.text();

  const entries: CcfEntry[] = [];
  const trRegex = /<tr\s+class="item"[^>]*>([\s\S]*?)<\/tr>/g;
  const tdRegex = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g;

  const stripHtml = (s: string) =>
    s
      .replace(/<[^>]*>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .trim();

  // 从 <a href="...dblp.../db/conf/xxx/"> 提取 DBLP 路径
  const extractDblpPath = (cellHtml: string): string => {
    const hrefMatch = cellHtml.match(/<a\s+href="([^"]*)"[^>]*>/i);
    if (!hrefMatch) return "";
    const href = hrefMatch[1];
    // 匹配 /db/ 后面的路径
    const pathMatch = href.match(/\/db\/((?:conf|journals)\/[^/]+)\/?/);
    return pathMatch ? `/${pathMatch[1]}` : "";
  };

  let trMatch: RegExpExecArray | null;
  while ((trMatch = trRegex.exec(html)) !== null) {
    const rowHtml = trMatch[1];
    const rawCells: string[] = [];
    let tdMatch: RegExpExecArray | null;
    while ((tdMatch = tdRegex.exec(rowHtml)) !== null) {
      rawCells.push(tdMatch[1]);
    }

    // rawCells: [序号, 简称, 全称(含<a>), 等级, 类型, 领域]
    if (rawCells.length >= 5) {
      const dblpPath = extractDblpPath(rawCells[2]);
      entries.push({
        abbr: stripHtml(rawCells[1]),
        full: stripHtml(rawCells[2]),
        rank: stripHtml(rawCells[3]).toUpperCase(),
        type: stripHtml(rawCells[4]),
        dblpPath,
      });
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// compareCcf — 比对代码与 CCF 官方（rank + abbr + url）
// ---------------------------------------------------------------------------

function compareCcf(
  codeEntries: Record<string, RankInfo>,
  ccfEntries: CcfEntry[],
): CompareResult {
  const result: CompareResult = {
    rankMismatch: [],
    abbrMismatch: [],
    urlMismatch: [],
    onlyInCode: [],
    onlyInCcf: [],
  };

  const normalize = (s: string) =>
    s
      .replace(/&/g, "AND")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");

  const inferType = (key: string): string =>
    key.startsWith("/conf/") ? "会议" : "期刊";

  const compositeKey = (full: string, type: string) =>
    `${normalize(full)}|${type}`;

  // CCF 官方索引：(full, type) → entry
  const ccfByFullType = new Map<string, CcfEntry>();
  for (const entry of ccfEntries) {
    ccfByFullType.set(compositeKey(entry.full, entry.type), entry);
  }

  const matchedCcfKeys = new Set<string>();

  for (const [path, info] of Object.entries(codeEntries)) {
    const codeRank = info.rank.trim();
    const codeAbbr = info.abbr;
    const codeFull = info.full;
    const codeUrl = info.url;
    const codeType = inferType(path);

    const key = compositeKey(codeFull, codeType);
    const matched = ccfByFullType.get(key);

    if (!matched) {
      result.onlyInCode.push({ key: path, abbr: codeAbbr, full: codeFull, rank: codeRank });
    } else {
      matchedCcfKeys.add(key);

      if (codeRank !== matched.rank) {
        result.rankMismatch.push({
          abbr: codeAbbr,
          type: codeType,
          codeRank,
          ccfRank: matched.rank,
        });
      }

      if (codeAbbr !== matched.abbr) {
        result.abbrMismatch.push({
          full: codeFull,
          type: codeType,
          codeAbbr,
          ccfAbbr: matched.abbr,
        });
      }

      // 比较 DBLP 路径（只在双方都有时比较）
      if (matched.dblpPath && codeUrl && codeUrl !== matched.dblpPath) {
        result.urlMismatch.push({
          abbr: codeAbbr,
          type: codeType,
          codeUrl,
          ccfUrl: matched.dblpPath,
        });
      }
    }
  }

  for (const entry of ccfEntries) {
    if (!matchedCcfKeys.has(compositeKey(entry.full, entry.type))) {
      result.onlyInCcf.push({
        abbr: entry.abbr,
        full: entry.full,
        rank: entry.rank,
        type: entry.type,
      });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const entryCount = Object.keys(ccfRankList).length;
  console.log(`\n📋 ccfRankList 共 ${entryCount} 条\n`);

  // 数据质量检查
  const whitespaceIssues: { key: string; field: string; value: string }[] = [];
  for (const [key, info] of Object.entries(ccfRankList)) {
    for (const field of ["rank", "abbr", "full"] as const) {
      if (info[field] !== info[field].trim()) {
        whitespaceIssues.push({ key, field, value: JSON.stringify(info[field]) });
      }
    }
  }
  if (whitespaceIssues.length > 0) {
    console.log(`⚠️  数据中存在前后空格问题 (${whitespaceIssues.length}):`);
    for (const w of whitespaceIssues) {
      console.log(`   ${w.key} → ${w.field}: ${w.value}`);
    }
    console.log("");
  }

  // CCF 官方数据比对
  console.log("═══ CCF 数据验证 ═══");
  console.log("正在抓取 ccf.atom.im ...");

  try {
    const ccfEntries = await fetchCcfList();
    console.log(`获取到 ${ccfEntries.length} 条 CCF 官方条目\n`);

    const diff = compareCcf(ccfRankList, ccfEntries);

    // Rank
    if (diff.rankMismatch.length > 0) {
      console.log(`⚠️  等级不一致 (${diff.rankMismatch.length}):`);
      for (const m of diff.rankMismatch) {
        console.log(`   [${m.type}] ${m.abbr}: 代码=${m.codeRank}, CCF官方=${m.ccfRank}`);
      }
    } else {
      console.log("✅ 所有等级与 CCF 官方一致");
    }

    // Abbr
    if (diff.abbrMismatch.length > 0) {
      console.log(`\n⚠️  缩写不一致 (${diff.abbrMismatch.length}):`);
      for (const m of diff.abbrMismatch) {
        console.log(`   [${m.type}] ${m.full}: 代码=${m.codeAbbr}, CCF官方=${m.ccfAbbr}`);
      }
    } else {
      console.log("✅ 所有缩写与 CCF 官方一致");
    }

    // URL
    if (diff.urlMismatch.length > 0) {
      console.log(`\n⚠️  DBLP 路径不一致 (${diff.urlMismatch.length}):`);
      for (const m of diff.urlMismatch) {
        console.log(`   [${m.type}] ${m.abbr}: 代码=${m.codeUrl}, CCF官方=${m.ccfUrl}`);
      }
    } else {
      console.log("✅ 所有 DBLP 路径与 CCF 官方一致");
    }

    // Only in code
    if (diff.onlyInCode.length > 0) {
      console.log(
        `\nℹ️  仅在代码中存在 (${diff.onlyInCode.length}):`,
      );
      for (const e of diff.onlyInCode) {
        console.log(`   ${e.key} → ${e.abbr ? e.abbr + " " : ""}${e.full} (${e.rank})`);
      }
    }

    // Only in CCF
    if (diff.onlyInCcf.length > 0) {
      console.log(
        `\n⚠️  CCF 官方有但代码中缺失 (${diff.onlyInCcf.length}):`,
      );
      for (const e of diff.onlyInCcf) {
        console.log(`   [${e.type}] ${e.abbr ? e.abbr + " - " : ""}${e.full} (${e.rank})`);
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`❌ 验证失败: ${message}`);
  }

  console.log("");
}

main();
