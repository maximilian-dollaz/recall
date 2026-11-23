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

  // Three subtabs, top right. Remind: every reminder that comes back, all at once. Still landing: the ones you put
  // away until tomorrow. Evidence: the ones you have lived (let go ones sit at the bottom).
  const when = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const BTN = {
    lived: '<button class="primary" type="button" data-a="lived">Yes, lived it</button>',
    landing: '<button class="rm-second" type="button" data-a="landing">Still landing</button>',
    letgo: '<button class="rm-quiet" type="button" data-a="let-go">Let go</button>',
  };
  function tile(s, btns, note = '') {
    return `<article class="rm-tile" data-id="${esc(s.id)}">
      <h3 class="rm-title">${esc(s.title)}</h3>
      <blockquote class="rm-words">“${esc(s.words)}”</blockquote>
      <div class="rm-from">You, ${day(s.from.date)}${s.from.slug ? ` · <a href="/?item=${encodeURIComponent(s.from.slug)}">${esc(s.from.title)}</a>` : ''}</div>
      ${s.when_then ? `<div class="rm-then">${esc(s.when_then)}</div>` : ''}
      ${note ? `<div class="rm-note">${note}</div>` : ''}
      <div class="rm-btns">${btns}</div>
    </article>`;
  }

  async function load(root) {
    const st = await (await fetch('/api/remind/status')).json();
    const held = (s) => s.hold && Date.parse(s.hold) > Date.now();
    root.innerHTML = `
      <div class="rm-top" role="tablist"><button type="button" role="tab" class="rm-sub" data-v="deck" aria-selected="true">Remind <span class="rm-n" data-n="deck"></span></button><button type="button" role="tab" class="rm-sub" data-v="landing" aria-selected="false">Still landing <span class="rm-n" data-n="landing"></span></button><button type="button" role="tab" class="rm-sub" data-v="jar" aria-selected="false">Evidence <span class="rm-n" data-n="jar"></span></button></div>
      <div class="rm-view" data-v="deck">
      <div class="rm-on" hidden><p class="rm-text">Your words come back to this phone, up to three times a day, until you live them.</p><button class="primary rm-enable" type="button">Turn on Remind</button></div>
      <p class="rm-home small muted" hidden>Open Recall from your home screen, then come back here to turn on Remind.</p>
      <div class="rm-deck rm-tiles"></div>
      <button class="rm-send" type="button" hidden>Send one now</button>
      </div>
      <div class="rm-view rm-landing rm-tiles" data-v="landing" hidden></div>
      <div class="rm-view rm-jar" data-v="jar" hidden></div>`;
    const q = (s) => root.querySelector(s);
    const view = (v) => {
      root.querySelectorAll('.rm-sub').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.v === v)));
      root.querySelectorAll('.rm-view').forEach((d) => d.hidden = d.dataset.v !== v);
    };
    q('.rm-top').onclick = (e) => { const b = e.target.closest('.rm-sub'); if (b) view(b.dataset.v); };
    // A count that changes pops, so you see where the reminder went.
    const count = (k, n) => {
      const el = q(`.rm-n[data-n="${k}"]`); const was = el.textContent; el.textContent = n || '';
      if (el.dataset.shown && was !== el.textContent && n > (+was || 0)) { el.classList.remove('rm-pop'); void el.offsetWidth; el.classList.add('rm-pop'); }
      el.dataset.shown = '1';
    };
    // The jar, laid out like projects: a box per cluster, three across, each showing a 2×2 of what's inside (a picture
    // when the evidence has one, otherwise its title). Tap a box to open it: its sub-clusters as boxes, or its tiles.
    // Clusters form on their own (the same living topics as a project) and fill in when they arrive.
    let groups = null, groupsFor = '', opened = [], last = [[], []];
    const pic = (s) => s.thumb ? `/thumb/${encodeURIComponent(s.thumb)}?s=720` : '';
    const cell = (s) => pic(s) ? `<i class="pic" style="background-image:url('${pic(s)}')"></i>` : `<i class="rm-ttl">${esc(s.title)}</i>`;
    const box = (key, name, list, meta) => {
      const cells = list.slice(0, 4).map(cell); if (list.length > 4) cells[3] = `<i class="more">+${list.length - 3}</i>`;
      return `<button class="panel" type="button" data-open="${esc(key)}" aria-label="${esc(name)}"><div class="mosaic">${cells.join('')}</div><div class="ptext"><span class="pname">${esc(name)}</span><span class="pmeta">${esc(meta)}</span></div></button>`;
    };
    const tiles = (list, letgo) => `<div class="rm-grid">${list.map((s) => `<a class="rm-card" href="/remind/${s.id}">${pic(s) ? `<i class="pic" style="background-image:url('${pic(s)}')"></i>` : ''}<b>${esc(s.title)}</b>${pic(s) ? '' : `<span class="rm-cw">\u201c${esc(s.words)}\u201d</span>`}<small>${letgo ? 'let go' : `lived ${s.evidence ? when(s.evidence) : ''}`}</small></a>`).join('')}</div>`;
    const jar = (ev = last[0], gone = last[1]) => {
      last = [ev, gone];
      const byId = new Map([...ev, ...gone].map((s) => [s.id, s]));
      const pick = (ids) => ids.map((i) => byId.get(i)).filter(Boolean);
      const lived = (n) => `${n} lived`;
      // Top level: the clusters (and anything lived since they were made), then Let go.
      let top = [];
      if (groups && !(groups.length === 1 && groups[0].name === 'Everything')) {
        const placed = new Set(groups.flatMap((g) => g.items));
        const fresh = ev.filter((s) => !placed.has(s.id));
        if (fresh.length) top.push({ key: 'new', name: 'Just lived', list: fresh });
        for (const g of groups) { const list = pick(g.items); if (list.length) top.push({ key: g.id, name: g.name, list, kids: g.children?.map((c) => ({ key: c.id, name: c.name, list: pick(c.items) })).filter((c) => c.list.length) }); }
      } else if (ev.length) top.push({ key: 'all', name: 'Everything', list: ev, flat: true });
      if (gone.length) top.push({ key: 'let-go', name: 'Let go', list: gone, letgo: true });
      // Walk down to the box that is open, if it still exists.
      let here = { kids: top }, trail = [];
      for (const k of opened) { const n = here.kids?.find((x) => x.key === k); if (!n) break; here = n; trail.push(n); }
      opened = trail.map((n) => n.key);
      let body;
      if (!trail.length) {
        if (!ev.length && !gone.length) body = '<p class="rm-done">Nothing here yet. Each “Yes, lived it” lands here.</p>';
        else if (top.length === 1 && top[0].flat) body = tiles(ev); // one group only: straight to the tiles, no extra tap
        else body = `<div class="dock homegrid">${top.map((n) => box(n.key, n.name, n.list, n.letgo ? `${n.list.length} let go` : lived(n.list.length))).join('')}</div>`;
      } else {
        const back = `<button class="rm-back" type="button" data-back="1">← ${esc(trail.length > 1 ? trail[trail.length - 2].name : 'Evidence')}</button>`;
        body = `<div class="rm-crumb">${back}<h3 class="rm-h">${esc(here.name)} · ${here.list.length}</h3></div>`
          + (here.kids?.length ? `<div class="dock homegrid">${here.kids.map((n) => box(n.key, n.name, n.list, lived(n.list.length))).join('')}</div>` : tiles(here.list, here.letgo));
      }
      q('.rm-jar').innerHTML = body;
      const key = ev.map((s) => s.id).sort().join();
      if (ev.length && key !== groupsFor) {
        groupsFor = key;
        fetch('/api/remind/evidence').then((r) => r.json()).then((r) => { if (r.groups && groupsFor === key) { groups = r.groups; jar(); } }).catch(() => {});
      }
    };
    q('.rm-jar').onclick = (e) => {
      const o = e.target.closest('[data-open]'); if (o) { opened.push(o.dataset.open); jar(); q('#reminders')?.scrollIntoView?.({ block: 'start' }); return; }
      if (e.target.closest('[data-back]')) { opened.pop(); jar(); }
    };
    const render = () => {
      const on = st.sparks.filter((s) => s.state === 'on' && !held(s)).sort((a, b) => a.next.localeCompare(b.next));
      const landing = st.sparks.filter((s) => s.state === 'on' && held(s)).sort((a, b) => a.hold.localeCompare(b.hold));
      const ev = st.sparks.filter((s) => s.state === 'evidence').sort((a, b) => (b.evidence || '').localeCompare(a.evidence || ''));
      const gone = st.sparks.filter((s) => s.state === 'let-go');
      count('deck', on.length); count('landing', landing.length); count('jar', ev.length);
      q('.rm-deck').innerHTML = on.length ? on.map((s) => tile(s, BTN.lived + BTN.landing + BTN.letgo)).join('')
        : `<p class="rm-done">${st.sparks.length ? 'All processed. The ones still landing come back tomorrow.' : 'Nothing yet. Say “remind me” in a voice note or a Granola note and it lands here.'}</p>`;
      q('.rm-landing').innerHTML = landing.length ? landing.map((s) => tile(s, BTN.lived + BTN.letgo, `Comes back ${when(s.hold)}`)).join('')
        : '<p class="rm-done">Nothing still landing. Tap “Still landing” on a reminder and it waits here until it comes back.</p>';
      jar(ev, gone);
    };
    // Tap a button on any tile: it slides out and moves to its subtab.
    root.addEventListener('click', async (e) => {
      const btn = e.target.closest('.rm-tile button[data-a]'); if (!btn || btn.disabled) return;
      const card = btn.closest('.rm-tile'); const s = st.sparks.find((x) => x.id === card.dataset.id); if (!s) return;
      card.querySelectorAll('button').forEach((b) => b.disabled = true);
      const r = await post('/api/remind/answer', { id: s.id, answer: btn.dataset.a });
      if (!r.ok) { card.querySelectorAll('button').forEach((b) => b.disabled = false); return; }
      Object.assign(s, await r.json());
      card.classList.add('rm-out');
      setTimeout(render, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 260);
    });
    render();
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
