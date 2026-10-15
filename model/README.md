# Baton's core as a formal model (R3-1243)

A [Quint](https://quint-lang.org) model of Baton's core state machine, written against
`BATON_SPEC` in `immediately-run/docs` as merged at `b7537395` (docs#212). Each action, helper
and property names the requirement it models (`R-BTN-n`, §n). A counterexample is a spec
defect: it is filed against BATON_SPEC with the trace, never fixed by weakening a property.

## Files

| File | What it holds |
|---|---|
| `baton.qnt` | the state (one record, `st`) and every action; the sizes are constants |
| `properties.qnt` | the safety invariants (conjoined as `safety`), the liveness properties, the reachability witnesses — over any instance |
| `instances.qnt` | `sim` (R3-1243's bounds: 3 workers, 2 tickets, 2 overlapping sync runs) and `small` (2 workers, 1 ticket, 1 sync run, for Apalache) |
| `regressions.qnt` | one deterministic run per defect the reviews found, each asserting the merged spec does not reach it |
| `check.mjs` | `npm run model` |

## Commands

- `npm run model` — typecheck, the 18 regression runs, 1,000 random runs of 40 steps of `sim`
  against `safety` (`MODEL_SAMPLES` to change), and four reachability witnesses. No JVM; about
  45 seconds. Part of `npm test`.
- `npm run model:verify` — Apalache's bounded proof of `safety` on `small` to depth 5, about
  5 minutes on 4 CPUs (depth 6 had not finished after 14 more minutes). Needs
  Java (CI installs Temurin 21); the first run downloads Apalache.

Simulation uses Quint's TypeScript backend: the Rust evaluator is fetched from GitHub
releases at first use, which a sandboxed agent cannot always reach.

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
- **Ends** (R-BTN-71, §6.5): `done` at an end station, `suspended` at the `to` reached or the
  `from` given up, `release`.
- **The lease** (§6.6, R-BTN-19, R-BTN-26): a dead worker's claim is reaped at its timeout; the
  owner force-reaps a live worker's claim, which stays fenced — the ticket not re-issued —
  until that worker reports `fence-cleared` or dies and times out.
- **The sync** (§7.1, R-BTN-62): number, then read, then post, as three actions, so every
  interleaving with workers and git is explored; the barred tags it posts are any set
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
| `noStuckTicket` — no deadlock: a ticket git has not finished or withdrawn, once the syncs are idle and the head matches git, is held, fenced, owner-held, waiting on `policy`, flagged, or claimable | §6.7, R-BTN-10, R-BTN-35, R-BTN-67 |

**Liveness** (`fencesClear`, `endsResolve`) is stated in `properties.qnt` under weak fairness of
the steps that resolve each, for Apalache's `--temporal` mode. It has not been model-checked
yet: checking it, and adding it to CI if it fits the budget, is filed as R3-1243's remainder.
Meanwhile the deterministic runs `forceReapFencesTest` and `lostWriteIsFlaggedNotStuckTest`
show each resolving path.

**Mutation checks** made while drafting: restoring the fifth revision's regression rule fails
`lostPushIsNotRegressionTest`; dropping the gate re-check after the hook fails
`claimDuringHookCallTest`; dropping the fence from the claim gate fails `forceReapFencesTest`.

## Bounds and assumptions

- `sim`: 3 workers (two of family `a`, one of `b`), 2 tickets, 2 overlapping sync runs, at most
  6 claims, 2 git events and 2 owner acts per run. `small`: 2 workers, 1 ticket, 1 sync run, 3
  claims, 1 git event, 1 owner act.
- **Time is abstract.** Lease timeouts, the 30-minute regression flag and the 6-hour
  unconfirmed flag are "eventually". **The drift assumption**: the fencing margin of R-BTN-6
  holds only while a worker's clock drifts from Baton's by less than the 4 minutes left between
  the sidecar's own deadline and Baton's reap; the model, with no clocks, assumes it — a worker
  never acts on a lease Baton has already reaped, except through the force-reap path modelled
  as the fence.

## Not modelled, and why

- **Held histories** (R-BTN-11): a force-pushed history's held posts refresh stations exactly as
  a refresh does here; the 24-hour acceptance is an owner/clock event with no new interleaving.
- **More than one repository** (R-BTN-61): repositories share no state but workers and the
  order; the merge across them is advice, not safety.
- **Course changes and renames** (R-BTN-64): a renamed name resolves to the same edge; a removed
  one ends the claim `released:course-changed`, a release the model already has.
- **Tiers, grants and requires** (rules 4–7): column comparisons with no interleaving of their
  own; matching tests cover them (G-BTN-40).
- **Blocks** (BATON_SPEC §2g, R-BTN-75–77; docs#213, in review): to be added when it merges.
