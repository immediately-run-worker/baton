// The properties R3-1243 asks for, each naming the requirement it checks, over any
// instance of the model (instances.qnt fixes the sizes).
module properties {
  const P_TICKETS: Set[str]
  const P_WORKERS: Set[str]
  const P_SLOTS: Set[int]
  const P_MAX_CLAIMS: int
  const P_GIT_BUDGET: int
  const P_OWNER_BUDGET: int
  import baton(TICKETS = P_TICKETS, WORKERS = P_WORKERS, SLOTS = P_SLOTS,
               MAX_CLAIMS = P_MAX_CLAIMS, GIT_BUDGET = P_GIT_BUDGET,
               OWNER_BUDGET = P_OWNER_BUDGET).* from "./baton"
  action pinit = init
  action pstep = step
  action pprogress = progressStep

  // R-BTN-4, R-BTN-19, R-BTN-26: at most one live holder per ticket — an active claim, or a
  // force-reaped one whose worker has not cleared its fence — and one active claim per worker.
  val oneLiveHolderPerTicket = TICKETS.forall(t => activeOf(t).size() + fencedOf(t).size() <= 1)
  val oneClaimPerWorker = WORKERS.forall(w => workerClaim(w).size() <= 1)

  // R-BTN-62: accepted observations strictly increase; none exceeds what was handed out.
  val observationsIncrease =
    st.accepted.indices().forall(i => i == 0 or st.accepted[i - 1] < st.accepted[i])
      and st.lastAccepted <= st.counter

  // R-BTN-10, R-BTN-62: an end is confirmed only by an observation greater than the claim's
  // (and, unless a recorded closure confirmed a done end, greater than the end's); the
  // owner's confirmation is marked -1.
  val confirmationAfterEnd = st.claims.keys().forall(i => {
    val c = st.claims.get(i)
    not(c.confirmed) or c.confirmObs == -1 or
      (c.confirmObs > c.claimObs and (c.kind == "done" or c.confirmObs > c.endObs))
  })

  // R-BTN-10, R-BTN-71: monotone confirmation — a confirmed suspension's path is in git,
  // unless git has since regressed or the claim ended regressed.
  val confirmedIsInGit = st.claims.keys().forall(i => {
    val c = st.claims.get(i)
    not(c.confirmed and c.kind == "suspended" and c.confirmObs != -1)
      or c.endedRegressed or st.gitRegressedEver.get(c.ticket)
      or isPrefix(expected(c), st.gitPath.get(c.ticket))
  })

  // R-BTN-35: a claim is ended stale only when git took the ticket away.
  val staleOnlyWhenTakenAway = st.claims.keys().forall(i => {
    val c = st.claims.get(i)
    c.kind != "stale" or st.withdrawn.get(c.ticket)
  })

  // §2e: a claim is flagged regressed only when git really lost a leg — lag never is.
  val regressedOnlyWhenGitRegressed = st.claims.keys().forall(i => {
    val c = st.claims.get(i)
    not(c.regressed) or st.gitRegressedEver.get(c.ticket)
  })

  // R-BTN-63, R-BTN-69: bounded loops — no claim runs a leg past its max_runs.
  val boundedLoops = st.claims.keys().forall(i => {
    val c = st.claims.get(i)
    val p = if (c.leg == "") expected(c) else expected(c).append(c.leg)
    LEGS.forall(l => runs(p, l) <= MAX_RUNS.get(l))
  })

  // R-BTN-45, R-BTN-60, R-BTN-67: every writing leg started under docs' required bar — some
  // family barred, by the sync or the holder — and never by a worker of a barred family.
  val writingLegsBarred = st.claims.keys().forall(i => {
    val c = st.claims.get(i)
    c.status != "active" or not(REQUIRED.contains(c.leg)) or
      (c.startBars.intersect(FAMILIES).size() > 0 and c.startBars.intersect(TAGS.get(c.worker)).size() == 0)
  })

  // R-BTN-45, R-BTN-52, rules 3, 8, 12: every claim and every advance was granted with every
  // gate in force holding, hook refusal included — recorded at the grant, apart from the guard.
  val gatesHeld = st.claims.keys().forall(i => not(st.claims.get(i).gateViolation))

  // R-BTN-6, R-BTN-26: no worker pushes for a claim Baton reaped without a fence — its own
  // fence check stops it first, given drift below the margin (baton.qnt, time).
  val noActAfterLoss = not(st.actedAfterLoss)

  // No deadlock: a ticket git has not finished or withdrawn, once the syncs are idle and the
  // head matches git, is held by a claim, fenced (clears at fence-cleared or the timeout),
  // held by the owner, waiting on `policy` or flagged unconfirmed (both under Needs you), or
  // claimable — never stuck where nobody can claim it and nobody is told.
  def quiescent(t: str): bool = and {
    SLOTS.forall(s => st.syncs.get(s).phase == "idle"),
    st.posted.get(t) == st.gitPath.get(t),
    st.postedGone.get(t) == st.withdrawn.get(t),
    st.lastAccepted > maxEndObs(t),
  }
  val noStuckTicket = TICKETS.forall(t =>
    atEnd(st.gitPath.get(t)) or st.withdrawn.get(t) or not(quiescent(t))
      or activeOf(t).size() > 0 or fencedOf(t).size() > 0 or unconfirmedOf(t).size() > 0
      or st.held.get(t) or (nextLegs(st.posted.get(t)).size() > 0 and readyLegs(t).size() == 0)
      or ticketClaimable(t) or st.nextId > MAX_CLAIMS)

  val safety = and {
    oneLiveHolderPerTicket, oneClaimPerWorker, observationsIncrease, confirmationAfterEnd,
    confirmedIsInGit, staleOnlyWhenTakenAway, regressedOnlyWhenGitRegressed, boundedLoops,
    writingLegsBarred, gatesHeld, noActAfterLoss, noStuckTicket,
  }

  // ---- liveness: in liveness.qnt, so the safety proof does not carry the fairness terms ----

}
