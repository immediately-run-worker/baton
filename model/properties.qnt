// The properties R3-1243 asks for, each with the requirement it checks.
module properties {
  import baton.* from "./baton"

  // R-BTN-4: at most one live claim per ticket, and one per worker.
  val oneClaimPerTicket = TICKETS.forall(t => activeOf(t).size() <= 1)
  val oneClaimPerWorker = WORKERS.forall(w => workerClaim(w).size() <= 1)

  // R-BTN-62: accepted observations strictly increase, and none exceeds what was handed out.
  val observationsIncrease =
    accepted.indices().forall(i => i == 0 or accepted[i - 1] < accepted[i])
      and lastAccepted <= counter

  // R-BTN-10, -62: an end is confirmed only by an observation greater than the claim's own
  // (and, unless a recorded closure confirmed a done end, greater than the end's); the
  // owner's confirmation is marked -1.
  val confirmationAfterEnd = claims.keys().forall(i => {
    val c = claims.get(i)
    not(c.confirmed) or c.confirmObs == -1 or
      (c.confirmObs > c.claimObs and (c.kind == "done" or c.confirmObs > c.endObs))
  })

  // R-BTN-10, -71: monotone confirmation — a confirmed suspension's expected path is in git
  // (a prefix of git's path) unless git has since regressed or the claim ended regressed.
  val confirmedIsInGit = claims.keys().forall(i => {
    val c = claims.get(i)
    not(c.confirmed and c.kind == "suspended" and c.confirmObs != -1)
      or c.endedRegressed or gitRegressedEver.get(c.ticket)
      or isPrefix(expected(c), gitPath.get(c.ticket))
  })

  // R-BTN-35: a claim is ended stale only when git took the ticket away.
  val staleOnlyWhenTakenAway = claims.keys().forall(i => {
    val c = claims.get(i)
    c.kind != "stale" or withdrawn.get(c.ticket)
  })

  // §2e: a claim is flagged regressed only when git really lost a leg — a lagging or
  // out-of-order sync never flags it.
  val regressedOnlyWhenGitRegressed = claims.keys().forall(i => {
    val c = claims.get(i)
    not(c.regressed) or gitRegressedEver.get(c.ticket)
  })

  // R-BTN-63, -69: bounded loops — no claim's path runs a leg more than its max_runs.
  val boundedLoops = claims.keys().forall(i => {
    val c = claims.get(i)
    val p = if (c.leg == "") expected(c) else expected(c).append(c.leg)
    LEGS.forall(l => runs(p, l) <= MAX_RUNS.get(l))
  })

  // No deadlock: a ticket git has not finished or withdrawn, with every sync idle and the
  // head as fresh as git, is held, claimable, or flagged for the owner (an unconfirmed
  // completion) — never stuck where nobody can claim it and nobody is told.
  def quiescent(t: str): bool = and {
    SLOTS.forall(s => syncs.get(s).phase == "idle"),
    posted.get(t) == gitPath.get(t),
    postedGone.get(t) == withdrawn.get(t),
    lastAccepted > maxEndObs(t),
  }
  val noStuckTicket = TICKETS.forall(t =>
    atEnd(gitPath.get(t)) or withdrawn.get(t) or not(quiescent(t))
      or activeOf(t).size() > 0 or unconfirmedOf(t).size() > 0 or claimable(t)
      or nextId > MAX_CLAIMS)

  val safety = and {
    oneClaimPerTicket, oneClaimPerWorker, observationsIncrease, confirmationAfterEnd,
    confirmedIsInGit, staleOnlyWhenTakenAway, regressedOnlyWhenGitRegressed, boundedLoops,
    noStuckTicket,
  }
}
