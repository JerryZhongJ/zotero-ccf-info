import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Crossref client so no real network access happens
const searchMock = vi.fn();
vi.mock("../src/modules/crossrefClient", () => {
  return {
    CrossrefClient: class {
      search = searchMock;
    },
    CrossrefNetworkError: class extends Error {
      constructor(message: string) {
        super(message);
        this.name = "CrossrefNetworkError";
      }
    },
  };
});

const { PaperInfo, matchVenue } = await import("../src/modules/getPaperInfo");

beforeEach(() => {
  searchMock.mockReset();
});

describe("matchVenue", () => {
  it("matches a full conference name", () => {
    const m = matchVenue(
      "IEEE/CVF Conference on Computer Vision and Pattern Recognition",
    );
    expect(m?.abbr).toBe("CVPR");
    expect(m?.rank).toBe("A");
  });

  it("matches via parenthesized abbreviation (abbr bonus)", () => {
    const m = matchVenue("2016 IEEE Conference on Computer Vision and Pattern Recognition (CVPR)");
    expect(m?.abbr).toBe("CVPR");
  });

  it("matches a journal name", () => {
    const m = matchVenue("ACM Transactions on Computer Systems");
    expect(m?.abbr).toBe("TOCS");
    expect(m?.rank).toBe("A");
  });

  it("does not match an unrelated venue", () => {
    expect(matchVenue("Some Workshop on Nothing")).toBeNull();
  });
});

describe("getPaperCCFRank", () => {
  it("resolves from local venue without any network call", async () => {
    const r = await PaperInfo.getPaperCCFRank(
      "Attention Is All You Need",
      "Advances in Neural Information Processing Systems 38",
    );
    expect(r).toEqual({ rank: "CCF-A", abbr: "NeurIPS" });
    expect(searchMock).not.toHaveBeenCalled();
  });

  it("maps PACMPL issue to conference locally via localIssue", async () => {
    const r = await PaperInfo.getPaperCCFRank(
      "A PLDI Paper.",
      "Proceedings of the ACM on Programming Languages",
      "PLDI",
    );
    expect(r).toEqual({ rank: "CCF-A", abbr: "PLDI" });
    expect(searchMock).not.toHaveBeenCalled();
  });

  it("local venue mismatch falls through to Crossref, not CCF-None", async () => {
    searchMock.mockResolvedValue([
      { title: "Some Paper.", venue: "2016 IEEE Conference on Computer Vision and Pattern Recognition (CVPR)" },
    ]);
    // 本地 venue 是个不相关名字，但 Crossref 命中了 CVPR → 应为 CCF-A
    expect(
      await PaperInfo.getPaperCCFRank("Some Paper", "Workshop on Unknown Topics (WUT)"),
    ).toEqual({ rank: "CCF-A", abbr: "CVPR" });
    expect(searchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to CCF-None with local abbr when Crossref finds nothing", async () => {
    searchMock.mockResolvedValue([]);
    const r = await PaperInfo.getPaperCCFRank("Some Paper", "Workshop on Unknown Topics (WUT)");
    expect(r).toEqual({ rank: "CCF-None", abbr: "WUT" });
  });

  it("falls back to Crossref when local venue is absent", async () => {
    searchMock.mockResolvedValue([
      { title: "Deep Residual Learning for Image Recognition", venue: "2016 IEEE Conference on Computer Vision and Pattern Recognition (CVPR)" },
    ]);
    expect(
      await PaperInfo.getPaperCCFRank("Deep Residual Learning for Image Recognition"),
    ).toEqual({ rank: "CCF-A", abbr: "CVPR" });
    expect(searchMock).toHaveBeenCalledTimes(1);
  });

  it("resolves CCF rank from a Crossref conference hit", async () => {
    searchMock.mockResolvedValue([
      {
        title: "Deep Residual Learning for Image Recognition",
        venue: "2016 IEEE Conference on Computer Vision and Pattern Recognition (CVPR)",
      },
    ]);

    expect(await PaperInfo.getPaperCCFRank("Deep Residual Learning for Image Recognition")).toEqual({
      rank: "CCF-A",
      abbr: "CVPR",
    });
  });

  it("resolves PACMPL PLDI issue to the PLDI conference (CCF-A)", async () => {
    searchMock.mockResolvedValue([
      {
        title: "Partial Evaluation, Whole-Program Compilation",
        venue: "Proceedings of the ACM on Programming Languages",
        issue: "PLDI",
      },
    ]);
    expect(
      await PaperInfo.getPaperCCFRank("Partial Evaluation, Whole-Program Compilation"),
    ).toEqual({ rank: "CCF-A", abbr: "PLDI" });
  });

  it("resolves PACMPL OOPSLA and ICFP issues", async () => {
    searchMock.mockResolvedValueOnce([
      { title: "An OOPSLA Paper.", venue: "Proceedings of the ACM on Programming Languages", issue: "OOPSLA1" },
    ]);
    expect(await PaperInfo.getPaperCCFRank("An OOPSLA Paper")).toEqual({
      rank: "CCF-A",
      abbr: "OOPSLA",
    });

    searchMock.mockResolvedValueOnce([
      { title: "An ICFP Paper.", venue: "Proceedings of the ACM on Programming Languages", issue: "ICFP" },
    ]);
    expect(await PaperInfo.getPaperCCFRank("An ICFP Paper")).toEqual({
      rank: "CCF-B",
      abbr: "ICFP",
    });
  });

  it("falls back to PACMPL's own C class for other issues", async () => {
    searchMock.mockResolvedValue([
      { title: "A Workshop Paper.", venue: "Proceedings of the ACM on Programming Languages", issue: "DLS" },
    ]);
    expect(await PaperInfo.getPaperCCFRank("A Workshop Paper")).toEqual({
      rank: "CCF-C",
      abbr: "PACM PL",
    });
  });

  it("falls back to CCF-None with the venue abbr when not in the rank list", async () => {
    searchMock.mockResolvedValue([
      { title: "Some Paper.", venue: "Workshop on Unknown Topics (WUT)" },
    ]);
    expect(await PaperInfo.getPaperCCFRank("Some Paper")).toEqual({
      rank: "CCF-None",
      abbr: "WUT",
    });
  });

  it("returns Not Found when Crossref returns no matching hits", async () => {
    searchMock.mockResolvedValue([]);
    expect(await PaperInfo.getPaperCCFRank("No Such Paper")).toEqual({
      rank: "Not Found",
      abbr: "",
    });
  });

  it("returns Not Found for a title that cleans to empty", async () => {
    const result = await PaperInfo.getPaperCCFRank("!!! ???");
    expect(result).toEqual({ rank: "Not Found", abbr: "" });
    expect(searchMock).not.toHaveBeenCalled();
  });

  it("throws CrossrefNetworkError on network-level failure", async () => {
    const { CrossrefNetworkError } = await import("../src/modules/crossrefClient");
    searchMock.mockRejectedValue(
      new CrossrefNetworkError("Crossref request failed (HTTP 407 (proxy auth required))"),
    );
    await expect(PaperInfo.getPaperCCFRank("Some Paper")).rejects.toThrow(/HTTP 407/);
  });

  it("only counts exact normalized title matches", async () => {
    searchMock.mockResolvedValue([
      { title: "A Similar But Different Paper.", venue: "2016 IEEE Conference on Computer Vision and Pattern Recognition (CVPR)" },
    ]);
    expect(await PaperInfo.getPaperCCFRank("A Similar Paper")).toEqual({
      rank: "Not Found",
      abbr: "",
    });
  });
});

describe("batchGetPaperCCFRank", () => {
  it("maps results back in order, keeping errors for network failures", async () => {
    const { CrossrefNetworkError } = await import("../src/modules/crossrefClient");
    searchMock.mockImplementation(async (title: string) => {
      if (title === "Net Fail")
        throw new CrossrefNetworkError("Crossref request failed (timeout)");
      if (title === "Paper Two")
        return [
          {
            title: "Paper Two.",
            venue: "2016 IEEE Conference on Computer Vision and Pattern Recognition (CVPR)",
          },
        ];
      return [];
    });

    const results = await PaperInfo.batchGetPaperCCFRank([
      { title: "Paper One", venue: "Advances in Neural Information Processing Systems 38" },
      { title: "Net Fail" },
      { title: "Paper Two" },
    ]);

    expect(results[0]).toEqual({ rank: "CCF-A", abbr: "NeurIPS" }); // 本地 venue，零请求
    expect(results[1]).toBeInstanceOf(CrossrefNetworkError);
    expect(results[2]).toEqual({ rank: "CCF-A", abbr: "CVPR" });
  });
});
