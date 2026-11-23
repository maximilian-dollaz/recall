// Agents tab: hand something to an agent, read what it made, and answer when it needs your call.
// Used by the Agents tab in Recall (index.html). See app/agents.ts for how a run works.
(() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const post = (u, body) => fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const KIND = { research: 'Research', feasibility: 'Can it be done', people: 'People to talk to', draft: 'Draft message', plan: 'Next steps' };
  const FROM = { spark: 'From a reminder', item: 'From a save', piece: 'From a meeting', said: 'You asked' };
  const ago = (iso) => { const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); };
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
  // Step text: escaped, with paragraphs, simple lists and links kept.
  const prose = (t) => esc(String(t ?? '').replace(/<\/?cite[^>]*>/g, '')).split(/\n{2,}/).map((p) => {
    const lines = p.split('\n');
    if (lines.every((l) => /^\s*(?:[-*•]|\d+[.)])\s+/.test(l))) return `<ul>${lines.map((l) => `<li>${l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '')}</li>`).join('')}</ul>`;
    return `<p>${lines.join('<br>')}</p>`;
  }).join('').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(https?:\/\/[^\s<)]+?)(?=(?:&quot;|[.,;:!?])*(?:[\s<)]|$))/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');

  let timer = null, open = new Set(), focus = null, drafts = {};

  function step(r, s, i) {
    const key = `${r.id}:${i}`;
    return `<details class="ag-step" data-k="${key}"${open.has(key) ? ' open' : ''}>
      <summary><span class="ag-kind">${KIND[s.kind] || esc(s.kind)}</span><span class="ag-st">${esc(s.title)}${s.to && !s.title.toLowerCase().includes(s.to.toLowerCase()) ? ` <i>to ${esc(s.to)}</i>` : ''}</span></summary>
      <div class="ag-text">${prose(s.text)}</div>
      ${s.kind === 'draft' ? `<div class="ag-row"><button type="button" class="rm-second" data-copy="${key}">Copy</button><span class="ag-note">A draft. Nothing is sent.</span></div>` : ''}
    </details>`;
  }

  function card(r) {
    const waiting = r.status === 'needs-you' && r.ask;
    const busy = r.status === 'queued' || r.status === 'working';
    const state = waiting ? 'Needs your call' : r.status === 'working' ? 'Working' : r.status === 'queued' ? 'Starting' : r.status === 'done' ? 'Done' : r.status === 'stopped' ? 'Stopped' : "Didn't finish";
    const from = `${FROM[r.from?.kind] || ''}${r.from?.title && r.from.kind !== 'said' ? `: ${esc(r.from.title)}` : ''}${r.auto ? ' · started on its own' : ''}`;
    const srcs = (r.sources || []).slice(0, 8);
    return `<article class="ag-card ag-${r.status}${focus === r.id ? ' ag-focus' : ''}" data-id="${esc(r.id)}">
      <header><span class="ag-state">${state}${busy ? '<i class="ag-dots" aria-hidden="true"></i>' : ''}</span><span class="ag-when">${ago(r.updated)}</span></header>
      <h3>${esc(r.title)}</h3>
      <div class="ag-from">${from}</div>
      ${r.summary ? `<p class="ag-sum">${esc(r.summary)}</p>` : busy && !r.steps.length ? `<p class="ag-sum ag-dim">${esc(r.directive.slice(0, 200))}</p>` : ''}
      ${waiting ? `<div class="ag-ask"><div class="ag-q">${esc(r.ask.question)}</div>
        <div class="ag-opts">${r.ask.options.map((o) => `<button type="button" class="rm-second" data-answer="${esc(o)}">${esc(o)}</button>`).join('')}</div>
        <form class="ag-own"><input type="text" name="a" placeholder="Or say it your way" autocomplete="off" aria-label="Your answer" value="${esc(drafts[r.id] || '')}"><button type="submit" class="primary">Send</button></form></div>` : ''}
      ${busy && r.answers?.length ? `<p class="ag-said">You said: ${esc(r.answers[r.answers.length - 1].answer)}</p>` : ''}
      ${r.status === 'failed' ? `<p class="ag-err">${esc(r.error || 'Something went wrong.')}</p>` : ''}
      ${r.steps.length ? `<div class="ag-steps">${r.steps.map((s, i) => step(r, s, i)).join('')}</div>` : ''}
      ${srcs.length ? `<details class="ag-src"><summary>${r.sources.length} source${r.sources.length === 1 ? '' : 's'}</summary><ul>${srcs.map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a> <span>${esc(host(s.url))}</span></li>`).join('')}</ul></details>` : ''}
      <div class="ag-foot">${waiting ? '<button type="button" class="rm-quiet" data-close="done">Finish here</button>' : ''}${busy ? '<button type="button" class="rm-quiet" data-close="stopped">Stop</button>' : ''}${r.status === 'failed' ? '<button type="button" class="rm-second" data-retry="1">Try again</button>' : ''}${!busy ? '<button type="button" class="rm-quiet" data-remove="1">Remove</button>' : ''}</div>
    </article>`;
  }

  async function load(root, opts = {}) {
    if (opts.run) focus = opts.run;
    clearTimeout(timer);
    if (!root.querySelector('.ag-new')) {
      const wired = root._wired; root._wired = true;
      root.innerHTML = `<form class="ag-new"><textarea name="d" rows="2" placeholder="What do you want moved forward?" aria-label="What do you want moved forward?"></textarea>
        <div class="ag-row"><button class="primary" type="submit">Hand to an agent</button><label class="ag-auto"><input type="checkbox" name="auto"> Start an agent on new ideas from my notes and meetings</label></div>
        <p class="ag-hint small muted">An agent researches, checks if it can be done, finds people and drafts messages. It never sends anything. It stops and asks when it needs your call.</p>
        <p class="ag-msg small" role="status"></p></form><div class="ag-list" aria-live="polite"></div>`;
      const form = root.querySelector('.ag-new'), msg = root.querySelector('.ag-msg');
      form.onsubmit = async (e) => {
        e.preventDefault(); const d = form.d.value.trim(); if (!d) { form.d.focus(); return; }
        const b = form.querySelector('button'); b.disabled = true;
        const r = await post('/api/agents', { directive: d }).catch(() => null); b.disabled = false;
        if (!r?.ok) { msg.textContent = (await r?.json().catch(() => null))?.error || "That didn't go through. Try again."; return; }
        const run = await r.json(); form.d.value = ''; msg.textContent = ''; focus = run.id; load(root);
      };
      form.auto.onchange = () => post('/api/agents/auto', { on: form.auto.checked });
      if (!wired) {
      root.addEventListener('toggle', (e) => { const k = e.target?.dataset?.k; if (k) e.target.open ? open.add(k) : open.delete(k); }, true);
      root.addEventListener('input', (e) => { const c = e.target.closest?.('.ag-card'); if (c && e.target.name === 'a') drafts[c.dataset.id] = e.target.value; });
      root.addEventListener('submit', async (e) => {
        const own = e.target.closest('.ag-own'); if (!own) return; e.preventDefault();
        const a = own.a.value.trim(); if (a) send(root, own.closest('.ag-card'), a);
      });
      root.addEventListener('click', async (e) => {
        const cardEl = e.target.closest('.ag-card'); if (!cardEl) return; const id = cardEl.dataset.id;
        const t = e.target.closest('button'); if (!t) return;
        if (t.dataset.answer) return send(root, cardEl, t.dataset.answer);
        if (t.dataset.copy) { const [rid, i] = t.dataset.copy.split(':'); const s = root._runs?.find((x) => x.id === rid)?.steps[+i]; try { await navigator.clipboard.writeText(s?.text || ''); t.textContent = 'Copied'; } catch { t.textContent = 'Select and copy'; } return; }
        if (t.dataset.close) { t.disabled = true; await post('/api/agents/close', { id, as: t.dataset.close }); return load(root); }
        if (t.dataset.retry) { t.disabled = true; await post('/api/agents/retry', { id }); return load(root); }
        if (t.dataset.remove) { t.disabled = true; cardEl.classList.add('rm-out'); await post('/api/agents/remove', { id }); return load(root); }
      });
      }
    }
    const d = await (await fetch('/api/agents')).json();
    root._runs = d.runs;
    root.querySelector('[name=auto]').checked = !!d.auto;
    const listEl = root.querySelector('.ag-list');
    // Don't redraw under someone typing an answer, unless the cards themselves changed.
    const sig = JSON.stringify(d.runs.map((r) => [r.id, r.status, r.steps.length, r.updated]));
    if (sig !== listEl.dataset.sig) {
      listEl.dataset.sig = sig;
      const typing = document.activeElement?.closest?.('.ag-card')?.dataset.id;
      listEl.innerHTML = d.runs.length ? d.runs.map(card).join('') : '<p class="rm-done">Nothing handed over yet. Type above, or tap “Hand to an agent” on a reminder.</p>';
      if (typing) listEl.querySelector(`.ag-card[data-id="${typing}"] input[name=a]`)?.focus();
    }
    // Opened for one run (a notification, a Today row, a reminder): light it and bring it into view.
    if (opts.run) { listEl.querySelectorAll('.ag-focus').forEach((c) => c.classList.remove('ag-focus')); const f = listEl.querySelector(`.ag-card[data-id="${opts.run}"]`); if (f) { f.classList.add('ag-focus'); f.scrollIntoView({ block: 'start', behavior: 'smooth' }); } }
    window.setAgentCount?.(d.waiting);
    if (d.runs.some((r) => r.status === 'queued' || r.status === 'working') && !root.closest('[hidden]')) timer = setTimeout(function again() { load(root).catch(() => { timer = setTimeout(again, 5000); }); }, 5000); // a failed fetch (a phone waking up) tries again
  }

  async function send(root, cardEl, a) {
    cardEl.querySelectorAll('button, input').forEach((b) => b.disabled = true);
    const id = cardEl.dataset.id; delete drafts[id];
    const r = await post('/api/agents/answer', { id, answer: a }).catch(() => null);
    if (!r?.ok) cardEl.querySelectorAll('button, input').forEach((b) => b.disabled = false);
    load(root);
  }

  window.loadAgents = (root, opts) => load(root, opts).catch(() => { root.innerHTML = '<p class="small muted">Agents didn’t load. Pull down to try again.</p>'; });
  // "Hand to an agent" from anywhere else in Recall (a reminder, a saved item).
  window.handToAgent = async (from, directive) => { const r = await post('/api/agents', { from, directive }).catch(() => null); return r?.ok ? r.json() : null; };
})();
