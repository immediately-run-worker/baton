// app.js — the dashboard (BATON_SPEC §14): Needs you, Running, Timeline, Ready, Providers,
// Workers and Suspensions, with the owner's actions (status request, release, force-reap,
// accept a held history, suspend and lift). It polls
// GET /v1/ui/state every 10 seconds and renders with textContent only (§10.4): no markup is
// ever built from server text.

const POLL_MS = 10_000;
let state = null;

/** An element with text, attributes and children; text always goes through textContent. */
function el(tag, { text, cls, attrs } = {}, ...children) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = String(text);
  if (cls) node.className = cls;
  for (const [k, v] of Object.entries(attrs ?? {})) node.setAttribute(k, v);
  for (const c of children) if (c) node.append(c);
  return node;
}

const fmtTime = (ms) => (ms == null ? '—' : new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC');
const short = (sha) => (sha ? sha.slice(0, 8) : '—');

function renderHead() {
  const h = state.head;
  document.getElementById('head').textContent = h
    ? `Board at docs@${short(h.sha)} · ${h.item_count} live items · received ${fmtTime(h.received_at)}`
    : 'No board snapshot yet: the sync has not posted.';
}

function renderReady() {
  const tier = document.getElementById('tier').value;
  const order = state.ready_by_tier?.[tier] ?? [];
  const byId = new Map(state.ready.map((r) => [r.id, r]));
  const body = document.getElementById('ready');
  body.replaceChildren();
  order.forEach((id, i) => {
    const r = byId.get(id);
    if (!r) return;
    const reqs = el('td');
    if (r.operator_only) reqs.append(el('span', { text: 'operator', cls: 'tag op' }));
    if (r.requires_clause === 'absent') reqs.append(el('span', { text: 'no clause', cls: 'muted' }));
    else if (!r.requires.length && !r.operator_only) reqs.append(el('span', { text: 'none', cls: 'muted' }));
    for (const name of r.requires) reqs.append(el('span', { text: name, cls: 'tag' }));
    body.append(el('tr', {},
      el('td', { text: i + 1, cls: 'num' }),
      el('td', {}, el('span', { text: r.id, cls: 'muted' }), document.createTextNode(' '), el('a', { text: r.title, attrs: { href: r.url, target: '_blank', rel: 'noopener' } })),
      el('td', { text: r.tier ?? 'untiered' }),
      reqs,
      el('td', { text: r.rank_reason, cls: 'muted' })));
  });
  if (!order.length) body.append(el('tr', {}, el('td', { text: 'Nothing is ready under this ceiling.', attrs: { colspan: '5' }, cls: 'muted' })));
}

function renderProviders() {
  const box = document.getElementById('providers');
  box.replaceChildren();
  for (const p of state.providers) {
    const card = el('div', { cls: 'card' }, el('h3', { text: p.name }), el('div', { text: `${p.id} · ${p.billing}`, cls: 'muted' }));
    if (p.window_limits) {
      card.append(el('div', { text: `Limits: ${Object.entries(p.window_limits).map(([w, f]) => `${Math.round(f * 100)}% per ${w}`).join(', ')}`, cls: 'muted' }));
    }
    for (const pk of p.peaks) {
      const line = el('div');
      line.append(el('span', { text: pk.in_peak ? 'Peak now' : 'Off-peak now', cls: pk.in_peak ? 'peak' : 'offpeak' }));
      line.append(document.createTextNode(` (${pk.schedule}) · changes ${fmtTime(pk.next_change)}`));
      card.append(line);
    }
    if (!p.peaks.length) card.append(el('div', { text: 'No peak schedule', cls: 'muted' }));
    const limited = p.models.filter((m) => m.monthly_limit_usd != null);
    if (limited.length) card.append(el('div', { text: `${limited.length} model(s) with a monthly limit`, cls: 'muted' }));
    box.append(card);
  }
  if (!state.providers.length) box.append(el('p', { text: 'No provider data yet.', cls: 'muted' }));
}

/** An owner action (R-BTN-16: a JSON body from this Origin; the Access cookie authenticates it).
 *  The reply's error, if any, goes to the footer; the next poll shows the result. */
async function act(path, body) {
  const status = document.getElementById('status');
  try {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.message ?? `HTTP ${res.status}`);
    status.textContent = 'Done.';
    poll();
  } catch (e) {
    status.textContent = `Could not ${path.split('/').pop()}: ${e.message}`;
  }
}

const button = (text, onClick) => {
  const b = el('button', { text, attrs: { type: 'button' } });
  b.addEventListener('click', onClick);
  return b;
};

/** A link only to GitHub: the server builds it from validated parts (§6.8); this is belt and braces. */
const githubLink = (text, href) => (typeof href === 'string' && href.startsWith('https://github.com/')
  ? el('a', { text, attrs: { href, target: '_blank', rel: 'noopener' } })
  : el('span', { text }));

function renderWorkers() {
  const body = document.getElementById('workers');
  body.replaceChildren();
  for (const w of state.workers) {
    const who = el('td', {}, el('div', { text: w.hostname }), el('div', { text: `${w.session_name} · ${w.harness} · ${w.kind} · #${w.id}`, cls: 'muted' }));
    // §14: tier ceiling, capabilities, providers and lease timeout.
    const caps = (w.capabilities ?? []).map((c) => c.capability).join(', ') || 'no capabilities';
    const provs = (w.providers ?? []).map((p) => `${p.prefix}→${p.provider_id}`).join(', ') || 'no known accounts';
    who.append(el('div', { text: `ceiling ${w.tier_ceiling} · lease ${Math.round(w.lease_timeout_ms / 60_000)} min`, cls: 'muted' }));
    who.append(el('div', { text: caps, cls: 'muted' }));
    who.append(el('div', { text: provs, cls: 'muted' }));
    if (w.transcript_url) who.append(el('div', {}, githubLink('transcript', w.transcript_url)));
    const st = w.reaped_at != null ? 'reaped' : w.alive ? 'alive' : 'lease lapsed';
    const stateCell = el('td', {}, el('div', { text: st, cls: w.alive ? 'alive' : 'dead' }), el('div', { text: `seen ${fmtTime(w.last_seen_at)}`, cls: 'muted' }), el('div', { text: `active ${fmtTime(w.last_activity_at)}`, cls: 'muted' }));
    const claim = el('td', { text: w.claim ? w.claim.work_item_id : '—' });
    const a = w.activity;
    const activity = el('td', { text: a ? [a.kind, a.label].filter(Boolean).join(': ') : '—', cls: a ? '' : 'muted' });
    let report = '—';
    if (w.last_report) {
      try {
        const p = JSON.parse(w.last_report.payload_json);
        const doing = p.activity ? [p.activity.kind, p.activity.label].filter(Boolean).join(': ') : 'idle';
        report = `${p.text ?? doing} (${fmtTime(w.last_report.sent_at)})`;
      } catch {
        report = 'unreadable';
      }
    }
    const actions = el('td');
    if (w.reaped_at == null) {
      actions.append(button('Status', () => act('/v1/ui/messages', { to_worker_id: w.id, kind: 'status_request' })));
      if (w.claim) {
        actions.append(button('Release', () => {
          if (confirm(`Ask worker #${w.id} to release ${w.claim.work_item_id}?`)) {
            act('/v1/ui/messages', { to_worker_id: w.id, kind: 'release', payload: { work_item_id: w.claim.work_item_id, reason: 'requested' } });
          }
        }));
      }
    }
    body.append(el('tr', {}, who, el('td', { text: `${w.model_id ?? '—'}${w.model_provider_id ? ` (${w.model_provider_id})` : ''}` }), stateCell, claim, activity, el('td', { text: report, cls: 'muted' }), actions));
  }
  if (!state.workers.length) body.append(el('tr', {}, el('td', { text: 'No worker has sent a heartbeat.', attrs: { colspan: '7' }, cls: 'muted' })));
}

function renderSuspensions() {
  const list = document.getElementById('suspensions');
  list.replaceChildren();
  for (const s of state.suspensions) {
    const when = s.starts_at > state.server_time ? `from ${fmtTime(s.starts_at)}` : 'in force';
    const li = el('li', { text: `${s.provider_id}${s.model_id ? ` / ${s.model_id}` : ''} · ${s.mode} · ${when}${s.ends_at ? ` until ${fmtTime(s.ends_at)}` : ''}${s.reason ? ` · ${s.reason}` : ''}` });
    li.append(button('Lift', () => act(`/v1/ui/suspensions/${s.id}/lift`)));
    list.append(li);
  }
  if (!state.suspensions.length) list.append(el('li', { text: 'No account is suspended.', cls: 'muted' }));
  const select = document.getElementById('s-provider');
  const chosen = select.value;
  select.replaceChildren(...state.providers.map((p) => el('option', { text: p.name, attrs: { value: p.id } })));
  if (chosen) select.value = chosen;
}

/** datetime-local is the viewer's local time; empty means "now" (start) or "until lifted" (end). */
const localMs = (id) => {
  const v = document.getElementById(id).value;
  return v ? new Date(v).getTime() : undefined;
};

document.getElementById('suspend').addEventListener('submit', (e) => {
  e.preventDefault();
  const body = { provider_id: document.getElementById('s-provider').value, mode: document.getElementById('s-mode').value };
  const model = document.getElementById('s-model').value.trim();
  const reason = document.getElementById('s-reason').value.trim();
  if (model) body.model_id = model;
  if (reason) body.reason = reason;
  const starts = localMs('s-start');
  const ends = localMs('s-end');
  if (starts !== undefined) body.starts_at = starts;
  if (ends !== undefined) body.ends_at = ends;
  if (body.mode === 'stop' && !confirm('Stop sends a release to every holder on this account. Continue?')) return;
  act('/v1/ui/suspensions', body);
});

const minutes = (ms) => `${Math.round(ms / 60_000)} min`;

function renderRunning() {
  const body = document.getElementById('running');
  body.replaceChildren();
  for (const c of state.running) {
    const item = el('td', {}, el('div', { text: c.work_item_id }), el('div', { text: c.title ?? '', cls: 'muted' }));
    if (c.stalled) item.append(el('div', { text: 'stalled: no activity for 2 h', cls: 'stalled' }));
    const worker = el('td', {}, el('div', { text: `${c.hostname} · #${c.worker_id}` }), el('div', { text: c.alive ? 'alive' : 'silent', cls: c.alive ? 'alive' : 'dead' }));
    const events = el('td', { cls: 'muted' });
    for (const e of c.events.slice(-3)) events.append(el('div', { text: `${fmtTime(e.at)} ${e.kind}` }));
    const open = c.activities.filter((a) => a.ended_at == null).at(-1);
    if (open) events.append(el('div', { text: `now: ${[open.kind, open.label].filter(Boolean).join(': ')}` }));
    const actions = el('td');
    actions.append(button('Force-reap', () => {
      // §14: the confirmation names the worker's last-seen and last-activity times.
      const msg = `Reap ${c.work_item_id} from ${c.hostname} #${c.worker_id}?\nLast seen ${fmtTime(c.last_seen_at)}; last activity ${fmtTime(c.last_activity_at)}.` +
        (c.alive ? `\nThe worker is alive: the item waits until its sidecar confirms the fence (or ${minutes(c.lease_timeout_ms)} of silence).` : '');
      if (confirm(msg)) act(`/v1/ui/claims/${c.id}/reap`, { confirm: true });
    }));
    body.append(el('tr', {}, item, worker, el('td', { text: fmtTime(c.claimed_at) }), el('td', { text: c.reap_at == null ? '—' : fmtTime(c.reap_at) }), events, actions));
  }
  if (!state.running.length) body.append(el('tr', {}, el('td', { text: 'No active claims.', attrs: { colspan: '6' }, cls: 'muted' })));
}

function renderTimeline() {
  const box = document.getElementById('timeline');
  box.replaceChildren();
  const { from, to, lanes } = state.timeline;
  const span = to - from;
  const pct = (t) => `${Math.max(0, Math.min(100, ((t - from) / span) * 100))}%`;
  const width = (a, b) => `${Math.max(0.5, ((Math.min(b ?? to, to) - Math.max(a, from)) / span) * 100)}%`;
  for (const lane of lanes) {
    const track = el('div', { cls: 'track' });
    for (const c of lane.claims) {
      const bar = el('div', { cls: 'bar', attrs: { title: `${c.work_item_id} · ${c.status}${c.end_reason ? ` (${c.end_reason})` : ''}` } });
      // Positions go through the CSSOM: no markup is built and no style attribute is parsed (§10.4).
      bar.style.left = pct(c.claimed_at);
      bar.style.width = width(c.claimed_at, c.ended_at);
      track.append(bar);
      for (const a of c.activities) {
        const seg = el('div', { cls: a.outcome === 'failed' ? 'seg failed' : 'seg', attrs: { title: `${a.kind}${a.label ? `: ${a.label}` : ''}${a.outcome ? ` · ${a.outcome}` : ''}` } });
        seg.style.left = pct(a.started_at);
        seg.style.width = width(a.started_at, a.ended_at);
        track.append(seg);
      }
    }
    box.append(el('div', { cls: 'lane' }, el('div', { text: `${lane.hostname} · ${lane.session_name}`, cls: 'muted' }), track));
  }
  if (!lanes.length) box.append(el('p', { text: 'No alive workers.', cls: 'muted' }));
}

function renderNeeds() {
  const n = state.needs_you;
  const list = document.getElementById('needs');
  list.replaceChildren();
  for (const c of n.unconfirmed) list.append(el('li', { text: `${c.work_item_id}: completed ${fmtTime(c.ended_at)} (${c.end_reason}) at ${short(c.ended_at_sha)}, not confirmed by git after 6 h` }));
  for (const m of n.unacknowledged_releases) {
    let item = '?';
    try {
      item = JSON.parse(m.payload_json).work_item_id;
    } catch {
      // shown without the item
    }
    list.append(el('li', { text: `Release of ${item} to worker #${m.to_worker_id}: ${m.delivered_at ? `delivered ${fmtTime(m.delivered_at)}` : 'not yet delivered'}, unacknowledged` }));
  }
  for (const c of n.fence_pending) list.append(el('li', { text: `${c.work_item_id}: reaped ${fmtTime(c.ended_at)}, waiting for worker #${c.worker_id} to confirm its fence` }));
  for (const w of n.stale_skills) list.append(el('li', { text: `${w.hostname} · ${w.session_name}: skills version ${w.skills_version}, below the minimum` }));
  for (const h of n.held_items) list.append(el('li', { text: `${h.work_item_id}: held (${h.hold_reason ?? 'owner'})` }));
  for (const h of state.held) {
    const li = el('li', { text: `Rewritten history docs@${short(h.sha)} held; accepted automatically ${fmtTime(h.auto_accept_at)}` });
    li.append(button('Accept now', () => {
      if (confirm(`Accept docs@${short(h.sha)} as the board?`)) act('/v1/ui/board/accept', { sha: h.sha });
    }));
    list.append(li);
  }
  document.getElementById('needs-section').hidden = !list.children.length;
}

function renderHeld() {
  const section = document.getElementById('held-section');
  const list = document.getElementById('held');
  list.replaceChildren();
  for (const h of state.held) {
    list.append(el('li', { text: `docs@${short(h.sha)} (parent ${short(h.parent_sha)}) held ${fmtTime(h.received_at)}; accepted automatically from ${fmtTime(h.auto_accept_at)}` }));
  }
  section.hidden = !state.held.length;
}

function render() {
  renderHead();
  renderReady();
  renderProviders();
  renderNeeds();
  renderRunning();
  renderTimeline();
  renderWorkers();
  renderSuspensions();
  renderHeld();
  document.getElementById('status').textContent = `Updated ${fmtTime(state.server_time)}`;
}

let latest = 0;

/** One poll, bounded by the poll interval. Only the newest poll's answer is drawn, so a slow
 *  response can never overwrite a newer one. */
async function poll() {
  const mine = ++latest;
  try {
    const res = await fetch('/v1/ui/state', { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(POLL_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const next = await res.json();
    if (mine !== latest) return;
    state = next;
    render();
  } catch (e) {
    if (mine !== latest) return;
    document.getElementById('status').textContent = `Could not load the state: ${e.message}. Retrying.`;
  }
}

document.getElementById('tier').addEventListener('change', () => state && renderReady());
poll();
setInterval(poll, POLL_MS);
