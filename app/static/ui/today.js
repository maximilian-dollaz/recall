// Today tab: your way of being for the day, your current work, and what is waiting on you. See app/today.ts.
(() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const thumb = (f) => '/thumb/' + encodeURIComponent(f) + '?s=720';
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  async function load(root) {
    const d = await (await fetch('/api/today')).json();
    const date = new Date(d.day + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
    const w = d.waiting, rows = [];
    for (const a of w.agents) rows.push(`<button type="button" class="td-row td-call" data-go="agent" data-id="${esc(a.id)}"><b>Your call: ${esc(a.title)}</b><span>${esc(a.question)}</span></button>`);
    if (w.clarify) rows.push(`<button type="button" class="td-row" data-go="cues"><b>${plural(w.clarify, 'question', 'questions')} in Clarify</b><span>Where a save belongs, or whether it is private.</span></button>`);
    if (w.reminders) rows.push(`<button type="button" class="td-row" data-go="reminders"><b>${plural(w.reminders, 'reminder', 'reminders')} for today</b><span>${w.landing ? `${w.landing} still landing.` : 'Lived it, or still landing.'}</span></button>`);
    for (const b of w.back) rows.push(`<button type="button" class="td-row" data-go="item" data-id="${esc(b.id)}"><b>Brought back: ${esc(b.title)}</b><span>You asked for this back.</span></button>`);
    if (w.agentsWorking) rows.push(`<button type="button" class="td-row td-quiet" data-go="agents"><b>${plural(w.agentsWorking, 'agent', 'agents')} working</b><span>Nothing needed from you yet.</span></button>`);
    root.innerHTML = `<p class="td-date">${esc(date)}</p>
      <section class="td-sec"><h2 class="td-h">Way of being</h2>${d.being
        ? `<a class="td-being" href="/remind/${esc(d.being.id)}"><blockquote>“${esc(d.being.words)}”</blockquote>${d.being.when_then ? `<p>${esc(d.being.when_then)}</p>` : ''}</a>`
        : '<p class="td-none">Nothing yet. Say how you want to be in a voice note, with the word “remind”, and it shows here.</p>'}</section>
      <section class="td-sec"><h2 class="td-h">Current work</h2>${d.work.length
        ? `<div class="td-work">${d.work.map((p) => `<button type="button" class="td-proj" data-go="project" data-id="${esc(p.id)}"><span class="td-mini">${[0, 1, 2, 3].map((i) => p.thumbs[i] ? `<i style="background-image:url('${thumb(p.thumbs[i])}')"></i>` : '<i></i>').join('')}</span><b>${esc(p.name)}</b><small>${plural(p.count, 'item', 'items')}</small></button>`).join('')}</div>`
        : '<p class="td-none">No projects yet. Save something and say what it is for.</p>'}</section>
      <section class="td-sec"><h2 class="td-h">Waiting on you</h2>${rows.length ? `<div class="td-rows">${rows.join('')}</div>` : '<p class="td-none">Nothing is waiting on you.</p>'}</section>`;
    root.onclick = (e) => {
      const b = e.target.closest('[data-go]'); if (!b) return; const go = b.dataset.go, id = b.dataset.id;
      if (go === 'agent') return window.openAgents?.(id);
      if (go === 'project') { window.showTab?.('find'); return window.openProject?.(id); }
      if (go === 'item') { window.showTab?.('find'); return window.openItem?.(id); }
      window.showTab?.(go);
    };
  }
  window.loadToday = (root) => load(root).catch(() => { root.innerHTML = '<p class="small muted">Today didn’t load. Pull down to try again.</p>'; });
})();
