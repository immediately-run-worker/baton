// sessionUsage.mjs — what a session spent, in tokens, per work item
// (plans/review-gate/token-usage).
//
// The question is "what did this work item cost?". The unit is the item, not the PR: one
// item often lands several PRs, and which PR a given call served is not recoverable from
// the records (the item's PRs are already listed in its `prs:` frontmatter). A PR with no
// roadmap item is its own unit, labelled `<repo>#<n>`. Most of the answer is model tokens, and both
// harnesses already write every API call's usage to disk; nothing read it. Asking an agent
// for its own token count gets a guess, so the numbers here come only from the harness's
// own records:
//
//   * Claude Code — the session transcript `<projects>/<dir>/<session>.jsonl`. Every
//     assistant line carries `message.usage`; one API call is written once per content
//     block, so lines are deduplicated by `message.id`. Subagents (the review gate's
//     reviewers among them) write `<session>/subagents/agent-<id>.jsonl`, with the agent
//     type in the sibling `.meta.json`. Older builds wrote them into the main file as
//     `isSidechain` lines; both shapes are read.
//   * opencode — `opencode export <session>` (the public CLI, not the private SQLite
//     schema, which has already changed once). Assistant messages carry `tokens`
//     {input, output, reasoning, cache: {read, write}}; a `task` tool part names the child
//     session a subagent ran in (`state.metadata.sessionId`), and children are followed.
//
// A checkpoint takes the calls in a window — after the session's previous checkpoint, up
// to now — so a session that lands three items records three disjoint windows and nothing is
// counted twice. Reviewer subagents fall inside the implementer's window because they are
// the implementer's subagents in both harnesses.
//
// Token classes are kept apart because they are priced apart: uncached input, cache writes
// (5-minute and 1-hour TTL), cache reads, output. Output includes reasoning/thinking
// tokens, which every provider bills as output.
//
// Pure: callers pass file contents and JSON in. The CLI (scripts/session-usage.mjs) does
// the I/O.

export const TOKEN_KEYS = ["input", "cacheWrite5m", "cacheWrite1h", "cacheRead", "output"];

const zero = () => ({ calls: 0, input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 });

/**
 * Usage records from one Claude Code transcript (JSONL text).
 * @param {string} text  the transcript
 * @param {string} scope "main", or "sub:<agentType>" for a subagent file
 * @returns {{id, at, model, scope, input, cacheWrite5m, cacheWrite1h, cacheRead, output}[]}
 */
export function claudeRecords(text, scope = "main") {
  const byId = new Map();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type !== "assistant" || !e.message?.usage) continue;
    const model = e.message.model;
    if (!model || model === "<synthetic>") continue;
    const u = e.message.usage;
    const id = e.message.id || e.requestId || e.uuid;
    const cc = u.cache_creation ?? {};
    const has1h = typeof cc.ephemeral_1h_input_tokens === "number";
    const w1h = has1h ? cc.ephemeral_1h_input_tokens : 0;
    const w5m = typeof cc.ephemeral_5m_input_tokens === "number"
      ? cc.ephemeral_5m_input_tokens
      : (u.cache_creation_input_tokens ?? 0) - w1h;
    const rec = {
      id, at: e.timestamp, model,
      // An in-file sidechain line is a subagent's call in the older layout.
      scope: e.isSidechain && scope === "main" ? "sub" : scope,
      input: u.input_tokens ?? 0,
      cacheWrite5m: Math.max(0, w5m),
      cacheWrite1h: w1h,
      cacheRead: u.cache_read_input_tokens ?? 0,
      output: u.output_tokens ?? 0,
    };
    const prev = byId.get(id);
    // Repeated lines carry the same usage; keep the largest output in case a build
    // writes a partial count on an early block.
    if (!prev || rec.output > prev.output) byId.set(id, prev ? { ...rec, at: prev.at } : rec);
  }
  return [...byId.values()];
}

/** The agent type from a Claude Code subagent `.meta.json`, as a scope. */
export function claudeSubagentScope(metaText) {
  try {
    const t = JSON.parse(metaText)?.agentType;
    return t ? `sub:${t}` : "sub";
  } catch {
    return "sub";
  }
}

/**
 * Usage records from one `opencode export` document, plus the child sessions it spawned.
 * @returns {{records: object[], children: {sessionId: string, scope: string}[]}}
 */
export function opencodeRecords(exported, scope = "main") {
  const records = [];
  const children = [];
  for (const m of exported?.messages ?? []) {
    const info = m.info ?? {};
    if (info.role === "assistant" && info.tokens) {
      const t = info.tokens;
      const ms = info.time?.completed ?? info.time?.created;
      records.push({
        id: info.id,
        at: typeof ms === "number" ? new Date(ms).toISOString() : null,
        model: info.providerID ? `${info.providerID}/${info.modelID}` : info.modelID ?? "unknown",
        scope,
        input: t.input ?? 0,
        // opencode does not say which TTL a write used; Anthropic's default is 5 minutes
        // and the other providers in use have a single write price.
        cacheWrite5m: t.cache?.write ?? 0,
        cacheWrite1h: 0,
        cacheRead: t.cache?.read ?? 0,
        output: (t.output ?? 0) + (t.reasoning ?? 0),
      });
    }
    for (const p of m.parts ?? []) {
      if (p.type !== "tool" || p.tool !== "task") continue;
      const sid = p.state?.metadata?.sessionId;
      if (!sid) continue;
      const agent = p.state?.input?.subagent_type;
      children.push({ sessionId: sid, scope: agent ? `sub:${agent}` : "sub" });
    }
  }
  return { records, children };
}

/** Records with `since < at <= through` (ISO strings; `since` null means from the start). */
export function inWindow(records, since, through) {
  const lo = since ? Date.parse(since) : -Infinity;
  const hi = through ? Date.parse(through) : Infinity;
  return records.filter((r) => {
    const t = Date.parse(r.at);
    return Number.isFinite(t) && t > lo && t <= hi;
  });
}

/** The model-cell suffix of a call billed at a provider's off-peak rate. */
export const OFF_PEAK = " (off-peak)";

/**
 * Whether a call at `at` (ISO) falls outside its price entry's `offPeak.peakUtc` windows:
 * `days` are UTC weekdays (0 = Sunday), `hours` are [start, end) UTC hour pairs. An entry
 * without `offPeak`, or a call with no timestamp, is never off-peak — the higher rate is
 * the safe default (DeepSeek's Chinese public holidays are off-peak but not modelled, so
 * they overstate).
 */
export function isOffPeak(at, entry) {
  const w = entry?.offPeak?.peakUtc;
  const t = Date.parse(at);
  if (!w || !Number.isFinite(t)) return false;
  const d = new Date(t);
  if (!w.days.includes(d.getUTCDay())) return true;
  const h = d.getUTCHours();
  return !w.hours.some(([lo, hi]) => h >= lo && h < hi);
}

/**
 * Sum records into one bucket per (scope, model), main first. With `prices`, a call
 * billed at its model's off-peak rate goes to its own bucket, model cell suffixed
 * `(off-peak)`, so the ledger row carries the rate it was billed at and repricing keeps it.
 */
export function aggregate(records, prices = null) {
  const m = new Map();
  for (const r of records) {
    const model = prices && isOffPeak(r.at, priceFor(r.model, prices)) ? r.model + OFF_PEAK : r.model;
    const k = `${r.scope}\u0000${model}`;
    const b = m.get(k) ?? { scope: r.scope, model, ...zero() };
    b.calls += 1;
    for (const key of TOKEN_KEYS) b[key] += r[key];
    m.set(k, b);
  }
  return [...m.values()].sort((a, b) =>
    (a.scope === "main" ? 0 : 1) - (b.scope === "main" ? 0 : 1)
    || a.scope.localeCompare(b.scope) || a.model.localeCompare(b.model));
}

// ---------------------------------------------------------------- pricing

/**
 * The price entry for a model id: the first whose `match` regex hits. Prices are USD per
 * million tokens. A missing cache-write price defaults to the Anthropic multipliers on
 * input (1.25x for 5 minutes, 2x for 1 hour); a missing cache-read price to input.
 */
export function priceFor(model, prices) {
  for (const p of prices?.models ?? []) {
    if (new RegExp(p.match, "i").test(model)) return p;
  }
  return null;
}

/**
 * USD for one bucket, or null when its model has no price. A model cell suffixed
 * `(off-peak)` is billed at its entry's `offPeak.factor` (1 when the entry has none).
 */
export function costOf(bucket, prices) {
  const offPeak = bucket.model.endsWith(OFF_PEAK);
  const p = priceFor(offPeak ? bucket.model.slice(0, -OFF_PEAK.length) : bucket.model, prices);
  if (!p || typeof p.input !== "number" || typeof p.output !== "number") return null;
  const f = offPeak ? p.offPeak?.factor ?? 1 : 1;
  const w5 = p.cacheWrite5m ?? p.input * 1.25;
  const w1 = p.cacheWrite1h ?? p.input * 2;
  const rd = p.cacheRead ?? p.input;
  const usd = f * (bucket.input * p.input + bucket.cacheWrite5m * w5 + bucket.cacheWrite1h * w1
    + bucket.cacheRead * rd + bucket.output * p.output) / 1e6;
  return Math.round(usd * 1e4) / 1e4;
}

// ---------------------------------------------------------------- the ledger

export const LEDGER_HEADER =
  "| date | session | harness | from | through | item | scope | model | calls | input | cache write 5m | cache write 1h | cache read | output | usd |";
export const LEDGER_RULE = "|" + "---|".repeat(15);

const cell = (v) => String(v ?? "—").replace(/\|/g, "\\|");

/** The earliest call timestamp among records, or null. */
export function firstCall(records) {
  let best = null;
  for (const r of records) if (r.at && (!best || Date.parse(r.at) < Date.parse(best))) best = r.at;
  return best;
}

/**
 * Ledger rows for one checkpoint, one per (scope, model) bucket. `from` is the window's
 * first call (`ctx.firstCall`), so `through − from` is the time the session worked in it;
 * the next checkpoint's window starts at `through`, not at `from`.
 * `withholdModel` writes `withheld` in the model cell (the price is still computed from
 * the real id, locally): Claude Code on the web forbids the model id in pushed artifacts,
 * and the session URL resolves it for whoever needs it.
 */
export function toRows(buckets, ctx, prices, { withholdModel = false } = {}) {
  return buckets.map((b) => {
    const usd = costOf(b, prices);
    return `| ${[
      ctx.through.slice(0, 10), ctx.session, ctx.harness, ctx.firstCall ?? "—", ctx.through,
      ctx.item, b.scope,
      withholdModel ? "withheld" : b.model,
      b.calls, b.input, b.cacheWrite5m, b.cacheWrite1h, b.cacheRead, b.output,
      usd === null ? "—" : usd.toFixed(4),
    ].map(cell).join(" | ")} |`;
  });
}

/** Parse the ledger's rows back out of the page (rows that do not fit are skipped). */
export function parseLedger(text) {
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("| ") || line.startsWith("| date ")) continue;
    const c = line.slice(2, -2).split(/(?<!\\) \| /).map((s) => s.replace(/\\\|/g, "|").trim());
    if (c.length !== 15 || !/^\d{4}-\d{2}-\d{2}$/.test(c[0])) continue;
    const n = (s) => (s === "—" ? 0 : Number(s));
    rows.push({
      date: c[0], session: c[1], harness: c[2], from: /^\d{4}-/.test(c[3]) ? c[3] : null, through: c[4],
      item: c[5], scope: c[6], model: c[7], calls: n(c[8]), input: n(c[9]), cacheWrite5m: n(c[10]),
      cacheWrite1h: n(c[11]), cacheRead: n(c[12]), output: n(c[13]), usd: c[14] === "—" ? null : Number(c[14]),
    });
  }
  return rows;
}

/** The end of this session's latest checkpoint in the ledger, or null for none. */
export function lastCheckpoint(rows, session) {
  let best = null;
  for (const r of rows) {
    if (r.session === session && (!best || Date.parse(r.through) > Date.parse(best))) best = r.through;
  }
  return best;
}

/**
 * A ledger row's dollars. With `prices`, a row whose model is known is priced again from
 * the current table, so a corrected price reaches every total built from the ledger. A
 * `withheld` model (Claude Code on the web) cannot be repriced and keeps the dollars
 * recorded with it, as does a model the table does not price. Null means unpriced.
 */
export function rowUsd(r, prices) {
  if (prices && r.model !== "withheld") {
    const usd = costOf(r, prices);
    if (usd !== null) return usd;
  }
  return r.usd;
}

/**
 * Roll ledger rows up per work item (`by` = "item") or per model cell (`by` = "model";
 * `withheld` gathers Claude Code on the web).
 */
export function rollUp(rows, by = "item", prices = null) {
  const m = new Map();
  for (const r of rows) {
    const key = by === "model" ? r.model : r.item;
    const u = m.get(key) ?? { unit: key, sessions: new Set(), windows: new Map(), ...zero(), usd: 0, unpriced: 0 };
    u.sessions.add(r.session);
    if (r.from) u.windows.set(`${r.session}\u0000${r.through}`, Math.max(0, Date.parse(r.through) - Date.parse(r.from)));
    u.calls += r.calls;
    for (const k of TOKEN_KEYS) u[k] += r[k];
    const usd = rowUsd(r, prices);
    if (usd === null) u.unpriced += r.input + r.cacheWrite5m + r.cacheWrite1h + r.cacheRead + r.output;
    else u.usd += usd;
    m.set(key, u);
  }
  return [...m.values()].map(({ windows, ...u }) => ({
    ...u, sessions: u.sessions.size, usd: Math.round(u.usd * 100) / 100,
    agentHours: Math.round(([...windows.values()].reduce((a, b) => a + b, 0) / 3.6e6) * 10) / 10,
  }))
    .sort((a, b) => b.usd - a.usd || a.unit.localeCompare(b.unit));
}

// ---------------------------------------------------------------- the item's frontmatter

/**
 * What one work item cost, from its ledger rows:
 *   inputTokens        every input token the models read — uncached, cache writes and
 *                      cache reads together (the reads are most of it, and cheap);
 *   cachedInputTokens  the cache-read share of inputTokens;
 *   outputTokens, usd, unpricedTokens (tokens of models with no price, not in usd) —
 *                      usd repriced from `prices` where the model is known (rowUsd);
 *   agentHours         Σ over checkpoints of (last call − first call), the time sessions
 *                      spent working on the item, waits between calls included.
 */
export function itemCost(rows, id, prices = null) {
  const mine = rows.filter((r) => r.item === id);
  if (!mine.length) return null;
  const c = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, usd: 0, unpricedTokens: 0, sessions: new Set(), agentMs: 0 };
  const windows = new Map();
  for (const r of mine) {
    c.inputTokens += r.input + r.cacheWrite5m + r.cacheWrite1h + r.cacheRead;
    c.cachedInputTokens += r.cacheRead;
    c.outputTokens += r.output;
    const usd = rowUsd(r, prices);
    if (usd === null) c.unpricedTokens += r.input + r.cacheWrite5m + r.cacheWrite1h + r.cacheRead + r.output;
    else c.usd += usd;
    c.sessions.add(r.session);
    if (r.from) windows.set(`${r.session}\u0000${r.through}`, Date.parse(r.through) - Date.parse(r.from));
  }
  for (const ms of windows.values()) if (ms > 0) c.agentMs += ms;
  return {
    inputTokens: c.inputTokens, cachedInputTokens: c.cachedInputTokens, outputTokens: c.outputTokens,
    usd: Math.round(c.usd * 100) / 100, unpricedTokens: c.unpricedTokens, sessions: c.sessions.size,
    agentHours: Math.round((c.agentMs / 3.6e6) * 10) / 10,
    firstCall: mine.map((r) => r.from).filter(Boolean).sort()[0] ?? null,
  };
}

/**
 * When work on the item began: its first claim commit, restarted only by an `unstarted:`
 * release (claim.sh's prefix for a claim where nothing could start). Any other release is
 * a hand-off: the work done before it is part of the item, so the clock keeps running and
 * the time the item waited between claims counts too.
 *
 * @param commits oldest first: { at: ISO date, subject, added: the lines the commit added
 *                to the item file } — `unstarted:` is in the added status note, not the subject
 * @returns ISO date (second precision) or null when the history does not reach a claim
 */
export function claimedAt(commits, id) {
  const claim = new RegExp(`claim ${id}\\b|${id} → in-progress`);
  const unstarted = /^_available [^—]*— unstarted:/m;
  let at = null;
  for (const c of commits) {
    if (unstarted.test(c.added ?? "")) at = null;
    else if (!at && claim.test(c.subject)) at = c.at;
  }
  return at ? new Date(at).toISOString().replace(/\.000Z$/, "Z") : null;
}

/**
 * Parse `git log --reverse --format=@@@%aI %s -p -U0 -- <item file>` into claimedAt's
 * commits.
 */
export function parseItemLog(text) {
  const commits = [];
  for (const chunk of text.split(/^@@@/m).slice(1)) {
    const nl = chunk.indexOf("\n");
    const head = nl < 0 ? chunk : chunk.slice(0, nl);
    const sp = head.indexOf(" ");
    const added = (nl < 0 ? "" : chunk.slice(nl + 1)).split("\n")
      .filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1)).join("\n");
    commits.push({ at: head.slice(0, sp), subject: head.slice(sp + 1), added });
  }
  return commits;
}

/**
 * The `cost:` frontmatter block for an archived item. Every value is a quoted string: the
 * corpus parser yields scalars as strings, and the schema types them as patterned strings.
 * `claimed` falls back to the item's first recorded call when git history (a shallow
 * clone) does not reach the claim, and says so in `claimed_from`. With no rows the block
 * is `ledger: "none"`, and `noLedgerReason` (the reconciler's `--no-ledger`) says why.
 */
export function costBlock(cost, { claimed, done, noLedgerReason = null }) {
  const lines = ["cost:"];
  const put = (k, v) => lines.push(`  ${k}: "${v}"`);
  if (cost) {
    put("input_tokens", cost.inputTokens);
    put("cached_input_tokens", cost.cachedInputTokens);
    put("output_tokens", cost.outputTokens);
    put("usd", cost.usd.toFixed(2));
    if (cost.unpricedTokens) put("unpriced_tokens", cost.unpricedTokens);
    put("sessions", cost.sessions);
    put("agent_hours", cost.agentHours.toFixed(1));
  } else {
    put("ledger", "none");
    if (noLedgerReason) put("ledger_reason", noLedgerReason.replace(/\s+/g, " ").trim().replace(/[\\"]/g, "'"));
  }
  const start = claimed ?? cost?.firstCall ?? null;
  if (start) {
    put("claimed", start.replace(/\.\d{3}Z$/, "Z"));
    if (!claimed) put("claimed_from", "ledger");
    put("done", done.replace(/\.\d{3}Z$/, "Z"));
    put("wall_clock_hours", (Math.max(0, Date.parse(done) - Date.parse(start)) / 3.6e6).toFixed(1));
  }
  return lines.join("\n") + "\n";
}

/**
 * Whether an item may be archived on what the ledger holds for it. An item with no rows
 * is refused unless a reason is given: on the feature's first day 16 of 21 archives wrote
 * `ledger: "none"` unnoticed, from sessions that never ran `session-usage.mjs` or ran it
 * on a window with no calls.
 */
export function ledgerGate(cost, noLedgerReason) {
  if (cost) return { ok: true, noLedgerReason: null };
  const reason = (noLedgerReason ?? "").trim();
  return reason ? { ok: true, noLedgerReason: reason } : { ok: false, noLedgerReason: null };
}

/** Replace (or append) the `cost:` block in a frontmatter string ending in "\n". */
export function setCostBlock(fm, block) {
  const without = fm.replace(/^cost:\n(?:[ \t]+.*\n)*/m, "");
  return without + block;
}
