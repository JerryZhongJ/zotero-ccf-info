import { describe, expect, it } from "vitest";
import { ccfRankList, type RankInfo } from "../src/modules/ccfRankList";

const RANKS = ["A", "B", "C"] as const;

describe("ccfRankList data integrity", () => {
  const entries = Object.entries(ccfRankList);

  it("is non-empty", () => {
    expect(entries.length).toBeGreaterThan(500);
  });

  it("has DBLP-path-shaped keys", () => {
    for (const [key] of entries) {
      expect(key).toMatch(/^\/(conf|journals)\/[a-zA-Z0-9.+-]+$/);
    }
  });

  it("every entry has valid rank / non-empty fields / consistent dblp path", () => {
    for (const [key, info] of entries as [string, RankInfo][]) {
      expect(RANKS, `${key}: invalid rank`).toContain(info.rank);
      // Some journals have no common abbreviation; abbr may be empty then,
      // but the full name must identify the venue.
      expect(info.full.trim(), `${key}: empty full name`).not.toBe("");
      // A few CCF venues (jgitm/jats/ietits/ncmmsc) are not indexed by DBLP
      // at all — their url/dblp stay empty until DBLP covers them.
      if (!info.url && !info.dblp) continue;
      expect(info.url, `${key}: url should be the DBLP path`).toBe(key);
      // dblp is a URL path to a DBLP volume page ("/<tree>/<venue>/<volume>");
      // it may cross venue trees when a journal was renamed (e.g. jlap/jlp).
      expect(
        info.dblp,
        `${key}: dblp should be a volume path`,
      ).toMatch(/^\/(conf|journals)\/[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$/);
    }
  });
});
