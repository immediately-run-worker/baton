// One deterministic run per defect the 2026-10-14 reviews found, each asserting that the
// spec as fixed does not reach it (R3-1243 "Tests"). `npm run model` runs them.
module regressions {
  import baton.* from "./baton"

  val c1 = claims.get(1)
  val c2 = claims.get(2)
  // the holder finishes `leg`'s evidence: start it, then push it so it lands
  action leg(w: str, l: str): bool = advance(w, l).then(pushEvidence(w, true))
  action sync1: bool = syncNumber(1).then(syncRead(1)).then(syncPost(1))

  // Sixth review M8: a suspension whose ticket git has already moved past (another pusher
  // ran the next leg) was never confirmed by station. Confirmation by path extension
  // confirms it.
  run gitAheadOfSuspensionConfirmsTest =
    init.then(claim("w1", "t1")).then(leg("w1", "implement"))
      .then(endClaim("w1", "suspended", true))
      .then(foreignPush("t1", "review"))
      .then(sync1)
      .expect(c1.confirmed and c1.station == "pr-open")

  // Fifth review B2 / R-BTN-62: a sync that took its number before the claim may not judge
  // it — here it saw the ticket withdrawn, but only a later number ends the claim stale.
  run earlyNumberCannotJudgeClaimTest =
    init.then(withdraw("t1"))
      .then(syncNumber(1)).then(syncRead(1))
      .then(claim("w1", "t1"))
      .then(syncPost(1))
      .expect(c1.status == "active")
      .then(sync1)
      .expect(c1.status == "released" and c1.kind == "stale")

  // Fourth review B4 / "progress is not staleness": a holder that advanced past what a
  // slow sync read is neither stale nor regressed when that sync posts.
  run lagIsNotRegressionTest =
    init.then(claim("w1", "t1")).then(leg("w1", "implement"))
      .then(syncNumber(1)).then(syncRead(1))
      .then(leg("w1", "review"))
      .then(syncPost(1))
      .then(sync1)
      .expect(c1.status == "active" and not(c1.regressed))

  // Fifth review B2: max_runs counted from start_path plus the claim's own legs, so a
  // resumed claim cannot run `fix` a third time.
  run maxRunsSurviveResumptionTest =
    init.then(claim("w1", "t1")).then(leg("w1", "implement")).then(leg("w1", "review"))
      .then(leg("w1", "fix")).then(leg("w1", "review")).then(leg("w1", "fix"))
      .then(leg("w1", "review"))
      .then(endClaim("w1", "suspended", true))
      .then(sync1)
      .expect(c1.confirmed)
      .then(claim("w2", "t1"))
      .expect(c2.startPath.length() == 6 and c2.station == "reviewed")
      .then(advance("w2", "adjudicate"))     // the only ways on: adjudicate or merge
      .expect(c2.leg == "adjudicate")

  run fixRefusedAtItsLimitTest =
    init.then(claim("w1", "t1")).then(leg("w1", "implement")).then(leg("w1", "review"))
      .then(leg("w1", "fix")).then(leg("w1", "review")).then(leg("w1", "fix"))
      .then(leg("w1", "review"))
      .then(advance("w1", "fix"))
      .fail()

  // Sixth review M9: a regression is flagged; a suspension made while regressed is
  // confirmed by the next snapshot, so the ticket is claimable again rather than stuck.
  run regressedSuspensionIsConfirmedTest =
    init.then(claim("w1", "t1")).then(leg("w1", "implement")).then(advance("w1", "review"))
      .then(sync1)
      .then(regress("t1"))
      .then(sync1)
      .expect(c1.regressed)
      .then(endClaim("w1", "suspended", false))
      .then(sync1)
      .expect(c1.confirmed and claimable("t1"))

  // Third review B1: the closure of a `done` ticket is usually seen before /end; the
  // recorded closure confirms it.
  run doneSeenBeforeEndTest =
    init.then(claim("w1", "t1")).then(leg("w1", "implement")).then(leg("w1", "review"))
      .then(leg("w1", "merge"))
      .then(sync1)
      .then(endClaim("w1", "done", true))
      .expect(c1.confirmed)

  // A pushed leg whose evidence never landed: its suspension stays unconfirmed, the ticket
  // is not claimable, and it is flagged for the owner (never stuck silently).
  run lostWriteIsFlaggedNotStuckTest =
    init.then(claim("w1", "t1")).then(advance("w1", "implement"))
      .then(pushEvidence("w1", false))
      .then(endClaim("w1", "suspended", true))
      .then(sync1)
      .expect(not(c1.confirmed) and not(claimable("t1")) and unconfirmedOf("t1").size() == 1)
      .then(ownerResolve(1))
      .expect(claimable("t1"))

  // Sixth review M9's precise rule: backwards means shorter than git showed before, not
  // shorter than the holder's own legs — a push that never landed is lag the holder caused,
  // flagged at confirmation (§6.7), never a regression.
  run lostPushIsNotRegressionTest =
    init.then(claim("w1", "t1")).then(advance("w1", "implement"))
      .then(pushEvidence("w1", false))
      .then(advance("w1", "review"))
      .then(sync1)
      .expect(c1.status == "active" and not(c1.regressed))
}
