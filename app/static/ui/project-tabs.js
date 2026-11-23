// A project's Create and Remind tabs (Share is in index.html). Each starts from the artifacts picked on the board.
//   ProjectTabs.remind(ctx, ids, done)   put the picked artifacts into Remind with a note: how, when and what for
//   ProjectTabs.create(ctx, ids, done)   make something from them in a queue (create.ts); with no ids, just the queue
// ctx is the open project: { id, d: { project: { name }, items } }.
(() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const post = (u, body) => fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }).then(async (r) => ({ ok: r.ok, ...(await r.json().catch(() => ({}))) })).catch(() => ({ ok: false }));
  const say = (t) => window.toast ? window.toast(t) : null;
  const VID = /\.(mp4|mov|m4v|webm)$/i;
  function sheet(id, html) {
    document.getElementById(id)?.remove();
    const dlg = document.createElement('dialog'); dlg.id = id; dlg.className = 'invite pt-sheet';
    dlg.innerHTML = `<div class="inv-in">${html}</div>`; document.body.append(dlg);
    dlg.addEventListener('close', () => dlg.remove());
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
    dlg.showModal(); return dlg;
  }
  const picks = (ctx, ids) => { const by = new Map(ctx.d.items.map((it) => [it.id, it])); return ids.map((i) => by.get(i)).filter(Boolean); };
  const strip = (items) => `<div class="pt-picks">${items.slice(0, 6).map((it) => it.thumb ? `<i style="background-image:url('/thumb/${encodeURIComponent(it.thumb)}?s=720')" title="${esc(it.title)}"></i>` : `<i class="pt-word" title="${esc(it.title)}">${esc(it.title.slice(0, 18))}</i>`).join('')}${items.length > 6 ? `<i class="pt-word">+${items.length - 6}</i>` : ''}</div>`;

  // ── Remind ──
  function remind(ctx, ids, done) {
    const items = picks(ctx, ids); if (!items.length) return;
    const dlg = sheet('pt-remind', `<h3>Remind me of ${items.length === 1 ? 'this' : `these ${items.length}`}</h3>${strip(items)}
      <textarea name="note" rows="3" placeholder="How, when and what for?" aria-label="How, when and what for?"></textarea>
      <p class="small muted">Your words come back with it. Say a day, like next Friday, and it first comes back then. Otherwise tomorrow.</p>
      <p class="inv-msg small" role="status"></p>
      <div class="inv-act"><button type="button" class="quiet" data-x>Cancel</button><button type="button" class="primary" data-go>Add to Remind</button></div>`);
    const note = dlg.querySelector('textarea'), msg = dlg.querySelector('.inv-msg'), go = dlg.querySelector('[data-go]');
    dlg.querySelector('[data-x]').onclick = () => dlg.close();
    go.onclick = async () => {
      if (note.value.trim().length < 3) { msg.textContent = 'Say how, when and what for.'; note.focus(); return; }
      go.disabled = true;
      const r = await post('/api/remind/asset', { items: ids, note: note.value });
      if (!r.ok) { go.disabled = false; msg.textContent = r.error || "That didn't save. Try again."; return; }
      const first = r.first ? new Date(r.first).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : '';
      dlg.close(); say(`Added to Remind.${first ? ` First back ${first}.` : ''}`); done?.();
    };
    if (matchMedia('(hover: hover)').matches) setTimeout(() => note.focus(), 50); // on a phone the keyboard would cover the button
  }

  // ── Create ──
  const STATE = { queued: 'Waiting its turn', making: 'Making it', ready: 'Ready', failed: "Didn't work" };
  function jobHtml(j, formats, canSend, canCanva) {
    const name = formats[j.format]?.name || j.format, src = (n) => `/api/create/file?id=${encodeURIComponent(j.id)}&n=${n}`;
    const media = j.status !== 'ready' ? '' : j.format === 'post'
      ? `<div class="pt-out pics">${j.out.map((_, n) => `<a href="${src(n)}&dl=1"><img src="${src(n)}" alt="" loading="lazy"></a>`).join('')}</div>`
      : `<video class="pt-out" src="${src(0)}" controls playsinline preload="metadata"></video>`;
    const send = j.status !== 'ready' ? '' : j.sent ? `<p class="small muted">${esc(j.sent.note)}</p>`
      : canSend ? `<details class="pt-send"><summary>Save as a draft to schedule</summary><textarea name="caption" rows="3" placeholder="Your caption, in your words" aria-label="Your caption"></textarea>
          <div class="pt-nets">${['instagram', 'linkedin'].map((n) => `<label><input type="checkbox" name="net" value="${n}" checked> ${n[0].toUpperCase() + n.slice(1)}</label>`).join('')}</div>
          <button type="button" class="primary" data-send="${esc(j.id)}">Save draft</button><p class="small muted">It is saved as a draft. Nothing is posted.</p></details>`
      : '<p class="small muted">To schedule it to Instagram or LinkedIn, <a href="/connectors">connect a scheduling tool</a>.</p>';
    return `<article class="pt-job pt-${j.status}" data-id="${esc(j.id)}">
      <header><b>${esc(name)}</b><span>${STATE[j.status] || j.status}${j.status === 'queued' || j.status === 'making' ? '<i class="ag-dots" aria-hidden="true"></i>' : ''}</span></header>
      ${j.brief ? `<p class="pt-brief">${esc(j.brief)}</p>` : ''}
      ${j.error ? `<p class="ag-err">${esc(j.error)}</p>` : ''}${media}${send}
      <div class="pt-row">${j.status === 'ready' && j.format !== 'post' ? `<a class="rm-second" href="${src(0)}&dl=1">Download</a>` : ''}${j.status === 'ready' && canCanva ? `<button type="button" class="rm-second" data-canva="${esc(j.id)}">Send to Canva</button>` : ''}${j.status !== 'making' ? `<button type="button" class="rm-quiet" data-del="${esc(j.id)}">Remove</button>` : ''}</div>
    </article>`;
  }
  function create(ctx, ids, done) {
    const items = picks(ctx, ids), hasVid = items.some((it) => it.kind === 'video' || (it.files || []).some((f) => VID.test(f))), hasPic = items.some((it) => it.kind === 'image');
    const can = (k) => k === 'reel' ? hasVid : hasPic;
    const dlg = sheet('pt-create', `<h3>${items.length ? `Create from ${items.length} picked` : `Made for ${esc(ctx.d.project.name)}`}</h3>
      ${items.length ? `${strip(items)}<div class="pt-formats" role="radiogroup" aria-label="What to make"></div>
      <textarea name="brief" rows="2" placeholder="How and why?" aria-label="How and why?"></textarea>
      <p class="inv-msg small" role="status"></p>
      <div class="inv-act"><button type="button" class="quiet" data-x>Close</button><button type="button" class="primary" data-go>Add to queue</button></div><h4 class="sh-h">Made for this project</h4>` : ''}
      <div class="pt-jobs" aria-live="polite"><p class="small muted">Loading…</p></div>
      ${items.length ? '' : '<div class="inv-act"><button type="button" class="quiet" data-x>Close</button></div>'}`);
    let timer = null, format = hasVid ? 'reel' : hasPic ? 'board-video' : '', added = false, sig = '';
    dlg.addEventListener('close', () => { clearTimeout(timer); if (added) done?.(); });
    dlg.querySelectorAll('[data-x]').forEach((b) => b.onclick = () => dlg.close());
    const jobsEl = dlg.querySelector('.pt-jobs'), msg = dlg.querySelector('.inv-msg');
    async function load() {
      clearTimeout(timer);
      const r = await fetch('/api/create?project=' + encodeURIComponent(ctx.id)).then((x) => x.json()).catch(() => null); if (!r || !dlg.isConnected) return;
      const fe = dlg.querySelector('.pt-formats');
      if (fe && !fe.children.length) {
        fe.innerHTML = !format ? '<p class="small muted">Pick pictures or a video to make something. Notes and links can’t be made into one yet.</p>' : Object.entries(r.formats).filter(([k]) => can(k)).map(([k, f]) => `<button type="button" role="radio" data-f="${k}" aria-checked="${k === format}"><b>${esc(f.name)}</b><span>${esc(f.what)}</span></button>`).join('');
        fe.onclick = (e) => { const b = e.target.closest('[data-f]'); if (!b) return; format = b.dataset.f; fe.querySelectorAll('[data-f]').forEach((x) => x.setAttribute('aria-checked', String(x === b))); };
      }
      // Redraw only when a job changed, so a caption being typed and a video being watched are left alone.
      const now = JSON.stringify(r.jobs.map((j) => [j.id, j.status, !!j.sent]));
      if (now !== sig) { sig = now; jobsEl.innerHTML = r.jobs.length ? r.jobs.map((j) => jobHtml(j, r.formats, r.canSend, r.canCanva)).join('') : '<p class="small muted">Nothing made yet.</p>'; }
      if (r.jobs.some((j) => j.status === 'queued' || j.status === 'making')) timer = setTimeout(load, 3000);
    }
    const go = dlg.querySelector('[data-go]');
    if (go && !format) go.disabled = true;
    if (go) go.onclick = async () => {
      go.disabled = true; msg.textContent = '';
      const r = await post('/api/create', { project: ctx.id, items: ids, format, brief: dlg.querySelector('[name=brief]').value });
      go.disabled = false;
      if (!r.ok) { msg.textContent = r.error || "That didn't go in the queue. Try again."; return; }
      added = true; say('Added to the queue');
      // The picks are used: leave only what was made, so a second tap can't add it twice.
      dlg.querySelectorAll('.pt-picks, .pt-formats, [name=brief], .inv-msg').forEach((x) => x.remove()); go.remove(); dlg.querySelector('h3').textContent = `Made for ${ctx.d.project.name}`; load();
    };
    jobsEl.addEventListener('click', async (e) => {
      const del = e.target.closest('[data-del]'), snd = e.target.closest('[data-send]');
      const cv = e.target.closest('[data-canva]');
      if (cv) { cv.disabled = true; cv.textContent = 'Sending…'; const r = await post('/api/create/canva', { id: cv.dataset.canva }); cv.textContent = r.ok ? 'In Canva' : 'Send to Canva'; cv.disabled = !!r.ok; say(r.ok ? r.note : (r.error || "That didn't send.")); }
      if (del) { del.disabled = true; await post('/api/create/remove', { id: del.dataset.del }); sig = ''; load(); }
      if (snd) {
        const job = snd.closest('.pt-job'); snd.disabled = true;
        const r = await post('/api/create/send', { id: snd.dataset.send, caption: job.querySelector('[name=caption]').value, networks: [...job.querySelectorAll('[name=net]:checked')].map((x) => x.value) });
        if (!r.ok) { snd.disabled = false; say(r.error || "That didn't save."); return; }
        say(r.note || 'Saved as a draft'); sig = ''; load();
      }
    });
    load();
  }
  window.ProjectTabs = { remind, create };
})();
