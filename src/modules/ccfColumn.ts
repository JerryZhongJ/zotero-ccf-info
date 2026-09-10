import { config } from "../../package.json";
import { getLocaleID, getString } from "../utils/locale";
import { CCFResult, PaperInfo } from "./getPaperInfo";
import { CrossrefNetworkError } from "./crossrefClient";

export class CCFColumn {
  private static readonly MENU_ID = "zotero-itemmenu-get-ccf-info";
  private static registeredMenuID: string | false = false;

  private static getCCFInfo(item: Zotero.Item): string {
    const rank = ztoolkit.ExtraField.getExtraField(item, "CCF-Rank") ?? "";
    const abbr = ztoolkit.ExtraField.getExtraField(item, "CCF-Abbr") ?? "";
    if (!rank) return "";
    return abbr ? `${rank} ${abbr}` : rank;
  }

  private static async saveCCFInfo(item: Zotero.Item, result: CCFResult) {
    ztoolkit.ExtraField.setExtraField(item, "CCF-Rank", result.rank);
    await ztoolkit.ExtraField.setExtraField(item, "CCF-Abbr", result.abbr);
  }

  private static readonly RANK_COLORS: Record<string, string> = {
    "CCF-A": "#e15f37",
    "CCF-B": "#f5bd42",
    "CCF-C": "#8eba3a",
    "CCF-None": "#6c757d",
  };

  /**
   * 从 Zotero 条目提取发表 venue：期刊名 / 会议论文集名 / 会议名。
   * 没有 venue 元数据（如手录条目）时返回 undefined，由 Crossref 兜底。
   */
  private static getItemVenue(item: Zotero.Item): string | undefined {
    try {
      const venue =
        item.getField("publicationTitle") ||
        item.getField("proceedingsTitle") ||
        item.getField("conferenceName");
      return venue || undefined;
    } catch {
      return undefined;
    }
  }

  /** 从 Zotero 条目提取专刊号（PACMPL 各会议专刊的映射依据） */
  private static getItemIssue(item: Zotero.Item): string | undefined {
    try {
      const issue = item.getField("issue");
      return issue || undefined;
    } catch {
      return undefined;
    }
  }

  static registerExtraColumn() {
    Zotero.ItemTreeManager.registerColumn({
      pluginID: config.addonID,
      dataKey: "ccfInfo",
      label: getString("ccf-info"),
      dataProvider: (item: Zotero.Item, _dataKey: string) => {
        try {
          if (!item || !item.itemTypeID || item.isNote() || item.isAttachment()) {
            return "";
          }

          return CCFColumn.getCCFInfo(item);
        } catch (error) {
          ztoolkit.log("Error in ccfInfo dataProvider:", error);
          return "";
        }
      },
      renderCell: (_index, data, column, _isFirstColumn, doc) => {
        const cell = doc.createElement("span");
        cell.className = `cell ${column.className}`;

        if (!data) return cell;

        // 提取 rank 部分（如 "CCF-A"）
        const rank = data.split(" ")[0];
        const color = CCFColumn.RANK_COLORS[rank];

        if (color) {
          const badge = doc.createElement("span");
          badge.textContent = rank;
          Object.assign(badge.style, {
            backgroundColor: color,
            color: "#fff",
            borderRadius: "8px",
            padding: "1px 6px",
            fontSize: "12px",
            marginRight: "4px",
          });
          cell.appendChild(badge);

          // 剩余部分（abbr）
          const rest = data.substring(rank.length).trim();
          if (rest) {
            cell.appendChild(doc.createTextNode(` ${rest}`));
          }
        } else {
          cell.textContent = data;
        }

        return cell;
      },
      zoteroPersist: ["width", "hidden", "sortDirection"],
    });
  }

  public static async handleGetCCFInfo(items: Zotero.Item[]) {
    if (!items || items.length === 0) return;
    ztoolkit.log("handleGetCCFInfo", items);
    if (items.length === 1) {
      await CCFColumn.handleSingleItem(items[0]);
    } else {
      await CCFColumn.handleMultipleItems(items);
    }
  }

  /**
   * Show a result notification after a query batch finishes.
   * Categories: network error, not found on Crossref, success.
   * (CrossrefNetworkError entries = network-level failure from the Crossref client,
   *   whose message carries the concrete last error for diagnosis)
   */
  private static showResultNotification(results: (CCFResult | CrossrefNetworkError)[]) {
    const progressWindow = new ztoolkit.ProgressWindow(getString("paper-info-update"), {
      closeOtherProgressWindows: true
    });

    const failed = results.filter((r): r is CrossrefNetworkError => r instanceof CrossrefNetworkError);
    const notFound = results.filter(r => r instanceof Object && (r as CCFResult).rank === "Not Found");
    const found = results.length - failed.length - notFound.length;

    if (failed.length === results.length) {
      progressWindow.createLine({
        text: getString("ccf-update-net-error", {
          args: { count: failed.length, message: failed[0].message }
        }),
        type: "fail"
      });
    } else if (notFound.length === results.length) {
      progressWindow.createLine({
        text: getString("ccf-update-not-found", { args: { count: notFound.length } }),
        type: "default"
      });
    } else if (failed.length > 0 || notFound.length > 0) {
      progressWindow.createLine({
        text: getString("ccf-update-partial", {
          args: { found, notFound: notFound.length, failed: failed.length }
        }),
        type: "default"
      });
    } else {
      progressWindow.createLine({
        text: getString("ccf-update-success", { args: { count: results.length } }),
        type: "success"
      });
    }

    progressWindow.show();
    progressWindow.startCloseTimer(4000);
  }

  private static async handleSingleItem(entry: Zotero.Item) {
    const progressWindow = new ztoolkit.ProgressWindow(getString("paper-info-update"), {
      closeOtherProgressWindows: true
    });
    progressWindow.createLine({
      text: getString("requesting-ccf-rank-single"),
      type: "default"
    });
    progressWindow.show();
    progressWindow.startCloseTimer(2000);

    try {
      const result = await PaperInfo.getPaperCCFRank(
        entry.getField("title"),
        CCFColumn.getItemVenue(entry),
        CCFColumn.getItemIssue(entry),
      );
      await CCFColumn.saveCCFInfo(entry, result);
      CCFColumn.showResultNotification([result]);
    } catch (err) {
      if (err instanceof CrossrefNetworkError) {
        CCFColumn.showResultNotification([err]);
      } else {
        throw err;
      }
    }
  }

  private static async handleMultipleItems(items: Zotero.Item[]) {
    const progressWindow = new ztoolkit.ProgressWindow(getString("paper-info-update"), {
      closeOtherProgressWindows: true
    });
    progressWindow.createLine({
      text: getString("requesting-ccf-rank-multiple", { args: { count: items.length } }),
      type: "default"
    });
    progressWindow.show();
    progressWindow.startCloseTimer(2000);

    const entries = items.map(item => ({
      title: item.getField("title"),
      venue: CCFColumn.getItemVenue(item),
      issue: CCFColumn.getItemIssue(item),
    }));
    const results = await PaperInfo.batchGetPaperCCFRank(entries);
    for (let i = 0; i < items.length; i++) {
      const result = results[i];
      if (result && !(result instanceof CrossrefNetworkError)) {
        await CCFColumn.saveCCFInfo(items[i], result);
      }
    }
    CCFColumn.showResultNotification(results);
  }

  static registerRightClickMenuItem() {
    const menuIcon = `chrome://${config.addonRef}/content/icons/favicon@0.5x.png`;
    CCFColumn.registeredMenuID = Zotero.MenuManager.registerMenu({
      menuID: CCFColumn.MENU_ID,
      pluginID: config.addonID,
      target: "main/library/item",
      menus: [
        {
          menuType: "menuitem",
          l10nID: getLocaleID("get-ccf-info"),
          icon: menuIcon,
          onShowing: (_event, context) => {
            context.setVisible(
              Boolean(context.items?.some((item) => item.isRegularItem())),
            );
          },
          onCommand: (_event, context) => {
            CCFColumn.handleGetCCFInfo(context.items ?? []);
          },
        },
      ],
    });
  }

  static unregisterRightClickMenuItem() {
    if (!CCFColumn.registeredMenuID) return;
    Zotero.MenuManager.unregisterMenu(CCFColumn.registeredMenuID);
    CCFColumn.registeredMenuID = false;
  }

  static registerNotifier() {
    const callback = {
      notify: async (
        event: string,
        type: string,
        ids: Array<string | number>,
        extraData: { [key: string]: any },
      ) => {
        if (!addon?.data.alive) {
          this.unregisterNotifier(notifierID);
          return;
        }
        addon.hooks.onNotify(event, type, ids, extraData);
      },
    };

    const notifierID = Zotero.Notifier.registerObserver(callback, ["item"]);

    // Unregister callback when the window closes (important to avoid a memory leak)
    window.addEventListener(
      "unload",
      (e: Event) => {
        this.unregisterNotifier(notifierID);
      },
      false,
    );
  }

  static async onItemAdded(regularItems: any) {
    // 等待 10s 以防止 Zotero 未完成条目添加
    await new Promise(resolve => setTimeout(resolve, 10000));
    await CCFColumn.handleGetCCFInfo(regularItems);
  }

  private static unregisterNotifier(notifierID: string) {
    Zotero.Notifier.unregisterObserver(notifierID);
  }
}
