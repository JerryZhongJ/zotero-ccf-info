import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the DBLP client so no real network access happens
const searchMock = vi.fn();
vi.mock("../src/modules/dblpClient", () => {
  return {
    DblpClient: class {
      search = searchMock;
    },
  };
});

const { PaperInfo } = await import("../src/modules/getPaperInfo");

beforeEach(() => {
  searchMock.mockReset();
});

describe("getPaperCCFRank", () => {
  it("resolves CCF rank from a DBLP journal hit (PACMPL PLDI issue → PLDI, CCF-A)", async () => {
    searchMock.mockResolvedValue([
      { key: "journals/pacmpl/FallinB25", title: "Partial Evaluation, Whole-Program Compilation.", number: "PLDI" },
      { key: "journals/corr/abs-2411-10559", title: "Partial Evaluation, Whole-Program Compilation." },
    ]);

    const result = await PaperInfo.getPaperCCFRank(
      "Partial evaluation, whole-program compilation",
    );

    // The paper was published in PACMPL's PLDI issue → count as PLDI (CCF-A)
    expect(result).toEqual({ rank: "CCF-A", abbr: "PLDI" });
  });

  it("resolves PACMPL OOPSLA and POPL issues to CCF-A, ICFP to CCF-B", async () => {
    searchMock.mockResolvedValueOnce([
      { key: "journals/pacmpl/X25", title: "An OOPSLA Paper.", number: "OOPSLA1" },
    ]);
    expect(await PaperInfo.getPaperCCFRank("An OOPSLA Paper")).toEqual({
      rank: "CCF-A",
      abbr: "OOPSLA",
    });

    searchMock.mockResolvedValueOnce([
      { key: "journals/pacmpl/Y25", title: "A POPL Paper.", number: "POPL" },
    ]);
    expect(await PaperInfo.getPaperCCFRank("A POPL Paper")).toEqual({
      rank: "CCF-A",
      abbr: "POPL",
    });

    searchMock.mockResolvedValueOnce([
      { key: "journals/pacmpl/Z25", title: "An ICFP Paper.", number: "ICFP" },
    ]);
    expect(await PaperInfo.getPaperCCFRank("An ICFP Paper")).toEqual({
      rank: "CCF-B",
      abbr: "ICFP",
    });
  });

  it("falls back to PACMPL's own C class for other issues", async () => {
    searchMock.mockResolvedValue([
      { key: "journals/pacmpl/W25", title: "A Workshop Paper.", number: "DLS" },
    ]);
    expect(await PaperInfo.getPaperCCFRank("A Workshop Paper")).toEqual({
      rank: "CCF-C",
      abbr: "PACM PL",
    });
  });

  it("resolves conference papers directly", async () => {
    searchMock.mockResolvedValue([
      { key: "conf/pldi/AuthorA25", title: "A Conference Paper." },
    ]);
    expect(await PaperInfo.getPaperCCFRank("A Conference Paper!")).toEqual({
      rank: "CCF-A",
      abbr: "PLDI",
    });
  });

  it("falls back to CCF-None with the venue abbr when not in the rank list", async () => {
    searchMock.mockResolvedValue([
      { key: "journals/unknown/JaneD25", title: "Some Paper." },
    ]);
    expect(await PaperInfo.getPaperCCFRank("Some Paper")).toEqual({
      rank: "CCF-None",
      abbr: "UNKNOWN",
    });
  });

  it("reports CORR abbr when only an arXiv hit matches", async () => {
    searchMock.mockResolvedValue([
      { key: "journals/corr/abs-2411-10559", title: "Some Paper." },
    ]);
    expect(await PaperInfo.getPaperCCFRank("Some Paper")).toEqual({
      rank: "CCF-None",
      abbr: "CORR",
    });
  });

  it("returns Not Found when DBLP returns no matching hits", async () => {
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

  it("returns null on network-level failure (all hosts down)", async () => {
    searchMock.mockResolvedValue(null);
    expect(await PaperInfo.getPaperCCFRank("Some Paper")).toBeNull();
  });

  it("only counts exact normalized title matches", async () => {
    searchMock.mockResolvedValue([
      { key: "conf/pldi/Similar25", title: "A Similar But Different Paper." },
    ]);
    expect(await PaperInfo.getPaperCCFRank("A Similar Paper")).toEqual({
      rank: "Not Found",
      abbr: "",
    });
  });
});

describe("batchGetPaperCCFRank", () => {
  it("maps results back in order, keeping nulls for network failures", async () => {
    searchMock.mockImplementation(async (title: string) => {
      if (title === "Net Fail") return null;
      if (title === "Paper One")
        return [{ key: "conf/pldi/AuthorA25", title: "Paper One." }];
      return [];
    });

    const results = await PaperInfo.batchGetPaperCCFRank([
      "Paper One",
      "Net Fail",
      "Paper Two",
    ]);

    expect(results).toEqual([
      { rank: "CCF-A", abbr: "PLDI" },
      null,
      { rank: "Not Found", abbr: "" },
    ]);
  });
});
