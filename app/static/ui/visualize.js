// Visualize: a sidebar that slides in from the right of a board. Drag pictures and notes off the board into it,
// type or speak what you want, press Picture or Video. Everyone on the board sees the same sidebar (it polls every
// 1.5 s), so the result is everyone's words and everyone's pictures at once. Anyone can Keep a result.
//
//   Visualize.mount(boardEl, { boardId, projectId, team })   Visualize.unmount()
//
// Board cards ([data-i]) become draggable while the sidebar is open. A drag carries the item id as
// text/x-recall-item (what the rest of the page already uses) and a small JSON as text/x-recall-ref.
(() => {
  const CARRY = 'text/x-recall-item', REF = 'text/x-recall-ref';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ICON = { image: '▣', document: '▤', voice: '◉', note: '✎', link: '↗', video: '▶' };
  const STATUS = { drafting: 'Writing the prompt…', queued: 'Waiting…', in_progress: 'Making it…', completed: '', preview: 'Preview: nothing was sent out', failed: 'Didn’t work', nsfw: 'Stopped by the content rules', canceled: 'Canceled' };
  const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then(async r => ({ ok: r.ok, status: r.status, ...(await r.json().catch(() => ({}))) }));
  let S = null; // the one open sidebar

  // ── Drag sources: the board's own cards ──
  function refFromCard(el) {
    const img = el.querySelector('img');
    const title = (el.querySelector('span:not(.ic)')?.textContent || el.querySelector('b')?.textContent || '').replace(/^[▣▤◉✎↗▶·]\s*/, '').trim();
    const kind = el.classList.contains('bd-pic') ? (el.querySelector('em') ? 'video' : 'image') : (Object.entries(ICON).find(([, i]) => el.querySelector('.ic')?.textContent === i)?.[0] || 'note');
    return { id: el.dataset.i, title, thumb: img?.getAttribute('src') || '', kind, by: '' };
  }
  /** Make any element draggable into the sidebar (the board's cards get this automatically). */
  function draggable(el, ref) {
    el.draggable = true; el.dataset.vizDrag = '1'; el.querySelectorAll('img').forEach(i => i.draggable = false);
    if (ref) el._vizRef = ref;
  }
  function onDragStart(e) {
    const el = e.target.closest?.('[data-viz-drag]'); if (!el || !S) return;
    const ref = el._vizRef || refFromCard(el); if (!ref.id) return;
    e.dataTransfer.setData(CARRY, ref.id); e.dataTransfer.setData(REF, JSON.stringify(ref)); e.dataTransfer.effectAllowed = 'copyMove';
    S.aside.classList.add('wants');
  }
  const onDragEnd = () => S?.aside.classList.remove('wants', 'over');
  function wireCards() { if (S) S.boardEl.querySelectorAll('.bd-body [data-i]:not([data-viz-drag])').forEach(el => draggable(el)); }

  // ── Mount ──
  /** Put one board item into the panel (dropped, or clicked while Create is open). */
  async function addItem(id, ref = null) {
    if (!S) return;
    const tmp = { tmp: true, id: 'tmp-' + Date.now(), title: ref?.title || 'Adding…', thumb: ref?.thumb, kind: ref?.kind || 'image' };
    S.pending.push(tmp); renderRefs();
    const r = await post('/api/visualize/ref', { board: S.board, id });
    if (!S) return;
    S.pending = S.pending.filter(x => x !== tmp);
    if (!r.ok) say(r.error || 'Couldn’t add that one.'); else say('');
    renderRefs(); poll(true);
  }
  function mount(boardEl, opts = {}) {
    if (S && S.boardEl === boardEl && S.board === (opts.boardId || 'default')) { S.opts = { ...S.opts, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) }; return S.aside; } // Keep suggests the last project you were in
    unmount(true);
    const aside = document.createElement('aside');
    aside.className = 'viz'; aside.setAttribute('aria-label', 'Creator mode');
    aside.innerHTML = `
      <header class="viz-top"><h3>Creator mode</h3><span class="viz-mode" hidden></span><button class="viz-x" aria-label="Close Creator mode"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></header>
      <div class="viz-scroll">
        <section class="viz-results" aria-label="Results"></section>
        <section class="viz-refs" aria-label="References"><div class="viz-tiles"></div><p class="viz-hint">Click or drag pictures and notes here</p></section>
        <section class="viz-words" aria-label="Everyone’s words"><ol class="viz-said"></ol>
          <div class="viz-pad"><textarea rows="2" placeholder="Type or speak what to make" aria-label="Your words"></textarea>
            <div class="viz-pad-btns"><button class="viz-mic" type="button" aria-label="Speak" hidden>Speak</button><button class="viz-add" type="button">Add</button></div></div>
        </section>
        <details class="viz-prompt"><summary>Prompt</summary><textarea rows="5" aria-label="Prompt" placeholder="Written for you when you press Picture or Video"></textarea><p class="viz-pstat"></p></details>
        <div class="viz-opts"><select class="viz-model" aria-label="Model"><option value="">Model: picked for you</option><option value="gpt">GPT Image 2.5 (best for text and logos)</option><option value="banana">Nano Banana Pro (best with several photos)</option><option value="flux">FLUX 3</option></select>
          <label class="viz-editlast"><input type="checkbox" checked> Change the last picture</label>
          <button type="button" class="viz-over">Clear</button></div>
      </div>
      <footer class="viz-foot"><p class="viz-status" role="status"></p>
        <div class="viz-go"><button class="viz-btn primary" data-kind="image">Create</button><button class="viz-btn" data-kind="video">Video</button></div></footer>`;
    boardEl.append(aside); boardEl.classList.add('viz-on');
    S = { boardEl, aside, opts, board: opts.boardId || 'default', version: -1, data: null, timer: 0, fails: 0, source: null, projects: null, pending: [], rec: null, promptDirty: false };
    requestAnimationFrame(() => requestAnimationFrame(() => aside.classList.add('in')));
    const $ = (s) => aside.querySelector(s);
    $('.viz-x').onclick = () => { unmount(); document.dispatchEvent(new Event('creator-mode')); };

    // Drops: an item id, or the JSON ref (shown at once while the server looks it up).
    const takes = (e) => e.dataTransfer?.types?.includes(REF) || e.dataTransfer?.types?.includes(CARRY);
    aside.addEventListener('dragover', (e) => { if (!takes(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; aside.classList.add('over'); });
    aside.addEventListener('dragleave', (e) => { if (!aside.contains(e.relatedTarget)) aside.classList.remove('over'); });
    aside.addEventListener('drop', async (e) => {
      if (!takes(e)) return; e.preventDefault(); e.stopPropagation(); aside.classList.remove('over', 'wants');
      let ref = null; try { ref = JSON.parse(e.dataTransfer.getData(REF) || 'null'); } catch {}
      const id = ref?.id || e.dataTransfer.getData(CARRY); if (!id) return;
      addItem(id, ref);
    });
    boardEl.addEventListener('dragstart', onDragStart); boardEl.addEventListener('dragend', onDragEnd);
    S.observer = new MutationObserver(wireCards); S.observer.observe(boardEl, { childList: true, subtree: true }); wireCards();

    // Words: Enter adds them; Shift+Enter is a new line.
    const pad = $('.viz-pad textarea');
    const addWords = async (text) => {
      text = (text ?? pad.value).trim(); if (!text) return;
      const r = await post('/api/visualize/words', { board: S.board, text });
      if (!r.ok) return say(r.error || 'Couldn’t add your words.');
      if (text === pad.value.trim()) pad.value = ''; say(''); poll(true);
    };
    $('.viz-add').onclick = () => addWords();
    // Clear: everything leaves the panel (pictures put in, words, made pictures); kept pictures stay in their projects.
    $('.viz-over').onclick = async () => {
      const r = await post('/api/visualize/clear', { board: S.board });
      if (!r.ok) return say(r.error || 'Couldn’t clear.');
      pad.value = ''; say('Cleared. Kept pictures are in their projects.'); poll(true);
    };
    pad.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); addWords(); } };
    wireSpeech($('.viz-mic'), pad, addWords);

    // The shared prompt: edit it by hand; saved when you leave the box, unless someone else changed it first.
    const pbox = $('.viz-prompt textarea');
    // The version is the one you started editing from, so a change someone made meanwhile is caught, not overwritten.
    pbox.oninput = () => { if (!S.promptDirty) S.promptBase = S.data?.prompt.version ?? 0; S.promptDirty = true; };
    pbox.onblur = async () => {
      if (!S?.promptDirty || !S.data) return; S.promptDirty = false;
      const r = await post('/api/visualize/prompt', { board: S.board, text: pbox.value, baseVersion: S.promptBase });
      $('.viz-pstat').textContent = r.status === 409 ? 'Someone else changed the prompt at the same time. Theirs is shown; yours wasn’t saved.' : r.ok ? 'Saved' : (r.error || 'Not saved');
      S.pnoteUntil = Date.now() + 6000;
      if (r.status === 409) pbox.value = S.data.prompt.text || '';
      poll(true);
    };

    aside.querySelectorAll('.viz-btn').forEach(b => b.onclick = async () => {
      const kind = b.dataset.kind; b.disabled = true; b.setAttribute('aria-busy', 'true');
      if (pbox.matches(':focus')) pbox.blur(); // a hand edit in progress is saved first
      try { S.rec?.stop(); } catch {}
      if (pad.value.trim()) await addWords(); // what's typed (or still being spoken) goes in with this press: no Add needed
      const r = await post('/api/visualize/generate', { board: S.board, kind, source: kind === 'video' ? S.source : undefined, model: aside.querySelector('.viz-model').value || undefined, edit: aside.querySelector('.viz-editlast input').checked });
      b.disabled = false; b.removeAttribute('aria-busy');
      say(r.ok ? '' : (r.error || 'Couldn’t start it.')); poll(true);
    });

    poll(true);
    return aside;
  }

  function unmount(now = false) {
    if (!S) return; const { aside, boardEl } = S;
    clearTimeout(S.timer); S.observer?.disconnect(); try { S.rec?.stop(); } catch {}
    boardEl.removeEventListener('dragstart', onDragStart); boardEl.removeEventListener('dragend', onDragEnd);
    boardEl.querySelectorAll('[data-viz-drag]').forEach(el => { el.removeAttribute('draggable'); delete el.dataset.vizDrag; });
    boardEl.classList.remove('viz-on'); S = null;
    if (now) aside.remove(); else { aside.classList.remove('in'); setTimeout(() => aside.remove(), 400); }
  }

  // ── Speech: Chrome and Safari's own recognizer; without it the box is for typing. ──
  function wireSpeech(btn, pad, addWords) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition; if (!SR) return;
    btn.hidden = false; let on = false, typed = '';
    btn.onclick = () => {
      if (on) { try { S.rec?.stop(); } catch {} return; }
      const rec = new SR(); rec.continuous = true; rec.interimResults = true; rec.lang = navigator.language || 'en-US';
      typed = pad.value.trim();
      // Each finished phrase goes straight onto the board, so everyone sees it while you keep talking.
      rec.onresult = (e) => {
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const t = e.results[i][0].transcript.trim();
          if (e.results[i].isFinal) { if (t) addWords((typed ? typed + ' ' : '') + t); typed = ''; } else interim += t + ' ';
        }
        pad.value = ((typed ? typed + ' ' : '') + interim).trim();
      };
      rec.onerror = (e) => { if (e.error === 'not-allowed' || e.error === 'service-not-allowed') say('The microphone isn’t allowed here. Type instead.'); };
      rec.onend = () => { on = false; btn.textContent = 'Speak'; btn.classList.remove('rec'); btn.setAttribute('aria-label', 'Speak'); if (S) S.rec = null; };
      try { rec.start(); S.rec = rec; on = true; btn.textContent = 'Stop'; btn.classList.add('rec'); btn.setAttribute('aria-label', 'Stop listening'); }
      catch { say('The microphone isn’t available. Type instead.'); }
    };
  }

  // ── Polling: every 1.5 s; 204 means nothing changed. ──
  async function poll(soon = false) {
    if (!S) return; const me = S;
    if (me.inflight) { me.again = true; return; } // one request at a time; a nudge during one runs right after
    clearTimeout(me.timer); me.inflight = true;
    if (!document.hidden) {
      try {
        const r = await fetch(`/api/visualize/state?board=${encodeURIComponent(me.board)}&since=${soon ? -1 : me.version}`);
        if (me === S && r.status === 200) { const d = await r.json(); me.version = d.version; me.data = d; render(); }
        else if (me === S && r.status !== 204) { const d = await r.json().catch(() => ({})); say(d.error || 'Create isn’t available right now.'); }
        me.fails = 0;
      } catch { if (me === S && ++me.fails === 3) say('Lost the connection. Trying again…'); }
    }
    me.inflight = false;
    if (me !== S) return;
    if (me.again) { me.again = false; return poll(true); }
    me.timer = setTimeout(poll, 1500);
  }

  const say = (t) => { const s = S?.aside.querySelector('.viz-status'); if (s) s.textContent = t; };
  const fileUrl = (name) => `/api/visualize/file?board=${encodeURIComponent(S.board)}&name=${encodeURIComponent(name)}`;
  const refUrl = (id) => `/api/visualize/ref-image?board=${encodeURIComponent(S.board)}&ref=${encodeURIComponent(id)}`;

  function render() {
    const d = S.data, $ = (s) => S.aside.querySelector(s);
    const mode = $('.viz-mode'); mode.hidden = d.mode !== 'dry';
    mode.textContent = 'Preview mode'; mode.title = `Nothing is sent out until ${window.RECALL_OWNER || 'the owner'} switches it on.`;
    if (S.source && !d.refs.some(r => r.id === S.source && r.picture)) S.source = null;
    renderRefs();
    $('.viz-said').innerHTML = d.words.map(w => `<li><b>${esc(w.by)}</b> ${esc(w.text)}<button class="viz-rm" data-w="${esc(w.id)}" aria-label="Remove these words">×</button></li>`).join('');
    $('.viz-said').querySelectorAll('[data-w]').forEach(b => b.onclick = async () => { b.disabled = true; await post('/api/visualize/words/remove', { board: S.board, id: b.dataset.w }); poll(true); });
    const said = $('.viz-said'); said.scrollTop = said.scrollHeight;
    const pbox = $('.viz-prompt textarea');
    if (!pbox.matches(':focus') && !S.promptDirty) pbox.value = d.prompt.text || '';
    if (!pbox.matches(':focus') && !(S.pnoteUntil > Date.now())) $('.viz-pstat').textContent = d.prompt.text ? `${d.prompt.drafted ? 'Written from everyone’s words' : 'Edited'}${d.prompt.by ? ' · ' + d.prompt.by : ''}` : '';
    const busy = d.limits.running >= d.limits.maxRunning;
    S.aside.querySelectorAll('.viz-btn').forEach(b => { b.disabled = busy || (b.dataset.kind === 'video' && !d.refs.some(r => r.picture)); });
    S.aside.querySelector('[data-kind="video"]').title = d.refs.some(r => r.picture) ? 'Starts from the picture marked “Start”' : 'Drag a picture in first';
    renderResults();
  }

  function renderRefs() {
    const d = S.data, tiles = S.aside.querySelector('.viz-tiles');
    const refs = d ? d.refs : [];
    const firstPic = refs.find(r => r.picture)?.id;
    const start = S.source || firstPic;
    tiles.innerHTML = refs.map(r => `<div class="viz-tile${r.picture ? ' pic' : ''}${r.id === start ? ' start' : ''}" data-r="${esc(r.id)}" title="${esc(r.title)}${r.by ? ' · ' + esc(r.by) : ''}">
        ${r.picture ? `<img src="${refUrl(r.id)}" alt="" loading="lazy">` : `<i>${ICON[r.kind] || '·'}</i>`}<span>${esc(r.title)}</span>
        ${r.id === start ? '<em>Start</em>' : ''}<button class="viz-rm" aria-label="Remove ${esc(r.title)}">×</button></div>`).join('')
      + S.pending.map(p => `<div class="viz-tile pending">${p.thumb ? `<img src="${esc(p.thumb)}" alt="">` : `<i>${ICON[p.kind] || '·'}</i>`}<span>${esc(p.title)}</span></div>`).join('');
    S.aside.querySelector('.viz-hint').hidden = !!(refs.length || S.pending.length);
    tiles.querySelectorAll('[data-r]').forEach(t => {
      t.querySelector('.viz-rm').onclick = async (e) => { e.stopPropagation(); t.classList.add('gone'); await post('/api/visualize/ref/remove', { board: S.board, ref: t.dataset.r }); poll(true); };
      // A click on a picture makes it the video's first frame.
      if (t.classList.contains('pic')) t.onclick = () => { S.source = t.dataset.r; renderRefs(); };
    });
  }

  // Each result is redrawn only when it changes, so a video someone is watching keeps playing while others talk.
  function renderResults() {
    const d = S.data, box = S.aside.querySelector('.viz-results');
    const old = new Map([...box.children].map(a => [a.dataset.job, a]));
    const sig = (j) => [j.status, j.files.join(), j.prompt, j.error, d.kept.filter(k => k.job === j.id).length].join('|');
    const newest = d.jobs[0]?.id; // the server sends newest first; an attempt that didn't work shows only while it's the latest
    const nodes = d.jobs.filter(j => j.status !== 'failed' || j.id === newest).map(j => {
      const had = old.get(j.id); if (had && had.dataset.sig === sig(j)) return had;
      const t = document.createElement('template'); t.innerHTML = resultHtml(j, d).trim();
      const a = t.content.firstElementChild; a.dataset.sig = sig(j);
      if (had && !had.querySelector('.viz-keep')?.hidden) a.querySelector('.viz-keep')?.removeAttribute('hidden');
      wireResult(a, j); return a;
    });
    box.replaceChildren(...nodes);
  }
  // A service's raw reply ('Higgsfield said 403: {"detail":"not_enough_credits"}') said in plain words.
  function plainError(e) {
    const m = String(e).match(/"(?:detail|message|error)"\s*:\s*"([^"]+)"/), t = (m ? m[1] : String(e)).replace(/_/g, ' ');
    if (/not enough credits|insufficient (credits|balance)/i.test(t)) return 'the picture service is out of credits';
    return t;
  }
  function resultHtml(j, d) {
    const kept = d.kept.filter(k => k.job === j.id);
    const media = j.files.map(f => /\.(mp4|mov|webm)$/i.test(f)
      ? `<video src="${fileUrl(f)}" controls playsinline loop preload="metadata"></video>`
      : `<a href="${fileUrl(f)}" target="_blank" rel="noopener"><img src="${fileUrl(f)}" alt="${esc(j.prompt)}" loading="lazy"></a>`).join('');
    const status = j.status === 'failed' ? `${STATUS.failed}${j.error ? ': ' + esc(plainError(j.error)) : ''}` : esc(STATUS[j.status] ?? j.status);
    const working = ['drafting', 'queued', 'in_progress'].includes(j.status);
    const can = j.status === 'completed' || j.status === 'preview';
    return `<article class="viz-res ${esc(j.status)}" data-job="${esc(j.id)}">
      ${media || (working ? '<div class="viz-wait"><span></span></div>' : '')}
      <p class="viz-meta">${j.kind === 'video' ? 'Video' : 'Picture'}${j.label ? ` · ${esc(j.label)}` : ''} · ${esc(j.by)}${j.mode === 'live' && j.estimateUsd ? ` · about $${esc(j.estimateUsd.toFixed(2))}` : ''}${status ? ` · <span>${status}</span>` : ''}</p>
      ${j.prompt ? `<details><summary>Prompt</summary><p>${esc(j.prompt)}</p></details>` : ''}
      ${kept.map(k => `<p class="viz-kept">Kept by ${esc(k.by)}</p>`).join('')}
      ${can ? `<button class="viz-keepbtn">Keep</button><div class="viz-keep" hidden><select aria-label="Project to keep it in"></select><input class="viz-newname" placeholder="New project name" aria-label="New project name" hidden><button class="viz-keepgo primary">Keep here</button></div>` : ''}
    </article>`;
  }
  function wireResult(a, j) {
    const row = a.querySelector('.viz-keep'); if (!row) return;
    const fill = async () => {
      if (!S.projects) S.projects = await fetch('/api/projects').then(r => r.json()).then(x => x.projects || []).catch(() => []);
      const sel = row.querySelector('select');
      const list = [...S.projects]; if (S.opts.projectId && !list.some(p => p.id === S.opts.projectId)) list.unshift({ id: S.opts.projectId, name: S.opts.projectName || S.opts.projectId });
      sel.innerHTML = list.map(p => `<option value="${esc(p.id)}"${p.id === S.opts.projectId ? ' selected' : ''}>${esc(p.name)}</option>`).join('') + '<option value="__new">New project…</option>';
      const name = row.querySelector('.viz-newname'); sel.onchange = () => { name.hidden = sel.value !== '__new'; if (!name.hidden) name.focus(); }; sel.onchange();
    };
    if (!row.hidden) fill();
    a.querySelector('.viz-keepbtn').onclick = () => { row.hidden = !row.hidden; if (!row.hidden) fill(); };
    a.querySelector('.viz-keepgo').onclick = async (e) => {
      const btn = e.currentTarget, v = row.querySelector('select').value, project = v === '__new' ? row.querySelector('.viz-newname').value.trim() : v; if (!project) return;
      btn.disabled = true;
      const r = await post('/api/visualize/keep', { board: S.board, job: j.id, file: j.files[0], project });
      btn.disabled = false;
      if (r.ok) { row.hidden = true; say('Kept. It’s saved to your library.'); poll(true); } else say(r.error || 'Couldn’t keep it.');
    };
  }

  window.Visualize = { mount, unmount, draggable, addItem, isOpen: () => !!S };
})();
