// One deterministic run per defect the BATON_SPEC reviews found, each asserting that the
// spec as merged does not reach it (R3-1243 "Tests"). `npm run model` runs them.
module regressions {
  import baton(TICKETS = Set("t1", "t2"), WORKERS = Set("w1", "w2", "w3"), SLOTS = Set(1, 2),
               MAX_CLAIMS = 6, GIT_BUDGET = 2, OWNER_BUDGET = 2,
               FAMILIES = Set("family:a", "family:b"), TAGS = Map("w1" -> Set("family:a"), "w2" -> Set("family:b"), "w3" -> Set("family:a")),
               REQUIRED = Set("fix", "merge"), MAX_TIME = 12).* from "./baton"

  val c1 = st.claims.get(1)
  val c2 = st.claims.get(2)
  val NONE: Set[str] = Set()
  // a deterministic start: no worker's clock drifts
  action start: bool = initWith(WORKERS.mapBy(w => 0))
  // a claim whose hook orders it (no refusal)
  action claim(w: str, t: str): bool = claimStart(w, t).then(claimFinish(w, "order"))
  // start `l` and push its evidence so it lands; a writing leg bars family b (w1 is family a)
  action leg(w: str, l: str): bool =
    advance(w, l, if (REQUIRED.contains(l)) Set("family:b") else NONE, false)
      .then(pushEvidence(w, true))
  action sync1: bool =
    syncNumber(1).then(syncRead(1, TICKETS.mapBy(t => Set("family:b")))).then(syncPost(1))

  // Fifth review B3 / R-BTN-52: a hook call is an await. Two workers start claims on one
  // ticket; both hooks return; the gates re-checked after the second find the first's claim.
  run claimDuringHookCallTest =
    start.then(claimStart("w1", "t1")).then(claimStart("w2", "t1"))
      .then(claimFinish("w1", "order")).then(claimFinish("w2", "order"))
      .expect(activeOf("t1").size() == 1 and c1.worker == "w1" and st.pending.get("w2") == "" and workerClaim("w2").size() == 0)

  // R-BTN-52: a failing hook falls back to the default order and changes no gate; a refusing
  // hook refuses.
  run hookFailureFallsBackTest =
    start.then(claimStart("w1", "t1")).then(claimFinish("w1", "fail"))
      .expect(c1.status == "active")
      .then(claimStart("w2", "t2")).then(claimFinish("w2", "refuse"))
      .expect(activeOf("t2").size() == 0)

  // Fourth review B1: an advance into a leg no sync has posted yet (the review loop) is fine;
  // the course file's edges are the check.
  run advanceIntoUnpostedLegTest =
    start.then(claim("w1", "t1")).then(leg("w1", "implement")).then(leg("w1", "review"))
      .then(leg("w1", "fix")).then(leg("w1", "review"))
      .expect(c1.leg == "review" and c1.finished.length() == 3 and st.lastAccepted == 0)

  // Sixth review M8: a suspension whose ticket git has already moved past is confirmed by
  // path extension.
  run gitAheadOfSuspensionConfirmsTest =
    start.then(claim("w1", "t1")).then(leg("w1", "implement"))
      .then(endClaim("w1", "suspended", true))
      .then(foreignPush("t1", "review"))
      .then(sync1)
      .expect(c1.confirmed and c1.station == "pr-open")

  // Fifth review B2 / R-BTN-62: a sync numbered before the claim may not judge it.
  run earlyNumberCannotJudgeClaimTest =
    start.then(withdraw("t1"))
      .then(syncNumber(1)).then(syncRead(1, TICKETS.mapBy(t => NONE)))
      .then(claim("w1", "t1"))
      .then(syncPost(1))
      .expect(c1.status == "active")
      .then(sync1)
      .expect(c1.status == "released" and c1.kind == "stale")

  // Fourth review B4: a holder that advanced past what a slow sync read is neither stale nor
  // regressed when that sync posts.
  run lagIsNotRegressionTest =
    start.then(claim("w1", "t1")).then(leg("w1", "implement"))
      .then(syncNumber(1)).then(syncRead(1, TICKETS.mapBy(t => NONE)))
      .then(leg("w1", "review"))
      .then(syncPost(1)).then(sync1)
      .expect(c1.status == "active" and not(c1.regressed))

  // Sixth review M9: a push that never landed is lag, never a regression.
  run lostPushIsNotRegressionTest =
    start.then(claim("w1", "t1")).then(advance("w1", "implement", NONE, false))
      .then(pushEvidence("w1", false))
      .then(advance("w1", "review", NONE, false))
      .then(sync1)
      .expect(c1.status == "active" and not(c1.regressed))

  // Fifth review B2: max_runs counted from start_path plus the claim's own legs.
  run maxRunsSurviveResumptionTest =
    start.then(claim("w1", "t1")).then(leg("w1", "implement")).then(leg("w1", "review"))
      .then(leg("w1", "fix")).then(leg("w1", "review")).then(leg("w1", "fix"))
      .then(leg("w1", "review"))
      .then(endClaim("w1", "suspended", true))
      .then(sync1)
      .expect(c1.confirmed)
      .then(claim("w2", "t1"))
      .expect(c2.startPath.length() == 6 and c2.station == "reviewed")
      .then(advance("w2", "adjudicate", NONE, false))
      .expect(c2.leg == "adjudicate")

  run fixRefusedAtItsLimitTest =
    start.then(claim("w1", "t1")).then(leg("w1", "implement")).then(leg("w1", "review"))
      .then(leg("w1", "fix")).then(leg("w1", "review")).then(leg("w1", "fix"))
      .then(leg("w1", "review"))
      .then(advance("w1", "fix", Set("family:b"), false))
      .fail()

  // Sixth review M9: a suspension made while regressed is confirmed by the next snapshot.
  run regressedSuspensionIsConfirmedTest =
    start.then(claim("w1", "t1")).then(leg("w1", "implement"))
      .then(advance("w1", "review", NONE, false))
      .then(sync1).then(regress("t1")).then(sync1)
      .expect(c1.regressed)
      .then(endClaim("w1", "suspended", false))
      .then(sync1)
      .expect(c1.confirmed and ticketClaimable("t1"))

  // Third review B1: the closure of a `done` ticket, seen before /end, confirms it.
  run doneSeenBeforeEndTest =
    start.then(claim("w1", "t1")).then(leg("w1", "implement")).then(leg("w1", "review"))
      .then(leg("w1", "merge"))
      .then(sync1)
      .then(endClaim("w1", "done", true))
      .expect(c1.confirmed)

  // A pushed leg whose evidence never landed is flagged for the owner, never stuck silently.
  run lostWriteIsFlaggedNotStuckTest =
    start.then(claim("w1", "t1")).then(advance("w1", "implement", NONE, false))
      .then(pushEvidence("w1", false))
      .then(endClaim("w1", "suspended", true))
      .then(sync1)
      .expect(not(c1.confirmed) and not(ticketClaimable("t1")) and unconfirmedOf("t1").size() == 1)
      .then(ownerResolve(1))
      .expect(ticketClaimable("t1"))

  // R-BTN-19: a force-reaped ticket is not re-issued until the live worker clears its fence.
  run forceReapFencesTest =
    start.then(claim("w1", "t1")).then(forceReap("w1")).then(sync1)
      .expect(not(ticketClaimable("t1")) and fencedOf("t1").size() == 1)
      .then(fenceCleared("w1"))
      .expect(ticketClaimable("t1"))

  // Fifth review B3 / R-BTN-67: the holder's own bars meet the required bar in one session;
  // without them, before any sync, the advance into `fix` is refused (`policy`).
  run requiredBarMetByHolderBarsTest =
    start.then(claim("w1", "t1")).then(leg("w1", "implement")).then(leg("w1", "review"))
      .then(advance("w1", "fix", Set("family:b"), false))
      .expect(c1.leg == "fix")

  run requiredBarRefusesUnbarredFixTest =
    start.then(claim("w1", "t1")).then(leg("w1", "implement")).then(leg("w1", "review"))
      .then(advance("w1", "fix", NONE, false))
      .fail()

  // Rule 8: a holder cannot bar a family and be of it; a claim+advance owner bar on the
  // holder's tag refuses its advance, a claim-only one does not.
  run holderOfBarredFamilyRefusedTest =
    start.then(claim("w1", "t1")).then(leg("w1", "implement")).then(leg("w1", "review"))
      .then(advance("w1", "fix", Set("family:a"), false))
      .fail()

  run claimOnlyOwnerBarLetsHolderAdvanceTest =
    start.then(claim("w1", "t1")).then(setOwnerBar("family:a", "claim"))
      .then(advance("w1", "implement", NONE, false))
      .expect(c1.leg == "implement")
      .then(claimStart("w3", "t2"))        // w3 is family a: refused new claims
      .fail()

  // §8, rule 3: a hold refuses the holder's next advance.
  run holdRefusesAdvanceTest =
    start.then(claim("w1", "t1")).then(setHold("t1", true))
      .then(advance("w1", "implement", NONE, false))
      .fail()

  // baton#10 review, round 1 (1-A-0): with two sync runs overlapping, a higher number read
  // earlier could be posted later and flag a holder's progress as a regression. BATON_SPEC
  // R-BTN-62 (amended 2026-10-15) refuses a second number while one is outstanding.
  run overlappingSyncRunsRefusedTest =
    start.then(claim("w1", "t1")).then(advance("w1", "implement", NONE, false))
      .then(syncNumber(1)).then(syncNumber(2))
      .fail()

  // ... and a number Baton voided (left outstanding too long) is refused when it is posted.
  run voidedNumberRefusedTest =
    start.then(syncNumber(1)).then(syncRead(1, TICKETS.mapBy(t => NONE))).then(syncVoid(1))
      .then(syncPost(1))
      .expect(st.lastAccepted == 0)
      .then(syncNumber(2))
      .expect(st.syncs.get(2).phase == "numbered")

  // baton#10 review (1-A-3, 1-B-3): a sleeping worker whose lease the alarm reaped wakes and
  // cannot push — its own fence check, at MARGIN before the lease's end by its clock, stops it.
  run sleepingWorkerReapedCannotActTest =
    start.then(claim("w1", "t1")).then(advance("w1", "implement", NONE, false))
      .then(sleep("w1")).then(tick).then(tick).then(tick).then(tick)
      .then(alarmReap(1)).then(wake("w1"))
      .expect(c1.status == "reaped")
      .then(pushEvidence("w1", true))
      .fail()

  // baton#10 round 2 (2-A-0) / R-BTN-19: a force-reaped worker that sleeps is silent past its
  // timeout; its fence clears by time, the ticket is re-issued, and when it wakes its own
  // fence check stops it pushing.
  run sleeperFenceTimesOutTest =
    start.then(claim("w1", "t1")).then(advance("w1", "implement", NONE, false))
      .then(forceReap("w1")).then(sleep("w1"))
      .then(tick).then(tick).then(tick).then(tick)
      .then(fenceTimeout(1)).then(sync1)
      .expect(fencedOf("t1").size() == 0 and ticketClaimable("t1"))
      .then(claim("w2", "t1")).then(wake("w1"))
      .then(pushEvidence("w1", true))
      .fail()

  // ... while a fenced worker that keeps heartbeating keeps its fence.
  run heartbeatingFenceHoldsTest =
    start.then(claim("w1", "t1")).then(forceReap("w1"))
      .then(tick).then(tick).then(heartbeat("w1")).then(tick).then(tick)
      .then(fenceTimeout(1))
      .fail()

  // The drift edge: a worker whose clock runs MAX_DRIFT behind may act until its clock
  // reaches lease end − MARGIN, which is still before Baton's reap.
  run driftEdgeTest =
    initWith(WORKERS.mapBy(w => if (w == "w1") MAX_DRIFT else 0))
      .then(claim("w1", "t1")).then(advance("w1", "implement", NONE, false))
      .then(tick).then(tick)
      .then(pushEvidence("w1", true))
      .expect(not(st.actedAfterLoss))
      .then(advance("w1", "review", NONE, false))
      .then(tick)
      .then(pushEvidence("w1", true))
      .fail()
}
