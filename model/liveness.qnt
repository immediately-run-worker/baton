// The liveness properties of R3-1243, over the `small` instance, for Apalache's --temporal
// mode. Kept apart from properties.qnt because their fairness terms inline whole actions per
// worker and ticket, which made the safety proof's input too large for Apalache.
module liveness {
  import baton(TICKETS = Set("t1"), WORKERS = Set("w1", "w2"), SLOTS = Set(1),
               MAX_CLAIMS = 3, GIT_BUDGET = 1, OWNER_BUDGET = 1).* from "./baton"
  action linit = init
  action lstep = step

  // Each is stated under weak fairness of every step that resolves it, per worker, so that
  // no other worker's activity can stand in for it (review gate round 1). R-BTN-19, R-BTN-10,
  // §6.7, R-BTN-67, R-BTN-45.
  // R-BTN-19: every fence clears — at the worker's fence-cleared, or at its dead timeout.
  temporal fencesClear =
    WORKERS.forall(w => weakFair(fenceCleared(w) or reapDead(w), st)) implies
      always(TICKETS.forall(t => fencedOf(t).size() > 0 implies eventually(fencedOf(t).size() == 0)))
  // R-BTN-10, §6.7: every completed end is eventually confirmed, by a sync or by the owner.
  temporal endsResolve =
    1.to(MAX_CLAIMS).forall(i => weakFair(ownerResolve(i), st)) implies
      always(st.claims.keys().forall(i => st.claims.get(i).status == "completed" implies
        eventually(st.claims.get(i).confirmed)))
  // R-BTN-67: a ticket held back only by owner bars becomes claimable when they lift.
  temporal barsLiftClaimable =
    weakFair(liftOwnerBars, st) implies
      always(TICKETS.forall(t => (ticketClaimable(t) and WORKERS.forall(w => not(claimableBy(t, w))))
        implies eventually(st.ownerBars.size() == 0)))
  // R-BTN-45: a claimable ticket with a free worker for it is eventually claimed (or stops
  // being claimable), under fairness of each worker's claim.
  temporal readyIsClaimed =
    WORKERS.forall(w => TICKETS.forall(t =>
      weakFair(claimStart(w, t), st) and weakFair(claimFinish(w, "order"), st))) implies
      always(TICKETS.forall(t => WORKERS.exists(w => workerFree(w) and claimableBy(t, w))
        implies eventually(not(ticketClaimable(t)))))
  // A held history accepted within 24 hours (R-BTN-11) is not stated: held histories are not
  // modelled (README).

}
