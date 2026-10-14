# Baton's core as a formal model (R3-1243 — draft)

A [Quint](https://quint-lang.org) model of Baton's core state machine, written against
`BATON_SPEC` in `immediately-run/docs` at docs#212 (head `0a5e9b94`, the 2026-10-14 amendment
after its sixth review and review-gate round 1). Each action and property names the
requirement it models (`R-BTN-n`, §n). **Status: a spike.** R3-1243 depends on R3-1228
(the spec landing); this draft was started early, at the owner's direction, so the spec's
fixes could be checked as they were made. It is not yet the item's deliverable: the
remaining work is listed under *Not yet*.

## Files

| File | What it holds |
|---|---|
| `baton.qnt` | the state and every action: claims, stations and legs, advance, ends, reaping, git (holders' pushes, any pusher, regressions, withdrawals), the sync's three steps, the owner resolving a flagged completion |
| `properties.qnt` | the safety invariants, conjoined as `safety` |
| `regressions.qnt` | one deterministic run per defect the reviews found, each asserting the fixed spec does not reach it |
| `witnesses.qnt` | reachability witnesses: states the properties would be vacuous without |
| `check.mjs` | `npm run model` |

## Commands

- `npm run model` — typecheck, the regression runs, 1,000 random runs of 40 steps against
  `safety` (`MODEL_SAMPLES` to change), and the witnesses. No JVM. About a minute.
- `npm run model:verify` — Apalache's bounded proof of `safety` to depth 6 (a depth-8 run took over ten minutes on 4 CPUs; deepen as the model is tuned). Needs Java
  (CI installs Temurin 21); the first run downloads Apalache.

Both use Quint's TypeScript backend for simulation, because the Rust evaluator is fetched
from GitHub releases at first use, which a sandboxed agent cannot always reach.

## What is modelled

- **The course** is `roadmap-pr`'s `course.json` (§2e, R-BTN-69): stations `filed` →
  `pr-open` → `reviewed` ⇄ `fixed`, `adjudicated`, `merged`; `review` at most 3 runs, `fix` 2.
  Core reads it only as a graph; no leg means anything here.
- **Claims** (R-BTN-4, §6.2): one active claim per ticket and per worker; a claim starts at
  the posted station with the posted path as `start_path`.
- **Advance** (R-BTN-63): finishes the running leg (the claim moves to its `to`), starts the
  next when it leaves that station and its runs in `start_path` + the claim's legs are under
  `max_runs`, on the holder's word — no leg state is checked. Git first (R-BTN-8): a leg's
  evidence is pushed before the advance that finishes it, and the push may land, be rejected
  (it does not leave git's station) or be lost.
- **Ends** (R-BTN-71, §6.5): `done` at an end station, `suspended` at the `to` reached or the
  `from` given up, `release`. Reaping a crashed worker's claim (§6.6).
- **The sync** (§7.1, R-BTN-62): take a number, then read git, then post — three actions, so
  every interleaving with workers and git is explored. A post is accepted whole only when its
  number is greater than the last accepted. An accepted snapshot judges a claim only when its
  number is greater than the claim's (or its end's): staleness only when the ticket is
  withdrawn (R-BTN-35); a regression when the path is shorter than git showed before (§2e),
  cleared when git extends the expected path again; confirmation when the path extends the
  expected path by edges, by any path for a claim that ended regressed, or by a recorded
  closure for `done` (R-BTN-10, R-BTN-71).
- **Git is anyone's** (R-BTN-66): any pusher can run the next leg, a PR can close, a ticket
  can be withdrawn — bounded by `GIT_BUDGET` per run.

## Properties (`safety`)

| Property | Requirement |
|---|---|
| `oneClaimPerTicket`, `oneClaimPerWorker` | R-BTN-4 |
| `observationsIncrease` | R-BTN-62 |
| `confirmationAfterEnd` — no end confirmed by an observation not greater than its own | R-BTN-10, R-BTN-62 |
| `confirmedIsInGit` — monotone confirmation: a confirmed suspension's path is in git, unless git since regressed | R-BTN-10, R-BTN-71 |
| `staleOnlyWhenTakenAway` | R-BTN-35 |
| `regressedOnlyWhenGitRegressed` — lag is never a regression | §2e |
| `boundedLoops` — no claim runs a leg past its `max_runs` | R-BTN-63, R-BTN-69 |
| `noStuckTicket` — no deadlock: a ticket git has not finished or withdrawn, once the syncs are idle and the head matches git, is held, claimable, or flagged for the owner | §6.7, R-BTN-10, R-BTN-35 |

A mutation check during drafting restored the fifth revision's regression rule (shorter
than the claim's own expected path): `lostPushIsNotRegressionTest` fails on it, as it should.

## Bounds and assumptions

- 2 tickets, 2 workers, 2 overlapping sync runs, at most 6 claims, 2 git events per run.
- **Time is abstract.** The 30-minute regression flag and the 6-hour unconfirmed flag are
  "eventually"; leases end only by a crash and a reap. The fencing margin's assumption —
  a worker's clock drifts from Baton's by less than the 4 minutes R-BTN-6 leaves — is
  outside this draft, which has no clocks.

## Not yet (R3-1243's remainder)

- Hooks as a split action around their await (§3, R-BTN-52, R-BTN-55): a claim during a
  hook call. Holds, owner bars and required bars (R-BTN-60, R-BTN-67), tiers and grants.
- Fencing a live worker after a force-reap (R-BTN-19, R-BTN-26) and the clock-drift bound.
- Held histories (R-BTN-11) and more than one repository (R-BTN-61).
- Renames and course changes (R-BTN-64).
- Liveness as temporal properties under fairness (every end confirmed or flagged; every
  fence clears), checked by Apalache.
- `npm run model` inside `npm test`, per the item's exit criteria.
