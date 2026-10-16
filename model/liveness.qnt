// The liveness properties of R3-1243, over the `small` instance, for Apalache's --temporal
// mode. Kept apart from properties.qnt because their fairness terms inline whole actions per
// worker and ticket, which made the safety proof's input too large for Apalache.
module liveness {
  import baton(TICKETS = Set("t1"), WORKERS = Set("w1", "w2"), SLOTS = Set(1),
               MAX_CLAIMS = 3, GIT_BUDGET = 1, OWNER_BUDGET = 1,
               FAMILIES = Set("family:a", "family:b"), TAGS = Map("w1" -> Set("family:a"), "w2" -> Set("family:b"), "w3" -> Set("family:a")),
               REQUIRED = Set("fix", "merge"), MAX_TIME = 12).* from "./baton"
  action linit = init
  action lstep = step

  // Each is stated under weak fairness of every step that resolves it, per worker, so that
  // no other worker's activity can stand in for it (review gate round 1). R-BTN-19, R-BTN-10,
  // §6.7, R-BTN-67, R-BTN-45.
  // R-BTN-19: every fence clears — at the worker's fence-cleared, or once it has been silent
  // past its timeout. Time is bounded (MAX_TIME), so only a fence whose timeout itself falls
  // past the horizon — its worker kept heartbeating — may still stand at the end
  // (round 3, 3-A-0: the round-2 escape `now == MAX_TIME` made this a tautology; with
  // fenceTimeout deleted, a crashed fenced worker now falsifies it).
  def fencesBeyondHorizon(t: str): bool =
    fencedOf(t).forall(i => st.claims.get(i).leaseUntil > MAX_TIME)
  temporal fencesClear =
    (weakFair(tick, st) and WORKERS.forall(w => weakFair(fenceCleared(w), st))
      and 1.to(MAX_CLAIMS).forall(i => weakFair(fenceTimeout(i), st))) implies
      always(TICKETS.forall(t => fencedOf(t).size() > 0
        implies eventually(fencedOf(t).size() == 0 or fencesBeyondHorizon(t))))
  // R-BTN-10, §6.7: every completed end is eventually confirmed, by a sync or by the owner.
  // As stated it rests on the owner: weak fairness of ownerResolve implies it alone (round 3,
  // 3-A-2), which is the spec's design — an end no sync can confirm is flagged for the owner
  // (§6.7). The stronger property — under fairness of the sync cycle and with no owner, every
  // end whose evidence landed is confirmed — is R3-1254's.
  temporal endsResolveWithOwner =
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
  // R-BTN-45: a free worker able to claim a ticket — with claim ids left — sees it claimed
  // (by itself or another), stop being claimable, or the worker sleeps or dies. Strong
  // fairness of the hook's ordering finish, because a refusing finish disables it in between
  // (round 3, 3-A-1: the round-2 form was implied by claimStart alone and false at the bound).
  temporal readyIsClaimed =
    WORKERS.forall(w => TICKETS.forall(t =>
      weakFair(claimStart(w, t), st) and strongFair(claimFinish(w, "order"), st))) implies
      TICKETS.forall(t => WORKERS.forall(w =>
        always((workerFree(w) and claimableBy(t, w) and st.nextId <= MAX_CLAIMS) implies
          eventually(activeOf(t).size() > 0 or not(claimableBy(t, w))
                     or not(st.up.get(w)) or st.asleep.get(w)))))
  // A held history accepted within 24 hours (R-BTN-11) is not stated: held histories are not
  // modelled (README).

}
