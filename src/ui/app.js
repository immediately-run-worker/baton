// app.js — the dashboard (BATON_SPEC §14; rollout step 1: Ready and Providers). It polls
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
