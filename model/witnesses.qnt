// Reachability witnesses: each `val` is expected to be VIOLATED by `quint run` — the state is
// reached — or the safety properties would hold only because the runs never get there.
// `npm run model` checks them. Kept apart from properties.qnt so the safety proof's input to
// Apalache stays small. The instance is `sim`'s.
module witnesses {
  import baton(TICKETS = Set("t1", "t2"), WORKERS = Set("w1", "w2", "w3"), SLOTS = Set(1, 2),
               MAX_CLAIMS = 6, GIT_BUDGET = 2, OWNER_BUDGET = 2).* from "./baton"
  action winit = init
  action wstep = step
  action wprogress = progressStep

  val noConfirmedSuspension = st.claims.keys().forall(i =>
    not(st.claims.get(i).confirmed and st.claims.get(i).kind == "suspended" and st.claims.get(i).confirmObs > 0))
  // reached deterministically by regressions.qnt (regressedSuspensionIsConfirmedTest)
  val noRegressedClaim = st.claims.keys().forall(i => not(st.claims.get(i).regressed))
  val noResumedClaim = st.claims.keys().forall(i => st.claims.get(i).startPath.length() == 0)
  val noFence = TICKETS.forall(t => fencedOf(t).size() == 0)
  // the deep states (progressStep reaches them; the safety run must, or it is vacuous)
  val noMerge = TICKETS.forall(t => not(atEnd(st.gitPath.get(t))))
  val noFixLeg = st.claims.keys().forall(i => st.claims.get(i).leg != "fix")
  val noSecondReview = TICKETS.forall(t => runs(st.gitPath.get(t), "review") < 2)
  val noConfirmedDone = st.claims.keys().forall(i =>
    not(st.claims.get(i).confirmed and st.claims.get(i).kind == "done" and st.claims.get(i).confirmObs > 0))
  val noAlarmReap = st.claims.keys().forall(i =>
    not(st.claims.get(i).kind == "reap" and not(st.claims.get(i).fencePending) and st.up.get(st.claims.get(i).worker)))
}
