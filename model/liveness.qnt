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
  // R-BTN-19: every fence clears — at the worker's fence-cleared, or once it has been silent
  // past its timeout. Time is bounded (MAX_TIME), so a fence whose timeout falls past the
  // horizon may still be pending there: the property holds up to the horizon (round 2, 2-A-0).
  temporal fencesClear =
    (weakFair(tick, st) and WORKERS.forall(w => weakFair(fenceCleared(w), st))
      and 1.to(MAX_CLAIMS).forall(i => weakFair(fenceTimeout(i), st))) implies
      always(TICKETS.forall(t => fencedOf(t).size() > 0
        implies eventually(fencedOf(t).size() == 0 or st.now == MAX_TIME)))
  // R-BTN-10, §6.7: every completed end is eventually confirmed, by a sync or by the owner.
  temporal endsResolve =
    1.to(MAX_CLAIMS).forall(i => weakFair(ownerResolve(i), st)) implies
      always(st.claims.keys().forall(i => st.claims.get(i).status == "completed" implies
        eventually(st.claims.get(i).confirmed)))
  // R-BTN-67: a ticket held back only by owner bars — some worker could claim it but for
  // them — becomes claimable by some worker once they lift, unless git or the posted bars
  // change it meanwhile (round 2, 2-A-1: the consequent is claimability, not the lift).
  def claimableButForOwner(t: str, w: str): bool =
    ticketClaimable(t) and readyLegs(t).exists(l => postedBarsOf(t, l).intersect(TAGS.get(w)).size() == 0)
  temporal barsLiftClaimable =
    weakFair(liftOwnerBars, st) implies
      always(TICKETS.forall(t =>
        (WORKERS.exists(w => claimableButForOwner(t, w)) and WORKERS.forall(w => not(claimableBy(t, w))))
          implies eventually(WORKERS.exists(w => claimableBy(t, w))
                             or not(WORKERS.exists(w => claimableButForOwner(t, w))))))
  // R-BTN-45: no free worker stays able to claim a ticket forever without claiming — a worker
  // may sleep or crash, so the property speaks of a worker that stays free (round 2, 2-A-2).
  temporal readyIsClaimed =
    WORKERS.forall(w => TICKETS.forall(t =>
      weakFair(claimStart(w, t), st) and weakFair(claimFinish(w, "order"), st))) implies
      TICKETS.forall(t => WORKERS.forall(w =>
        always(eventually(not(workerFree(w) and claimableBy(t, w))))))
  // A held history accepted within 24 hours (R-BTN-11) is not stated: held histories are not
  // modelled (README).

}
