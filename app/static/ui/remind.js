// Remind tab: the list of your reminders and the Turn on button. Used by the Remind tab in Recall (index.html).
// A single reminder (what a notification opens) is /remind/<id> (remind.html). See app/remind.ts for how it works.
(() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const day = (iso) => new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const post = (u, body) => fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  // Each step of turning Remind on is written to the server log, so a phone that fails can be read from there.
  const report = (step, extra = {}) => post('/api/remind/log', { step, ...extra }).catch(() => {});
  // The service worker shows the notifications. Never wait on it forever: a browser without one still shows the list.
  let swReady;
  const sw = () => swReady ??= ('serviceWorker' in navigator
    ? navigator.serviceWorker.register('/sw.js').then(() => Promise.race([navigator.serviceWorker.ready, new Promise((_, no) => setTimeout(() => no(new Error('no service worker')), 4000))]))
    : Promise.reject(new Error('no service worker')));

  // The deck: one reminder at a time. "Yes, lived it" puts it in the evidence jar, "Still landing" puts it away
  // until tomorrow; either way the next one comes up, until all are processed.
  const when = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  function tile(s, i, n) {
    return `<article class="rm-tile">
      <div class="rm-count">${i} of ${n}</div>
      <h3 class="rm-title">${esc(s.title)}</h3>
      <blockquote class="rm-words">\u201c${esc(s.words)}\u201d</blockquote>
      <div class="rm-from">You, ${day(s.from.date)}${s.from.slug ? ` · <a href="/?item=${encodeURIComponent(s.from.slug)}">${esc(s.from.title)}</a>` : ''}</div>
      ${s.when_then ? `<div class="rm-then">${esc(s.when_then)}</div>` : ''}
      <div class="rm-btns"><button class="primary" type="button" data-a="lived">Yes, lived it</button><button class="rm-second" type="button" data-a="landing">Still landing</button><button class="rm-quiet" type="button" data-a="let-go">Let go</button></div>
    </article>`;
  }

  async function load(root) {
    const st = await (await fetch('/api/remind/status')).json();
    const now = Date.now();
    const queue = st.sparks.filter((s) => s.state === 'on' && !(s.hold && Date.parse(s.hold) > now)).sort((a, b) => a.next.localeCompare(b.next));
    const total = queue.length;
    root.innerHTML = `
      <div class="rm-on" hidden><p class="rm-text">Your words come back to this phone, up to three times a day, until you live them.</p><button class="primary rm-enable" type="button">Turn on Remind</button></div>
      <p class="rm-home small muted" hidden>Open Recall from your home screen, then come back here to turn on Remind.</p>
      <div class="rm-deck"></div>
      <div class="rm-jar"></div>
      <button class="rm-send" type="button" hidden>Send one now</button>`;
    const q = (s) => root.querySelector(s);
    const deck = q('.rm-deck');
    const jar = () => {
      const ev = st.sparks.filter((s) => s.state === 'evidence').sort((a, b) => (b.evidence || '').localeCompare(a.evidence || ''));
      const gone = st.sparks.filter((s) => s.state === 'let-go');
      q('.rm-jar').innerHTML = (ev.length ? `<h3 class="rm-h">Evidence · ${ev.length}</h3><div class="rm-list">${ev.map((s) => `<a class="rm-item" href="/remind/${s.id}"><b>${esc(s.title)}</b><small>lived ${s.evidence ? when(s.evidence) : ''}</small></a>`).join('')}</div>` : '')
        + (gone.length ? `<h3 class="rm-h">Let go · ${gone.length}</h3><div class="rm-list">${gone.map((s) => `<a class="rm-item" href="/remind/${s.id}"><b>${esc(s.title)}</b></a>`).join('')}</div>` : '');
    };
    const next = () => {
      if (!queue.length) { deck.innerHTML = `<p class="rm-done">${total ? 'All processed. The ones still landing come back tomorrow.' : st.sparks.length ? 'Nothing waiting. The ones still landing come back tomorrow.' : 'Nothing yet. Say \u201cremind me\u201d in a voice note or a Granola note and it lands here.'}</p>`; return; }
      deck.innerHTML = tile(queue[0], total - queue.length + 1, total);
      deck.querySelector('.rm-tile').classList.add('rm-in');
    };
    deck.onclick = async (e) => {
      const btn = e.target.closest('button[data-a]'); if (!btn || btn.disabled) return;
      const s = queue[0]; if (!s) return;
      deck.querySelectorAll('button').forEach((b) => b.disabled = true);
      const r = await post('/api/remind/answer', { id: s.id, answer: btn.dataset.a });
      if (!r.ok) { deck.querySelectorAll('button').forEach((b) => b.disabled = false); return; }
      Object.assign(st.sparks.find((x) => x.id === s.id), await r.json());
      queue.shift(); jar(); next();
    };
    next(); jar();
    q('.rm-send').hidden = !st.on;
    q('.rm-send').onclick = async () => { const r = await (await post('/api/remind/now')).json(); q('.rm-send').textContent = r.sent ? 'Sent' : 'Nothing to send'; };

    // After the list shows: is this phone signed up?
    const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    const isIOS = /iPhone|iPad/.test(navigator.userAgent);
    let state = 'none', reg = null, local = null;
    try { reg = await sw(); state = reg.active?.state || 'waiting'; local = await reg.pushManager.getSubscription(); } catch (e) { state = 'error: ' + (e?.message || e); }
    // On here but not on the server (a lost sign-up): send it again, nothing to tap.
    if (local && !st.on) { const r = await post('/api/remind/subscribe', local); report('resent', { ok: r.ok }); }
    report('open', { from: 'tab', standalone: !!standalone, ios: isIOS, push: 'PushManager' in window, notif: typeof Notification === 'undefined' ? 'none' : Notification.permission, sw: state, subscribed: !!local, serverOn: st.on, ua: navigator.userAgent });
    if (!local) { if (isIOS && !standalone) q('.rm-home').hidden = false; else if ('PushManager' in window) q('.rm-on').hidden = false; }

    q('.rm-enable').onclick = async () => {
      try {
        report('tap');
        const perm = await Notification.requestPermission(); report('permission', { perm });
        if (perm !== 'granted') { q('.rm-text').textContent = 'Notifications are off for Recall. Turn them on in Settings, Notifications, Recall.'; return; }
        const reg = await sw();
        const key = (await (await fetch('/api/remind/key')).json()).key;
        const raw = Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((key.length + 3) % 4)), (c) => c.charCodeAt(0));
        const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: raw }); report('subscribed', { endpoint: sub.endpoint.slice(0, 40) });
        const r = await post('/api/remind/subscribe', sub);
        if (!r.ok) throw new Error('Recall did not save it (' + r.status + ')');
        q('.rm-on').innerHTML = '<p class="rm-text">Remind is on for this phone. The first one is on its way.</p>'; q('.rm-send').hidden = false;
        const n = await (await post('/api/remind/now')).json(); report('sent', n);
      } catch (e) {
        q('.rm-text').textContent = 'That didn’t work: ' + (e?.message || e) + '. Try once more; if it fails again, tell Claude.';
        report('error', { error: String(e?.message || e) });
      }
    };
  }
  window.loadRemind = (root) => load(root).catch((e) => { root.innerHTML = '<p class="small muted">Remind didn’t load. Pull down to try again.</p>'; report('error', { error: 'list: ' + String(e?.message || e) }); });
})();
