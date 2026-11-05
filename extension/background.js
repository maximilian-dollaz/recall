// Recall for Chrome: one item in the right-click menu. Choosing it opens a small window that listens
// (what it is, what it's for, why you love it), then saves what was right-clicked to the person's Recall.
// In Google Docs and Drive it saves the Doc, or every file selected in Drive, with what's inside them.
importScripts("capture.js");

const MENU = "add-to-recall";
chrome.runtime.onInstalled.addListener(async (d) => {
  chrome.contextMenus.create({ id: MENU, title: "Add to Recall", contexts: ["image", "link", "page", "selection", "video"] });
  // On first install, ask for the microphone once (the pop-up itself can't ask).
  if (d.reason === "install" && !(await chrome.storage.local.get("micAllowed")).micAllowed) chrome.tabs.create({ url: "permission.html" });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU) return;
  const item = { image: info.srcUrl || "", link: info.linkUrl || "", page: info.pageUrl || tab?.url || "", text: info.selectionText || "", title: tab?.title || "",
    tabId: tab?.id, frameId: info.frameId || 0, at: Date.now() };
  // A picture under a link (Pinterest, Are.na, Cosmos) is right-clicked as the link: find the picture inside it.
  if (!item.image && item.link && tab?.id && !googleFromUrl(item.link)) {
    try {
      const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, args: [item.link], func: (href) => {
        const path = (() => { try { return new URL(href).pathname; } catch { return href; } })();
        const a = [...document.querySelectorAll("a[href]")].find((x) => x.href === href || (path.length > 1 && x.getAttribute("href")?.includes(path)));
        const img = a?.querySelector("img"); if (!img) return "";
        // The largest version the page offers.
        const set = (img.getAttribute("srcset") || "").split(",").map((s) => s.trim().split(/\s+/)).filter((p) => p[0]);
        const best = set.sort((x, y) => (parseFloat(y[1]) || 0) - (parseFloat(x[1]) || 0))[0]?.[0];
        return best || img.currentSrc || img.src || "";
      } });
      item.image = res?.result || "";
    } catch {}
  }
  // Google: a link to a Doc or Drive file, the files selected in Drive, or the Doc that's open.
  if (!item.image) {
    const linked = item.link && googleFromUrl(item.link);
    if (linked) item.google = [linked];
    else if (/^https:\/\/drive\.google\.com\//.test(item.page) && tab?.id) {
      const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readDriveSelection }).catch(() => []);
      const picked = driveItemsFrom(res?.result, item.page); if (picked.length) item.google = picked;
    }
    const open = !item.google && !item.link && googleFromUrl(item.page);
    if (open) item.google = [{ ...open, name: cleanTitle(item.title) }];
  }
  await chrome.storage.session.set({ pending: item });
  // The little pop-up under the Recall button in the toolbar. If Chrome won't open it here, a small window instead.
  try { await chrome.action.openPopup(); return; } catch {}
  // A small window over the top right of the current one, never full screen.
  const w = 440, h = 400;
  const cur = await chrome.windows.getCurrent().catch(() => null);
  const left = cur && cur.state === "normal" ? Math.max(0, (cur.left ?? 0) + (cur.width ?? w) - w - 24) : undefined;
  const top = cur && cur.state === "normal" ? (cur.top ?? 0) + 80 : 80;
  chrome.windows.create({ url: "recorder.html", type: "popup", state: "normal", width: w, height: h, left, top, focused: true });
});

// The pop-up asks for what's inside Google files; this worker reads them with the person's Google sign-in.
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type !== "google-files" || !msg.entry) return;
  fetchGoogleFiles(msg.entry).then(reply, () => reply({ kind: msg.entry.kind, files: [] }));
  return true; // answers later
});

// Chrome's "Allow" question can close the pop-up. When it does, open it again for the same files.
let popups = 0;
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "popup") return;
  popups++; port.onDisconnect.addListener(() => popups--);
});
chrome.permissions.onAdded.addListener(async () => {
  if (popups > 0) return;
  const { pending } = await chrome.storage.session.get("pending");
  if (pending?.google?.length && Date.now() - (pending.at || 0) < 5 * 60_000) chrome.action.openPopup().catch(() => {});
});
