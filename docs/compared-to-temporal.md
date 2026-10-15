# Baton compared with Temporal

Baton and [Temporal](https://temporal.io) both coordinate long-running, multi-step work that
must survive crashes. They make opposite bets about where the truth lives, and that decides
where each fits. This page states the differences so you can tell which one suits your work.
The rules referred to (`R-BTN-n`) are in `BATON_SPEC`.

## The one-line difference

- **Temporal** is the source of truth. A workflow is code. Temporal records every step in an
  event history, and the code re-runs deterministically against that history to rebuild its
  state.
- **Baton** is a cache of git. A ticket's state is whatever git shows: its files, branches,
  pull requests, reviews and markers. Baton hands out work, enforces the few gates that keep
  workers from colliding, and advises on the rest. If Baton and git disagree, git wins. Baton
  logs the disagreement first (R-BTN-85).

## How the concepts map

| Temporal | Baton | Note |
|---|---|---|
| Workflow | A ticket on a **course** | A course is a graph in `course.json`: **stations** (nodes) joined by **legs** (edges). It is not code. |
| Workflow code | The course file, plus `locate` (the course's pure function from git to a ticket's position) | Conditions live in `locate`, never in the graph (R-BTN-69). |
| Activity | A **leg**, run by a worker's leg script | Legs are coarse: an agent session, a human review, a merge. |
| Activity result | The leg's **position** `(reached, next)` and its output **pointers** | Written to git first, then reported (R-BTN-82, R-BTN-83). |
| Event history | **Git history**, plus Baton's per-ticket **history** (R-BTN-81) | Baton's history is a record of what it saw. Nothing is rebuilt from it. |
| Task queue | A leg's **queue**: the unheld tickets whose queued leg it is | Optional `max_queue` warnings and course intake closing (R-BTN-79). |
| Worker | A **worker** running `baton run` | It holds a lease (a claim) and heartbeats. |
| Timer, signal | A suspension at a station, a `waiting` leg, a block, a **decision** | Long waits are states, not code (R-BTN-71, §2g). |
| Human task | A **decision** block, delivered to people by **couriers** | Answers are given in git (R-BTN-78, R-BTN-80). |
| Workflow versioning, patching | Course `version`, `min_worker_version`, `renamed_from`, `course-changed` | §2e, R-BTN-64. |
| Replay | Git history re-read by `locate`; `baton replay` for one leg run | See below. |

## What Temporal's replay gives that Baton does not

1. **Durability inside a step.** A Temporal workflow's local variables and call stack survive
   a crash: the worker replays the history and carries on at the same line. Baton's unit of
   durability is the **station**. A leg that dies halfway is restarted from its hand-off
   document and resume record, and redoes whatever it had not pushed.
2. **Completed steps are never re-run.** Temporal records activity results and reuses them on
   replay. In Baton, what survives a leg is what it pushed to git and reported as its position.
   Work inside a leg that was never committed is lost.
3. **Waits as code.** Temporal has durable timers of any length, signals, queries, child
   workflows and sagas, all written inline in workflow code. Baton models waiting outside code,
   as stations, `waiting` legs, blocks and decisions.
4. **Step-through debugging of production history.** You can load a Temporal history into a
   local worker and step through the orchestration exactly as it ran. `baton replay` re-runs one
   recorded leg on its recorded inputs (R-BTN-84). It reproduces the leg's **code and inputs**,
   but not its outputs, because an agent leg is not deterministic.
5. **Proof that a code change is safe for work in flight.** Replaying recorded histories
   against new workflow code catches non-determinism before deploy. Baton checks a course
   change structurally (`baton test-course`, `renamed_from`, `course-changed` waits), but does
   not replay real tickets' histories against it. See *Planned* below.
6. **Full payloads and reset.** Temporal stores every input and result and can reset a workflow
   to an earlier event. Baton stores pointers and digests, never content (R-BTN-33). To move a
   ticket back you change git, because where a ticket is, is git's.

## What Baton gives that Temporal does not

1. **Git is the truth, and anyone can do the work.** A human can push a fix, a reviewer can
   approve a PR, and a leg can run outside Baton altogether. The next sync sees it and the
   ticket moves (R-BTN-66). In Temporal, work done outside the workflow is invisible to it.
2. **No determinism constraint.** Course logic and leg scripts can be any code. That includes
   agent sessions and people, whose results differ on every run. Temporal requires workflow code
   to be deterministic, so an agent or human step can only be an activity, and replay never
   re-runs activities. For that kind of work Temporal's replay gives no more reproducibility
   than `baton replay`.
3. **Losing Baton loses nothing that matters.** Baton could be rebuilt from git. Its own state
   is the leases, the owner's limits and the history. Losing a Temporal cluster's persistence
   loses the workflows.
4. **Advice, not control.** Baton gates only what costs correctness or the owner's explicit say:
   one holder per ticket, holds, barred tags, decisions (R-BTN-45). Ordering, resource
   availability and queue bounds are advice a worker may override. Temporal executes exactly
   what the workflow says.
5. **Review is built in.** Positions, outputs and decisions live in pull requests and markers,
   where people already look. The history, the discrepancy log and the dashboard sit on top of
   that.

## Where Baton fits, and where it does not

Baton fits work that:

- is measured in minutes to days per step, by agents and people, with long waits between;
- already lives in git: tickets as files, steps as commits, reviews and pull requests;
- must tolerate people and other tools moving it outside the coordinator;
- has nondeterministic steps (LLM agents, human judgement), where re-execution is a new
  attempt, not a replay.

Temporal fits better when:

- steps are short, many and machine-executed (payments, provisioning, data pipelines);
- the orchestration itself is complex code, with fan-out, compensation and timers in
  milliseconds to months, and must resume mid-function;
- exactly-once effects matter at every step, and inputs and results must be stored in full;
- there is no external source of truth for a step's progress.

You can combine them: a single Baton leg may run a Temporal workflow internally. That gets
Temporal's guarantees inside the leg, and Baton's view of the work across legs.

## Planned

Git history already is a replayable log of the orchestration, because `locate` is a pure
function of git. Two commands would use it:

- **`baton locate --at <sha>`** — where a ticket was at any past commit. It can also be
  checked against the history and the discrepancy log.
- **`baton test-course --against-history`** — replays every ticket's real git history through
  a proposed course file and `locate`, and lists the tickets the change would strand or move.
  That is Temporal's replay test, over git instead of an event log.
