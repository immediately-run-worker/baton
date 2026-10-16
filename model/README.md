# Baton's core as a formal model (R3-1243)

A [Quint](https://quint-lang.org) model of Baton's core state machine, written against
`BATON_SPEC` in `immediately-run/docs` as merged at `b7537395` (docs#212). Each action, helper
and property names the requirement it models (`R-BTN-n`, §n). A counterexample is a spec
defect: it is filed against BATON_SPEC with the trace, never fixed by weakening a property.

## Files

| File | What it holds |
|---|---|
| `baton.qnt` | the state (one record, `st`) and every action; the sizes are constants |
| `properties.qnt` | the safety invariants, conjoined as `safety`, over any instance |
| `liveness.qnt` | the liveness properties under weak fairness, over `small` (kept apart: their fairness terms made Apalache's input too large) |
| `witnesses.qnt` | the reachability witnesses, each an invariant that must fail |
| `instances.qnt` | `sim` (R3-1243's bounds: 3 workers, 2 tickets, 2 overlapping sync runs) and `small` (2 workers, 1 ticket, 1 sync run, for Apalache) |
| `regressions.qnt` | one deterministic run per defect the reviews found (24), each asserting the merged spec does not reach it |
| `replay.qnt` | the traces `test/model/replay.test.ts` drives the core with (R3-1244): `sim`'s instance, every action the harness can make the core take |
| `check.mjs` | `npm run model` |

## Commands

- `npm run model` — typecheck, the 24 regression runs, 10,000 random runs of 40 steps of `sim`
  against `safety` with the full `step` and 3,000 with `progressStep` (the happy path's actors,
  so runs reach merges, fix loops and regressions; every run of it is a run of `step`), and
  eight reachability witnesses. No JVM; about 6 minutes, run by CI's `model` job. `npm test`
  runs it with `MODEL_SAMPLES=1000`, which also scales the `progressStep` runs (300), in
  about two minutes.
- `npm run model:verify` — Apalache's bounded proof of `safety` on `small` to depth 5, about
  15 minutes on 4 CPUs since the round-1 fixes (depth 6 does not finish in CI's budget). Needs
  Java (CI installs Temurin 21); the first run downloads Apalache.

Simulation uses Quint's TypeScript backend: the Rust evaluator is fetched from GitHub
releases at first use, which a sandboxed agent cannot always reach.

## Code against the model (R3-1244)

The model checks the design; three checks hold the code to it.

- **Correspondence markers** (`npm run model:links`, `scripts/check-model-links.mjs`, in `npm
  test`). Each action names its implementation above it — `// @impl src/core/<file>.ts#<fn>`, or
  `// @impl external — <who>` for a step only the environment takes (a worker's push, git, time)
  — and each implementing function names the action back with a hash of the action's text,
  `// @model <action> sha256:<12 hex>`. A model change fails the check, naming the functions to
  re-check; re-stamping the hash (`node scripts/check-model-links.mjs --stamp` prints them) is
  the reviewed step.
- **Scenario traces** (`npm run traces`, `scripts/check-traces.mjs`, in `npm test`). Every S-BTN
  scenario's run on the local host is recorded, one step per request or alarm tick, with the
  state projection after it (`test/integration/trace.ts`: observation numbers, the model's
  repository's tickets as posted, claims and their legs, holds, owner bars, workers' tags, the
  required bar). Each trace replays as a deterministic Quint run: Baton's action with the
  environment's steps that make it possible, then the projection the model must reach. A
  rejection names the scenario, the step, the model action and the field. A step the model has
  no action for — a claim the harness wrote, cutover's legacy claims, a course file that is not
  the model's — ends the part of the trace the model can judge; every trace prints its checked
  steps and why it stopped.
- **Model-based tests** (`test/model/replay.test.ts`, in `npm test`). 200 traces drawn from
  `replay.qnt` (half from every actor, half from the happy path's) drive the core on the local
  host, comparing its projection with the trace's state after every step. `REPLAY_TRACES` sets
  the count.

To replay scenarios with their own workers and required bar, `FAMILIES`, `TAGS`, `REQUIRED` and
`MAX_TIME` are constants of `baton.qnt`; every checked instance keeps R3-1243's values.

**Where code and model differ, and why it is safe.** Baton renews a lease on every
authenticated call, not only on heartbeats and claims (it reaps later); it force-reaps a worker
already silent past its lease without a fence (R-BTN-19's fence, already timed out: the model's
`forceReap` and `fenceTimeout` in one step); its one alarm reaps every lapsed lease at once; it
voids an observation number by its clock alone. `replay.qnt` draws only traces in which these
coincide with the model's single steps, and says so. The model keeps a reaped claim's leg as its
worker's view; Baton keeps no worker's view, so a leg is compared while its claim is active.
Claim hooks (`claimFinish(…, "refuse")`) are not driven: core calls none until R3-1236.

## What is modelled

- **The course** is `roadmap-pr`'s `course.json` (§2e, R-BTN-69): `filed` → `pr-open` →
  `reviewed` ⇄ `fixed`, `adjudicated`, `merged`; `review` at most 3 runs, `fix` 2. Core reads it
  as a graph only.
- **Claims around the hook's await** (§3, R-BTN-52, R-BTN-55): `claimStart` computes the
  candidate; other actions interleave; `claimFinish` takes the hook's answer — order, refuse or
  fail — and re-checks every gate against the state as it is then.
- **Advance** (R-BTN-63): finishes the running leg, starts the next along an edge under its
  `max_runs` (counted from `start_path` plus the claim's legs), on the holder's word, if the
  holder gates hold: the hold (rule 3), barred tags — the sync's, the owner's `claim+advance`
  bars, the holder's own `bars` (rule 8, R-BTN-60, R-BTN-67) — the required bar over posted plus
  holder bars (R-BTN-67), and the hook's refusal. Git first (R-BTN-8): a leg's evidence is
  pushed before the advance that finishes it, and may land, be rejected or be lost.
- **Ends** (R-BTN-71, §6.5): `done`, `suspended` at the `to` reached or the `from` given up,
  `release`. A `done` may come from any station — the runner also ends done when git shows the
  ticket closed (§11, R-BTN-72), which Baton cannot see — and is confirmed only by an end
  station or a closure (R-BTN-10). *(R3-1244's scenario traces found the model requiring an end
  station, narrower than the spec; `progressStep` keeps the runner's own rule, so its runs still
  reach merges.)*
- **Time and the lease** (§6.3, §6.6, R-BTN-4, R-BTN-6, R-BTN-19, R-BTN-26): abstract ticks;
  a claim's lease lasts `TIMEOUT` ticks from the last heartbeat and the alarm reaps it then —
  its worker dead, or alive and silent (asleep). A worker acts on the claim *it believes* it
  holds, and its own fence check stops it `MARGIN` ticks before its lease ends by its own
  clock, which runs up to `MAX_DRIFT` behind Baton's. The owner force-reaps a live worker's
  claim, which stays fenced — the ticket not re-issued — until that worker reports
  `fence-cleared` or has been silent (dead or asleep) past its timeout, measured in ticks
  from its last heartbeat (`fenceTimeout`; round 2, 2-A-0).
- **The sync** (§7.1, R-BTN-62): number, then read, then post, as three actions, so every
  interleaving with workers and git is explored — with at most one reading in flight per
  repository: a second number is refused while one is outstanding, and a voided number's post
  is refused (R-BTN-62 as amended 2026-10-15, after this model found the overlap); the barred tags it posts are any set
  consistent with the contract (course logic is nondeterministic, R-BTN-50). A post is accepted
  whole only when its number is greater than the last accepted; an accepted snapshot judges a
  claim only when its number is greater than the claim's or its end's: staleness only on
  withdrawal (R-BTN-35); a regression when the path is shorter than git showed before (§2e),
  cleared when git extends the expected path; confirmation by path extension, by any path for a
  claim that ended regressed, or by a recorded closure for `done` (R-BTN-10, R-BTN-71).
- **Git is anyone's** (R-BTN-66): any pusher can run the next leg, a PR can close, a ticket can
  be withdrawn. **The owner** holds tickets, sets and lifts owner bars, force-reaps, and
  resolves flagged completions (§8, R-BTN-67, §6.7).

## Properties (`safety`)

| Property | Requirement |
|---|---|
| `oneLiveHolderPerTicket` — an active claim or a fenced, force-reaped one; never two | R-BTN-4, R-BTN-19, R-BTN-26 |
| `oneClaimPerWorker` | R-BTN-4 |
| `observationsIncrease` | R-BTN-62 |
| `confirmationAfterEnd` — no end confirmed by an observation not greater than its own | R-BTN-10, R-BTN-62 |
| `confirmedIsInGit` — monotone confirmation: a confirmed suspension's path is in git unless git since regressed | R-BTN-10, R-BTN-71 |
| `staleOnlyWhenTakenAway` | R-BTN-35 |
| `regressedOnlyWhenGitRegressed` — lag is never a regression | §2e |
| `boundedLoops` — no claim runs a leg past its `max_runs` | R-BTN-63, R-BTN-69 |
| `writingLegsBarred` — every writing leg started under the required bar, by a worker of no barred family | R-BTN-45, R-BTN-60, R-BTN-67 |
| `gatesHeld` — every claim and advance was granted with every gate in force holding (hold, barred tags, required bar, hook refusal), recorded at the grant apart from the guard | R-BTN-45, R-BTN-52, rules 3, 8, 12 |
| `noActAfterLoss` — no worker pushes for a claim the alarm reaped (unfenced) | R-BTN-6, R-BTN-26 |
| `noStuckTicket` — no deadlock: a ticket git has not finished or withdrawn, once the syncs are idle and the head matches git, is held, fenced, owner-held, waiting on `policy`, flagged, or claimable | §6.7, R-BTN-10, R-BTN-35, R-BTN-67 |

**Liveness** — `fencesClear`, `endsResolveWithOwner` (implied by the owner's fairness alone, by design: §6.7), `barsLiftClaimable`, `readyIsClaimed` — is stated
in `liveness.qnt` under weak fairness of each resolving step, per worker. The item's fifth,
a held history accepted within 24 hours, is not stated: held histories are not modelled. See
*Checked how* for what has been run.

**What found something.** On its first review this model found a real spec gap: with two
overlapping sync runs, a higher observation number read earlier could be posted later and
make a holder's progress look like a regression. BATON_SPEC R-BTN-62 relied on Actions'
concurrency group, which agents can edit; it now has Baton refuse a second number while one is
outstanding (`sync-busy`). `overlappingSyncRunsRefusedTest` keeps it.

**Mutation checks** — each mutant fails the run or probe that names its defect:
- restoring the fifth revision's regression rule fails `lostPushIsNotRegressionTest`;
- dropping the gate re-check after the hook fails `claimDuringHookCallTest`;
- dropping the fence from the claim gate fails `forceReapFencesTest`;
- dropping the advance's gate guard reaches a `gateViolation` (`gatesHeld`);
- clearing a fence without its timeout fails `heartbeatingFenceHoldsTest`;
- `MAX_DRIFT = 3`, above `MARGIN = 2`, lets a reaped worker push (`noActAfterLoss`); at
  `MAX_DRIFT = 2` it cannot — the spec's assumption is drift ≤ the margin.

## Checked how

| Check | Instance | Result |
|---|---|---|
| 24 regression runs | `sim` sizes, zero drift | pass |
| `safety`, 10,000 × 40 steps of `step`; 3,000 × 40 of `progressStep` | `sim` | no violation |
| witnesses (a confirmed suspension, a resumed claim, a fence, an alarm reap; a fix leg, a regression, a merge, a confirmed `done`), seeded | `sim` | all reached |
| a second review | — | reached by a regression run only (`maxRunsSurviveResumptionTest`) |
| Apalache, `safety` | `small`, depth 5 | no violation (15 min 29 s on 4 CPUs) |
| liveness, `fencesClear` | `small`, TLC (Apalache cannot check fairness) | **at `b76af9c`, the pre-round-2 formula and model**: no violation in 8,187 distinct states before a 28-minute cap, not exhaustive. The current formulas (rounds 2–3) have not been run; R3-1254 runs them to completion on a narrowed instance |

Depth 5 on `small` reaches claims, advances, pushes and a sync; it does not reach a judged
snapshot (a confirmation, a stale release or a regression needs 6–8 steps), so for those
invariants the evidence is the simulation and the regression runs, not the proof.

## Bounds and assumptions

- `sim`: 3 workers (two of family `a`, one of `b`), 2 tickets, 2 overlapping sync runs, at most
  6 claims, 2 git events and 2 owner acts per run. `small`: 2 workers, 1 ticket, 1 sync run, 3
  claims, 1 git event, 1 owner act.
- **Time** is abstract ticks: `TIMEOUT = 4`, `MARGIN = 2`, `MAX_DRIFT = 1`, at most 12 ticks
  a run. The 30-minute regression flag and the 6-hour unconfirmed flag are "eventually".
  **The drift assumption**, checked: R-BTN-6's fence holds while the worker's lag is at most
  the margin (4 minutes in the spec); above it, a reaped worker can push. R-BTN-6 computes
  `now − last_ok` on the worker's own clock, so a constant clock offset cancels; what
  `MAX_DRIFT` really bounds is how far the worker's `last_ok` lags Baton's renewal plus its
  clock's rate skew over one lease (round 2, 2-A-5) — modelled, equivalently, as a clock
  running behind.

## Not modelled, and why

- **Held histories** (R-BTN-11): a force-pushed history's held posts refresh stations exactly as
  a refresh does here; the 24-hour acceptance is an owner/clock event with no new interleaving.
- **More than one repository** (R-BTN-61): repositories share no state but workers and the
  order; the merge across them is advice, not safety.
- **Course changes and renames** (R-BTN-64): a renamed name resolves to the same edge; a removed
  one ends the claim `released:course-changed`, a release the model already has.
- **Tiers, grants and requires** (rules 4–7): column comparisons with no interleaving of their
  own; matching tests cover them (G-BTN-40).
- **R-BTN-39** (where a ticket is, replayed from git) is the sync's `syncRead` taking any git
  state as given; **R-BTN-40** (suspend rather than wait on the lease) is a worker's choice, so
  `endClaim(…, "suspended", …)` may happen at any point — both are modelled as nondeterminism,
  not as rules of their own.
- **Blocks, decisions, leg queues and notices** (BATON_SPEC §2g, R-BTN-75–80; docs#213): R3-1254, with exhaustive liveness on a narrowed instance.
