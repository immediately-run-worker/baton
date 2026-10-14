// Reachability witnesses: each `val` is expected to be VIOLATED by `quint run`, which
// shows the model reaches the state (a property that holds only because the state is
// unreachable is vacuous). `npm run model` checks the first three it can reach by random
// simulation (a suspension confirmed, a claim regressed, a claim resumed); a merge, a
// second review and a confirmed `done` take long specific sequences, which the regression
// runs reach deterministically (maxRunsSurviveResumptionTest, doneSeenBeforeEndTest).
module witnesses {
  import baton.* from "./baton"
  val noMerge = TICKETS.forall(t => not(atEnd(gitPath.get(t))))
  val noConfirmedSuspension = claims.keys().forall(i =>
    not(claims.get(i).confirmed and claims.get(i).kind == "suspended" and claims.get(i).confirmObs > 0))
  val noRegressedClaim = claims.keys().forall(i => not(claims.get(i).regressed))
  val noSecondReview = TICKETS.forall(t => runs(gitPath.get(t), "review") < 2)
  val noResumedClaim = claims.keys().forall(i => claims.get(i).startPath.length() == 0)
  val noConfirmedDone = claims.keys().forall(i =>
    not(claims.get(i).confirmed and claims.get(i).kind == "done" and claims.get(i).confirmObs > 0))
}
