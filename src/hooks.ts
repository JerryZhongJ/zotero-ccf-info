import { CCFColumn } from "./modules/ccfColumn";
import { config } from "../package.json";
import { getString, initLocale } from "./utils/locale";
import { createZToolkit } from "./utils/ztoolkit";

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();

  await onMainWindowLoad(window);

  // Register all UI components and listeners
  CCFColumn.registerRightClickMenuItem();
  CCFColumn.registerExtraColumn();
  CCFColumn.registerNotifier();
}

async function onMainWindowLoad(win: Window): Promise<void> {
  // Create ztoolkit for every window
  addon.data.ztoolkit = createZToolkit();
  // Load the plugin's Fluent file into the main window document so that
  // DOM-based l10n (e.g. the `data-l10n-id` set on the right-click menu
  // item by Zotero.MenuManager) can resolve messages from addon.ftl.
  // @ts-ignore - MozXULElement is a Mozilla global available on the window
  win.MozXULElement.insertFTLIfNeeded(`${config.addonRef}-addon.ftl`);
}

async function onMainWindowUnload(win: Window): Promise<void> {
  CCFColumn.unregisterRightClickMenuItem();
  ztoolkit.unregisterAll();
  addon.data.dialog?.window?.close();
}

async function onNotify(
  event: string,
  type: string,
  ids: Array<string | number>,
  extraData: { [key: string]: any },
) {
  ztoolkit.log("notify", event, type, ids, extraData);

  if (event == "add" && type == "item") {
    // Get items and filter out attachments and other non-regular items
    const items = Zotero.Items.get(ids as number[]);
    const regularItems = items.filter(
      (item) =>
        item.isRegularItem() &&
        !item.isAttachment() &&
        // @ts-ignore item has no isFeedItem
        !item.isFeedItem &&
        // @ts-ignore libraryID is got from item, so get() will never return false
        Zotero.Libraries.get(item.libraryID)._libraryType == "user",
    );

    if (regularItems.length !== 0) {
      CCFColumn.onItemAdded(regularItems);
      return;
    }
  }
}

function onShutdown(): void {
  CCFColumn.unregisterRightClickMenuItem();
  ztoolkit.unregisterAll();
  addon.data.dialog?.window?.close();
  // Remove addon object
  addon.data.alive = false;
  // @ts-ignore
  delete Zotero[config.addonInstance];
}

// Add your hooks here. For element click, etc.
// Keep in mind hooks only do dispatch. Don't add code that does real jobs in hooks.
// Otherwise the code would be hard to read and maintain.

export default {
  onStartup,
  onShutdown,
  onNotify,
  onMainWindowLoad,
  onMainWindowUnload,
};
