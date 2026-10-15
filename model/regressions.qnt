// One deterministic run per defect the BATON_SPEC reviews found, each asserting that the
// spec as merged does not reach it (R3-1243 "Tests"). `npm run model` runs them.
module regressions {
  import baton(TICKETS = Set("t1", "t2"), WORKERS = Set("w1", "w2", "w3"), SLOTS = Set(1, 2),
               MAX_CLAIMS = 6, GIT_BUDGET = 2, OWNER_BUDGET = 2).* from "./baton"

  val c1 = st.claims.get(1)
  val c2 = st.claims.get(2)
  val NONE: Set[str] = Set()
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
    init.then(claimStart("w1", "t1")).then(claimStart("w2", "t1"))
      .then(claimFinish("w1", "order")).then(claimFinish("w2", "order"))
      .expect(activeOf("t1").size() == 1 and c1.worker == "w1" and st.lastStep == "claim-refused")

  // R-BTN-52: a failing hook falls back to the default order and changes no gate; a refusing
  // hook refuses.
  run hookFailureFallsBackTest =
    init.then(claimStart("w1", "t1")).then(claimFinish("w1", "fail"))
      .expect(c1.status == "active")
      .then(claimStart("w2", "t2")).then(claimFinish("w2", "refuse"))
      .expect(activeOf("t2").size() == 0)

  // Fourth review B1: an advance into a leg no sync has posted yet (the review loop) is fine;
  // the course file's edges are the check.
  run advanceIntoUnpostedLegTest =
    init.then(claim("w1", "t1")).then(leg("w1", "implement")).then(leg("w1", "review"))
      .then(leg("w1", "fix")).then(leg("w1", "review"))
      .expect(c1.leg == "review" and c1.finished.length() == 3 and st.lastAccepted == 0)

  // Sixth review M8: a suspension whose ticket git has already moved past is confirmed by
  // path extension.
  run gitAheadOfSuspensionConfirmsTest =
    init.then(claim("w1", "t1")).then(leg("w1", "implement"))
      .then(endClaim("w1", "suspended", true))
      .then(foreignPush("t1", "review"))
      .then(sync1)
      .expect(c1.confirmed and c1.station == "pr-open")

  // Fifth review B2 / R-BTN-62: a sync numbered before the claim may not judge it.
  run earlyNumberCannotJudgeClaimTest =
    init.then(withdraw("t1"))
      .then(syncNumber(1)).then(syncRead(1, TICKETS.mapBy(t => NONE)))
      .then(claim("w1", "t1"))
      .then(syncPost(1))
      .expect(c1.status == "active")
      .then(sync1)
      .expect(c1.status == "released" and c1.kind == "stale")

  // Fourth review B4: a holder that advanced past what a slow sync read is neither stale nor
  // regressed when that sync posts.
  run lagIsNotRegressionTest =
    init.then(claim("w1", "t1")).then(leg("w1", "implement"))
      .then(syncNumber(1)).then(syncRead(1, TICKETS.mapBy(t => NONE)))
      .then(leg("w1", "review"))
      .then(syncPost(1)).then(sync1)
      .expect(c1.status == "active" and not(c1.regressed))

  // Sixth review M9: a push that never landed is lag, never a regression.
  run lostPushIsNotRegressionTest =
    init.then(claim("w1", "t1")).then(advance("w1", "implement", NONE, false))
      .then(pushEvidence("w1", false))
      .then(advance("w1", "review", NONE, false))
      .then(sync1)
      .expect(c1.status == "active" and not(c1.regressed))

  // Fifth review B2: max_runs counted from start_path plus the claim's own legs.
  run maxRunsSurviveResumptionTest =
    init.then(claim("w1", "t1")).then(leg("w1", "implement")).then(leg("w1", "review"))
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
    init.then(claim("w1", "t1")).then(leg("w1", "implement")).then(leg("w1", "review"))
      .then(leg("w1", "fix")).then(leg("w1", "review")).then(leg("w1", "fix"))
      .then(leg("w1", "review"))
      .then(advance("w1", "fix", Set("family:b"), false))
      .fail()

  // Sixth review M9: a suspension made while regressed is confirmed by the next snapshot.
  run regressedSuspensionIsConfirmedTest =
    init.then(claim("w1", "t1")).then(leg("w1", "implement"))
      .then(advance("w1", "review", NONE, false))
      .then(sync1).then(regress("t1")).then(sync1)
      .expect(c1.regressed)
      .then(endClaim("w1", "suspended", false))
      .then(sync1)
      .expect(c1.confirmed and ticketClaimable("t1"))

  // Third review B1: the closure of a `done` ticket, seen before /end, confirms it.
  run doneSeenBeforeEndTest =
    init.then(claim("w1", "t1")).then(leg("w1", "implement")).then(leg("w1", "review"))
      .then(leg("w1", "merge"))
      .then(sync1)
      .then(endClaim("w1", "done", true))
      .expect(c1.confirmed)

  // A pushed leg whose evidence never landed is flagged for the owner, never stuck silently.
  run lostWriteIsFlaggedNotStuckTest =
    init.then(claim("w1", "t1")).then(advance("w1", "implement", NONE, false))
      .then(pushEvidence("w1", false))
      .then(endClaim("w1", "suspended", true))
      .then(sync1)
      .expect(not(c1.confirmed) and not(ticketClaimable("t1")) and unconfirmedOf("t1").size() == 1)
      .then(ownerResolve(1))
      .expect(ticketClaimable("t1"))

  // R-BTN-19: a force-reaped ticket is not re-issued until the live worker clears its fence.
  run forceReapFencesTest =
    init.then(claim("w1", "t1")).then(forceReap("w1")).then(sync1)
      .expect(not(ticketClaimable("t1")) and fencedOf("t1").size() == 1)
      .then(fenceCleared("w1"))
      .expect(ticketClaimable("t1"))

  // Fifth review B3 / R-BTN-67: the holder's own bars meet the required bar in one session;
  // without them, before any sync, the advance into `fix` is refused (`policy`).
  run requiredBarMetByHolderBarsTest =
    init.then(claim("w1", "t1")).then(leg("w1", "implement")).then(leg("w1", "review"))
      .then(advance("w1", "fix", Set("family:b"), false))
      .expect(c1.leg == "fix")

  run requiredBarRefusesUnbarredFixTest =
    init.then(claim("w1", "t1")).then(leg("w1", "implement")).then(leg("w1", "review"))
      .then(advance("w1", "fix", NONE, false))
      .fail()

  // Rule 8: a holder cannot bar a family and be of it; a claim+advance owner bar on the
  // holder's tag refuses its advance, a claim-only one does not.
  run holderOfBarredFamilyRefusedTest =
    init.then(claim("w1", "t1")).then(leg("w1", "implement")).then(leg("w1", "review"))
      .then(advance("w1", "fix", Set("family:a"), false))
      .fail()

  run claimOnlyOwnerBarLetsHolderAdvanceTest =
    init.then(claim("w1", "t1")).then(setOwnerBar("family:a", "claim"))
      .then(advance("w1", "implement", NONE, false))
      .expect(c1.leg == "implement")
      .then(claimStart("w3", "t2"))        // w3 is family a: refused new claims
      .fail()

  // §8, rule 3: a hold refuses the holder's next advance.
  run holdRefusesAdvanceTest =
    init.then(claim("w1", "t1")).then(setHold("t1", true))
      .then(advance("w1", "implement", NONE, false))
      .fail()
}
