// The Add to Recall pop-up: listen at once, show the words as they're spoken, and save the moment
// the person stops. Or type, then Save to Recall. Uses the person's Recall sign-in in this Chrome.
// Several files selected in Google Drive are saved one by one with the same words, as one batch.
//
// Voice, for Max's test: Chrome's own speech recognition (instant words; the audio goes to Google).
// If it isn't available, it falls back to transcription on Max's Mac (private, slower).
const RECALL = "https://recall.nextmissionsi.com";
const $ = (s) => document.querySelector(s);
const status = (t, cls = "") => { $("#status").textContent = t; $("#status").className = cls; };
let item = {}, words = "", typing = false, done = false, stream = null;
let speech = null, finalText = "", ended = null;      // Chrome speech
let rec = null, chunks = [], timer = null, busy = false; // fallback: the Mac transcribes
let entries = [], gathered = Promise.resolve([]), sent = new Set(), batch = "", googleOk = false;
chrome.runtime.connect({ name: "popup" }); // the background knows this pop-up is open while this lasts

async function post(fields, files) {
  const fd = new FormData();
  for (const [k, v] of fields) fd.append(k, v);
  for (const f of files) fd.append("files", f.blob, f.name);
  const r = await fetch(`${RECALL}/api/save`, { method: "POST", body: fd, credentials: "include" });
  if (r.status === 401) throw new Error("signin");
  const d = await r.json().catch(() => ({})); if (!r.ok || !d.ok) throw new Error(d.error || "not saved");
}

async function save(notes) {
  const files = await gathered; // pictures and Google files, read while the person was speaking
  for (const [i, e] of entries.entries()) {
    if (sent.has(i)) continue; // a retry doesn't save twice what already went
    if (entries.length > 1) status(`${i + 1} of ${entries.length}…`);
    const mine = files[i] || [];
    await post(fieldsFor(e, notesFor(item, notes), batch, mine.some((f) => f.type.startsWith("image/"))), mine);
    sent.add(i);
  }
}

// Keep what wasn't saved yet, so the pop-up comes back to it (after a sign-in, the microphone or Google question).
function keep() {
  const rest = item.google ? { ...item, google: item.google.filter((_, i) => !sent.has(i)) } : item;
  return chrome.storage.session.set({ pending: { ...rest, at: Date.now() } }).catch(() => {});
}

async function transcribe(final) {
  if (busy || !chunks.length) return; busy = true;
  try {
    const fd = new FormData(); fd.append("audio", new Blob(chunks, { type: rec.mimeType || "audio/webm" }), "note.webm");
    const r = await fetch(`${RECALL}/api/transcribe`, { method: "POST", body: fd, credentials: "include" });
    if (r.status === 401) throw new Error("signin");
    const d = await r.json(); if (!r.ok) throw new Error(d.error || "transcription failed");
    words = (d.text || "").trim(); $("#said").textContent = words;
  } catch (e) { if (final) throw e; }
  finally { busy = false; }
}

async function stopListening() {
  if (speech) { const wait = ended; try { speech.stop(); } catch {} await wait; words = (finalText || $("#said").textContent).trim(); }
  else if (rec) {
    clearInterval(timer);
    await new Promise((res) => { if (rec.state !== "recording") return res(); rec.onstop = res; rec.stop(); });
    while (busy) await new Promise((r) => setTimeout(r, 100));
    await transcribe(true);
  }
  stream?.getTracks().forEach((t) => t.stop());
}

async function finish() {
  if (done) return; done = true; $("#stop").disabled = true; $("#savebtn").disabled = true;
  try {
    if (typing) words = $("#typed").value.trim(); else { status("…"); await stopListening(); }
    await save(words);
    await chrome.storage.session.remove("pending");
    status("Saved to Recall.", "ok"); setTimeout(() => window.close(), 900);
  } catch (e) {
    done = false; $("#stop").disabled = false; $("#savebtn").disabled = false;
    await keep();
    const part = sent.size ? `Saved ${sent.size} of ${entries.length}. ` : "";
    if (String(e.message) === "signin") { status(`${part}Sign in to Recall in this Chrome first, then try again.`, "err"); chrome.tabs.create({ url: RECALL }); }
    else status(`${part}Not saved: ${e.message}`, "err");
  }
}

function glow(s) {
  try {
    const ctx = new AudioContext(), an = ctx.createAnalyser(); ctx.createMediaStreamSource(s).connect(an); an.fftSize = 512;
    const buf = new Uint8Array(an.frequencyBinCount); let sm = 0;
    const tick = () => { if (done || typing) return; an.getByteTimeDomainData(buf); let x = 0; for (const v of buf) { const d = (v - 128) / 128; x += d * d; } sm = sm * .8 + Math.min(1, Math.sqrt(x / buf.length) * 6) * .2; $("#said").style.setProperty("--vol", sm.toFixed(3)); requestAnimationFrame(tick); };
    tick();
  } catch {}
}

function chromeSpeech() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition; if (!SR) return false;
  speech = new SR(); speech.continuous = true; speech.interimResults = true; speech.lang = navigator.language || "en-US";
  let resolveEnd; ended = new Promise((r) => (resolveEnd = r));
  speech.onresult = (e) => {
    let interim = ""; finalText = "";
    for (const r of e.results) { if (r.isFinal) finalText += r[0].transcript; else interim += r[0].transcript; }
    $("#said").textContent = (finalText + interim).trim(); $("#said").scrollTop = $("#said").scrollHeight;
  };
  speech.onerror = (e) => { if (["not-allowed", "service-not-allowed", "network", "audio-capture"].includes(e.error) && !done && !typing) { speech = null; macTranscription(); } };
  speech.onend = () => { resolveEnd(); if (speech && !done && !typing) { try { speech.start(); ended = new Promise((r) => (resolveEnd = r)); } catch {} } }; // keep listening through pauses
  speech.start();
  return true;
}

function macTranscription() {
  rec = new MediaRecorder(stream); chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  rec.start(1000); timer = setInterval(() => transcribe(false), 3000);
}

async function listen() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    glow(stream);
    if (!chromeSpeech()) macTranscription();
  } catch (e) {
    // First time: the pop-up can't ask, so a tab asks once, then brings the pop-up back for the same item.
    if (e?.name === "NotAllowedError" || e?.name === "SecurityError") { await keep(); chrome.tabs.create({ url: "permission.html" }); window.close(); return; }
    switchToTyping(); status("The microphone isn't available. Type it instead.", "err");
  }
}

function switchToTyping() {
  if (typing) return; typing = true;
  try { speech?.abort(); } catch {} speech = null;
  clearInterval(timer); try { rec?.state === "recording" && rec.stop(); } catch {} stream?.getTracks().forEach((t) => t.stop());
  $("#typed").value = $("#said").textContent.trim();
  $("#said").hidden = true; $("#stop").hidden = true; $("#type").hidden = true;
  $("#typed").hidden = false; $("#savebtn").hidden = false; $("#typed").focus();
  // The box grows with the words, up to 340 px, then scrolls.
  const fit = () => { const t = $("#typed"); t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight + 2, 340) + "px"; };
  $("#typed").addEventListener("input", fit); fit();
}

// What the right-click left for this pop-up. Taken once, so a later click on the toolbar button starts fresh.
async function takePending() {
  const { pending } = await chrome.storage.session.get("pending").catch(() => ({}));
  await chrome.storage.session.remove("pending").catch(() => {});
  return pending?.page && Date.now() - (pending.at || 0) < 5 * 60_000 ? pending : null;
}

// Opened from the toolbar icon (nothing right-clicked): the page you're on. In Drive, the files selected
// in it; in a Doc, Sheet or Slides, that file.
async function fromTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
  const it = { page: tab?.url || "", title: tab?.title || "", tabId: tab?.id, at: Date.now() };
  if (/^https:\/\/drive\.google\.com\//.test(it.page) && tab?.id) {
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readDriveSelection }).catch(() => []);
    const picked = driveItemsFrom(res?.result, it.page); if (picked.length) it.google = picked;
  }
  const open = !it.google && googleFromUrl(it.page);
  if (open) it.google = [{ ...open, name: cleanTitle(it.title) }];
  return it;
}

// The picture at the top. Pinterest: the full-size original, or the 736x copy when there's no original.
function showPicture(e) {
  const t = $("#thumb"); if (!e?.image) return Promise.resolve();
  return new Promise((res) => {
    const stop = setTimeout(res, 5000);
    t.onload = () => { clearTimeout(stop); t.hidden = false; res(); };
    t.onerror = () => {
      const back = pinterestFallback(e.image);
      if (back !== e.image) { e.image = back; t.src = back; return; }
      clearTimeout(stop); t.hidden = true; res();
    };
    t.src = e.image;
  });
}

// Several files: a small picture of each (their first letter when Drive's picture won't show here).
function showMany() {
  const box = $("#many"), letter = (x) => Object.assign(document.createElement("span"), { textContent: (x.title || "?").slice(0, 1).toUpperCase() });
  for (const x of entries.slice(0, 11)) {
    if (!x.image) { box.append(letter(x)); continue; }
    const i = Object.assign(document.createElement("img"), { alt: "" }); i.onerror = () => i.replaceWith(letter(x)); i.src = x.image; box.append(i);
  }
  if (entries.length > 11) box.append(Object.assign(document.createElement("span"), { textContent: `+${entries.length - 11}` }));
  box.hidden = false;
}

// The picture's bytes as the page has them: blob: and data: pictures, and sites that turn the server away.
async function pagePicture() {
  if (!item.image || !item.tabId || isPinterest(item.image)) return [];
  const [res] = await chrome.scripting.executeScript({ target: { tabId: item.tabId, frameIds: [item.frameId || 0] }, args: [item.image], func: pictureBytes }).catch(() => []);
  const blob = res?.result ? dataUrlToBlob(res.result) : null;
  return blob ? [{ name: `picture.${extFor(blob.type)}`, type: blob.type, blob }] : [];
}

// What's inside a Google file, read by the background worker with the person's Google sign-in.
async function googleFiles(e) {
  const res = await chrome.runtime.sendMessage({ type: "google-files", entry: e.google }).catch(() => null);
  if (res?.kind && res.kind !== e.google.kind) e.url = driveItemUrl({ ...e.google, kind: res.kind }); // Drive said it's a Doc
  return (res?.files || []).map((f) => ({ name: f.name, type: f.type, blob: new Blob([f.text != null ? f.text : base64ToBytes(f.b64)], { type: f.type }) }));
}

// Starts reading everything that goes with the save while the person speaks; the save waits for it.
function gather() {
  const picture = entries.length === 1 ? showPicture(entries[0]) : Promise.resolve();
  const files = Promise.all(entries.map((e) => Promise.resolve(e.google ? (googleOk ? googleFiles(e) : []) : pagePicture()).catch(() => [])));
  gathered = Promise.all([files, picture]).then(([f]) => {
    // The pop-up can't show another page's blob: picture by its address; it can show the bytes.
    const pic = entries.length === 1 && (f[0] || []).find((x) => x.type.startsWith("image/"));
    if (pic && $("#thumb").hidden) try { const t = $("#thumb"); t.onload = t.onerror = null; t.src = URL.createObjectURL(pic.blob); t.hidden = false; } catch {}
    return f;
  });
}

(async () => {
  item = (await takePending()) || (await fromTab());
  entries = entriesFor(item);
  batch = entries.length > 1 ? `chrome-${Date.now()}` : "";
  googleOk = entries.some((e) => e.google) && await chrome.permissions.contains({ origins: GOOGLE_ORIGINS }).catch(() => false);
  if (entries.length > 1) { showMany(); $("#what").textContent = `${entries.length} files: ${entries.map((x) => x.title).filter(Boolean).join(", ")}`; }
  else $("#what").textContent = item.text ? `"${item.text.slice(0, 140)}"` : (entries[0].title || item.title || item.link || item.page || "");
  $("#allow").hidden = googleOk || !entries.some((e) => e.google);
  gather();
  // Google files: allowed once, from this click. Without it, the link and the name are still saved.
  $("#allowbtn").onclick = () => {
    keep(); // if Chrome's question closes this pop-up, the background opens it again for the same files
    chrome.permissions.request({ origins: GOOGLE_ORIGINS }).then((ok) => {
      chrome.storage.session.remove("pending").catch(() => {});
      if (ok) { googleOk = true; $("#allow").hidden = true; gather(); }
    }).catch(() => {});
  };
  $("#stop").onclick = finish; $("#savebtn").onclick = finish;
  $("#type").onclick = switchToTyping;
  document.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); finish(); } if (e.key === "Escape") window.close(); });
  listen();
})();
