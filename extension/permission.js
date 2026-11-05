// One-time: a toolbar pop-up can't ask for the microphone, so this tab asks once for the whole extension.
// Once allowed, it reopens the pop-up for whatever was right-clicked, and closes.
(async () => {
  const msg = document.getElementById("msg");
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
    await chrome.storage.local.set({ micAllowed: true });
    msg.textContent = "Done."; msg.className = "ok";
    setTimeout(async () => { try { await chrome.action.openPopup(); } catch {} window.close(); }, 600);
  } catch {
    msg.textContent = "Chrome is blocking the microphone. Click the icon at the right end of the address bar, choose Allow, then reload this page.";
  }
})();
