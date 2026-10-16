// The traces test/model/replay.test.ts drives the core with (R3-1244): `sim`'s instance, and a
// step relation of the actions the harness can make Baton take — every action of `step` but
// three, each left out because the core cannot be driven through it yet, not because it fails:
//   - a hook that refuses (`claimFinish(w, "refuse")`): core calls no claim hook until R3-1236;
//     `fail` is core's default order, so it stays;
//   - `syncVoid` at any moment: Baton voids a number only by its clock (10 minutes, R-BTN-62);
//     with a model tick at 225 s of Baton's clock (four make the shortest lease, 900 s), time
//     does not pass a third tick while a number is outstanding, so no number is voided;
//   - an alarm reap or fence timeout while another claim or fence has also lapsed: Baton's one
//     alarm reaps every lapsed lease at once, where the model reaps one per step.
// Baton also renews a lease on every authenticated call, not only on heartbeats and claims as
// §6.3 states it (the safe side: it reaps later); `seen` keeps each worker's last call, and a
// generated trace reaps a claim only when its worker is silent by both readings. A force-reap of
// a worker already silent past its lease is not fenced in Baton — R-BTN-19's fence that has
// already timed out, the model's forceReap and fenceTimeout in one step — so generated traces
// force-reap only a worker Baton still hears from.
module replay {
  import baton(TICKETS = Set("t1", "t2"), WORKERS = Set("w1", "w2", "w3"), SLOTS = Set(1, 2),
               MAX_CLAIMS = 6, GIT_BUDGET = 2, OWNER_BUDGET = 2,
               FAMILIES = Set("family:a", "family:b"), TAGS = Map("w1" -> Set("family:a"), "w2" -> Set("family:b"), "w3" -> Set("family:a")),
               REQUIRED = Set("fix", "merge"), MAX_TIME = 24).* from "./baton"

  // the tick of each worker's last authenticated call to Baton
  var seen: str -> int
  // the tick each sync run took its number at
  var numbered: int -> int

  action rinit = all { initWith(WORKERS.mapBy(w => 0)), seen' = WORKERS.mapBy(w => 0), numbered' = SLOTS.mapBy(s => 0) }
  action called(w: str): bool = all { seen' = seen.set(w, st.now), numbered' = numbered }
  action quiet: bool = all { seen' = seen, numbered' = numbered }
  action takes(s: int): bool = all { seen' = seen, numbered' = numbered.set(s, st.now) }
  // a tick that leaves every outstanding number under Baton's 10 minutes (two ticks, 450 s)
  def timeMayPass: bool = SLOTS.forall(s => not(outstanding(s)) or st.now + 1 - numbered.get(s) <= 2)

  // a lease lapsed by both readings: the model's and Baton's last call
  def lapsed(i: int): bool = {
    val c = st.claims.get(i)
    c.leaseUntil <= st.now and seen.get(c.worker) + TIMEOUT <= st.now
  }
  def lapsedActive: Set[int] = claimsWhere(c => c.status == "active" and c.leaseUntil <= st.now)
  def lapsedFences: Set[int] = claimsWhere(c => c.status == "reaped" and c.fencePending and c.leaseUntil <= st.now)

  action rstep = {
    nondet w = WORKERS.oneOf()
    nondet t = TICKETS.oneOf()
    nondet leg = LEGS.oneOf()
    nondet s = SLOTS.oneOf()
    nondet b = Set(true, false).oneOf()
    nondet kind = Set("done", "suspended", "release").oneOf()
    nondet hook = Set("order", "fail").oneOf()
    nondet holderBars = FAMILIES.powerset().oneOf()
    nondet postBars = TICKETS.setOfMaps(FAMILIES.powerset()).oneOf()
    nondet tag = FAMILIES.oneOf()
    nondet applies = Set("claim", "claim+advance").oneOf()
    nondet i = 1.to(MAX_CLAIMS).oneOf()
    any {
      all { claimStart(w, t), quiet },
      all { claimFinish(w, hook), called(w) },
      all { pushEvidence(w, b), quiet },
      all { advance(w, leg, holderBars, false), called(w) },
      all { endClaim(w, kind, b), called(w) },
      all { heartbeat(w), called(w) },
      all { sleep(w), quiet }, all { wake(w), quiet }, all { timeMayPass, tick, quiet },
      all { st.claims.keys().contains(i), lapsed(i), lapsedActive == Set(i), lapsedFences.size() == 0, alarmReap(i), quiet },
      all { crash(w), quiet }, all { reapDead(w), quiet },
      all { seen.get(w) + TIMEOUT > st.now, forceReap(w), quiet },
      all { fenceCleared(w), called(w) },
      all { st.claims.keys().contains(i), lapsed(i), lapsedFences == Set(i), lapsedActive.size() == 0, fenceTimeout(i), quiet },
      all { setHold(t, b), quiet }, all { setOwnerBar(tag, applies), quiet }, all { liftOwnerBars, quiet },
      all { ownerResolve(i), quiet },
      all { foreignPush(t, leg), quiet }, all { regress(t), quiet }, all { withdraw(t), quiet },
      all { syncNumber(s), takes(s) }, all { syncRead(s, postBars), quiet }, all { syncPost(s), quiet },
    }
  }

  // The happy path's actors, as progressStep is to step: claims, legs on pushes that land, ends,
  // the sync, git's regressions, and the owner — so drawn traces reach legs, ends, confirmations,
  // regressions and reaps, which the full relation's crashes and sleeps rarely leave room for.
  // Every run of it is a run of rstep.
  // the legs leaving where w's claim is — drawing from these makes advances likely
  def legChoices(w: str): Set[str] =
    if (workerClaim(w).size() == 1) {
      val c = theClaim(w)
      val ls = legsFrom(if (c.leg == "") c.station else TO.get(c.leg))
      if (ls.size() > 0) ls else LEGS
    } else LEGS

  action rprogress = {
    nondet w = WORKERS.oneOf()
    nondet t = TICKETS.oneOf()
    nondet leg = legChoices(w).oneOf()
    nondet kind = Set("done", "suspended", "release").oneOf()
    nondet holderBars = FAMILIES.powerset().oneOf()
    nondet postBars = TICKETS.setOfMaps(FAMILIES.powerset().exclude(Set(Set()))).oneOf()
    nondet i = 1.to(MAX_CLAIMS).oneOf()
    any {
      all { claimStart(w, t), quiet },
      all { claimFinish(w, "order"), called(w) },
      // listed more than once: a random run picks among the enabled branches, and legs need
      // a push and an advance in turn, where a claim needs one step
      all { pushEvidence(w, true), quiet }, all { pushEvidence(w, true), quiet }, all { pushEvidence(w, true), quiet },
      all { advance(w, leg, holderBars, false), called(w) }, all { advance(w, leg, holderBars, false), called(w) },
      all { advance(w, leg, holderBars, false), called(w) }, all { advance(w, leg, holderBars, false), called(w) },
      all { endClaim(w, kind, true), called(w) },
      all { heartbeat(w), called(w) },
      all { syncNumber(1), takes(1) }, all { syncRead(1, postBars), quiet }, all { syncPost(1), quiet },
      all { regress(t), quiet },
      all { timeMayPass, tick, quiet },
      all { st.claims.keys().contains(i), lapsed(i), lapsedActive == Set(i), lapsedFences.size() == 0, alarmReap(i), quiet },
      all { seen.get(w) + TIMEOUT > st.now, forceReap(w), quiet },
      all { fenceCleared(w), called(w) },
      all { ownerResolve(i), quiet },
    }
  }
}
