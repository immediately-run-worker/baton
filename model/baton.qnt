// Baton's core as a state machine (R3-1243), against BATON_SPEC in immediately-run/docs as
// merged at b7537395 (docs#212). Every action and helper names the requirement it models.
//
// Modelled: claims and the lease (R-BTN-4); the course file's stations and legs (R-BTN-69);
// a claim's hook call as an await other actions interleave with, and the gates re-checked
// after it (§3, R-BTN-52, R-BTN-55); advance on the holder's word with per-leg max_runs
// counted from start_path (R-BTN-63); ends naming the station reached (R-BTN-71); git first
// (R-BTN-8); observation numbers and whole-post acceptance (R-BTN-62); confirmation by path
// extension (R-BTN-10, R-BTN-71); staleness only when the ticket is taken away and
// regressions flagged (R-BTN-35, §2e); holds (§8, rule 3); barred tags — posted, owner and
// holder bars (R-BTN-60, R-BTN-67, rule 8); required bars (R-BTN-67); hook refusal and
// failure (R-BTN-45, R-BTN-52, rule 12); reaping a dead worker and force-reaping a live one,
// with the fence (§6.6, R-BTN-19, R-BTN-26); any pusher writing git (R-BTN-66); the owner
// resolving a flagged completion (§6.7).
// Abstracted: wall-clock time (timeouts and the 30-minute and 6-hour flags are
// "eventually"), held histories (R-BTN-11), more than one repository (R-BTN-61), course
// changes and renames (R-BTN-64), tiers, grants and requires (rules 4-7). README.md says why.
module baton {
  // ---- sizes, set by the instance (instances.qnt; regressions.qnt) ----
  const TICKETS: Set[str]
  const WORKERS: Set[str]
  const SLOTS: Set[int]          // sync runs that may overlap (§7.1)
  const MAX_CLAIMS: int          // bounds the state space
  const GIT_BUDGET: int          // foreign pushes, regressions and withdrawals per run
  const OWNER_BUDGET: int        // holds, owner bars and force-reaps per run

  // ---- the course: roadmap-pr's course.json (BATON_SPEC §2e, R-BTN-69) ----
  pure val START = "filed"
  pure val ENDS = Set("merged")
  pure val LEGS = Set("implement", "review", "fix", "adjudicate", "merge")
  pure val FROM: str -> Set[str] = Map(
    "implement" -> Set("filed"),
    "review" -> Set("pr-open", "fixed"),
    "fix" -> Set("reviewed"),
    "adjudicate" -> Set("reviewed"),
    "merge" -> Set("reviewed", "adjudicated"))
  pure val TO: str -> str = Map(
    "implement" -> "pr-open", "review" -> "reviewed", "fix" -> "fixed",
    "adjudicate" -> "adjudicated", "merge" -> "merged")
  // max_runs; 99 stands for none, which R-BTN-69 allows only off every cycle
  pure val MAX_RUNS: str -> int = Map(
    "implement" -> 99, "review" -> 3, "fix" -> 2, "adjudicate" -> 99, "merge" -> 99)

  // ---- time (§6.3, R-BTN-6, R-BTN-26), in abstract ticks ----
  // A lease lasts TIMEOUT ticks from the last heartbeat. A worker's own fence check refuses to
  // act MARGIN ticks before its lease ends by ITS clock, which runs up to MAX_DRIFT ticks
  // behind Baton's. The spec's margin is 4 minutes; the assumption it rests on — drift below
  // the margin — is MAX_DRIFT <= MARGIN here (Baton reaps at the lease end; the worker stops
  // strictly before end − MARGIN by its clock), and a mutation with MAX_DRIFT > MARGIN breaks
  // `noActAfterLoss`.
  pure val TIMEOUT = 4
  pure val MARGIN = 2
  pure val MAX_DRIFT = 1
  pure val MAX_TIME = 12

  // ---- tags (R-BTN-60): course-defined strings core only compares ----
  pure val FAMILIES = Set("family:a", "family:b")
  pure val TAGS: str -> Set[str] = Map("w1" -> Set("family:a"), "w2" -> Set("family:b"),
                                       "w3" -> Set("family:a"))
  // docs' required bar {course: 'roadmap-pr', leg: '*', except: [implement, review,
  // adjudicate], tag_prefix: 'family:'} (R-BTN-67): the legs it covers
  pure val REQUIRED = LEGS.exclude(Set("implement", "review", "adjudicate"))

  // ---- path helpers ----
  pure def stationOf(p: List[str]): str = p.foldl(START, (s, l) => TO.get(l))
  pure def runs(p: List[str], leg: str): int = p.select(x => x == leg).length()
  pure def isPrefix(p: List[str], q: List[str]): bool =
    p.length() <= q.length() and p.indices().forall(i => p[i] == q[i])
  pure def validPath(q: List[str]): bool =
    q.indices().forall(i => FROM.get(q[i]).contains(stationOf(q.slice(0, i))))
  // R-BTN-71: q extends p — begins with it and continues, if at all, by edges
  pure def extendsPath(p: List[str], q: List[str]): bool = isPrefix(p, q) and validPath(q)
  pure def legsFrom(st: str): Set[str] = LEGS.filter(l => FROM.get(l).contains(st))
  pure def atEnd(p: List[str]): bool = ENDS.contains(stationOf(p))
  // §2e: the legs a ticket may still run from where path p leaves it
  pure def nextLegs(p: List[str]): Set[str] =
    if (atEnd(p)) Set() else legsFrom(stationOf(p)).filter(l => runs(p, l) < MAX_RUNS.get(l))

  // ---- state ----
  type Claim = {
    id: int, ticket: str, worker: str,
    status: str,         // active | completed | released | reaped
    kind: str,           // "" | done | suspended | stale | release | reap
    station: str,        // R-BTN-63: the last station it reached
    leg: str,            // the leg it is running; "" for none
    startBars: Set[str], // the running leg's family bars when it started: posted plus the holder's
    startPath: List[str],
    finished: List[str], // claim_legs it finished, in order
    claimObs: int,       // counter at the claim or its latest advance (R-BTN-62)
    endObs: int,
    regressed: bool,     // regressed_since IS NOT NULL (§2e)
    endedRegressed: bool,
    confirmed: bool,
    confirmObs: int,     // the observation that confirmed it; -1 for the owner
    fencePending: bool,  // R-BTN-19: reaped while its worker was alive
    leaseUntil: int,     // R-BTN-4: Baton reaps the claim at this tick unless a heartbeat renews it
    gateViolation: bool, // ghost: the claim or one of its advances was granted with a gate failing
  }
  type Sync = { phase: str, obs: int, git: str -> List[str], gone: str -> bool,
                bars: str -> Set[str], voided: bool }
  type Bar = { tag: str, applies: str }   // owner bar (R-BTN-67): claim | claim+advance
  type State = {
    // git (the truth)
    gitPath: str -> List[str], withdrawn: str -> bool, gitBudget: int,
    // Baton
    counter: int,                    // last observation number handed out
    lastAccepted: int,
    posted: str -> List[str],        // ticket_stations.path of the head snapshot
    postedGone: str -> bool,         // closed_tickets withdrawn
    postedBars: str -> Set[str],     // ticket_bars for the writing legs (REQUIRED)
    claims: int -> Claim, nextId: int,
    held: str -> bool,               // ticket_overrides.hold (§8)
    ownerBars: Set[Bar], ownerBudget: int,
    // workers
    up: str -> bool,                 // alive (a crash makes it false)
    pushed: str -> bool,             // evidence of the running leg pushed (R-BTN-8)
    pending: str -> str,             // a claim awaiting its hook: worker -> ticket ("" none)
    asleep: str -> bool,             // a sleeping laptop: alive, silent, unable to act
    localClaim: str -> int,          // the claim the worker believes it holds (0: none)
    localLease: str -> int,          // the lease end the worker last heard (R-BTN-26)
    drift: str -> int,               // how far its clock runs behind Baton's (0..MAX_DRIFT)
    now: int,                        // Baton's clock
    // sync runs
    syncs: int -> Sync,
    // ghosts
    accepted: List[int], gitRegressedEver: str -> bool,
    actedAfterLoss: bool,            // a worker pushed for a claim Baton had reaped, unfenced
  }
  var st: State

  // ---- derived ----
  def claimsWhere(p: Claim => bool): Set[int] = st.claims.keys().filter(i => p(st.claims.get(i)))
  def activeOf(t: str): Set[int] = claimsWhere(c => c.ticket == t and c.status == "active")
  def workerClaim(w: str): Set[int] = claimsWhere(c => c.worker == w and c.status == "active")
  def fencedOf(t: str): Set[int] =
    claimsWhere(c => c.ticket == t and c.status == "reaped" and c.fencePending)
  def workerFenced(w: str): bool =
    claimsWhere(c => c.worker == w and c.status == "reaped" and c.fencePending).size() > 0
  def unconfirmedOf(t: str): Set[int] =
    claimsWhere(c => c.ticket == t and c.status == "completed" and not(c.confirmed))
  def maxEndObs(t: str): int =
    claimsWhere(c => c.ticket == t and c.status != "active")
      .fold(-1, (m, i) => if (st.claims.get(i).endObs > m) st.claims.get(i).endObs else m)
  pure def expected(c: Claim): List[str] = c.startPath.concat(c.finished)
  def theClaim(w: str): Claim = st.claims.get(workerClaim(w).fold(0, (a, i) => i))

  // R-BTN-60, R-BTN-67, rule 8: the tags barred from `leg` of `t` at a claim or an advance
  def postedBarsOf(t: str, leg: str): Set[str] =
    if (REQUIRED.contains(leg)) st.postedBars.get(t) else Set()
  def ownerBarTags(phase: str): Set[str] =
    st.ownerBars.filter(b => phase == "claim" or b.applies == "claim+advance").map(b => b.tag)
  def barred(t: str, leg: str, phase: str, holderBars: Set[str]): Set[str] =
    postedBarsOf(t, leg).union(ownerBarTags(phase)).union(holderBars)
  // R-BTN-67: a covered leg whose bars hold no family tag is waiting on `policy`
  def policyOk(t: str, leg: str, holderBars: Set[str]): bool =
    not(REQUIRED.contains(leg)) or postedBarsOf(t, leg).union(holderBars).intersect(FAMILIES).size() > 0
  // §2e, R-BTN-70: the ready legs leaving the posted station
  def readyLegs(t: str): Set[str] = nextLegs(st.posted.get(t)).filter(l => policyOk(t, l, Set()))

  // §7.2 rules 1, 3, 10 and §6.7: the gates of a ticket, whoever asks
  def ticketClaimable(t: str): bool = and {
    not(st.postedGone.get(t)), not(st.held.get(t)),
    readyLegs(t).size() > 0,
    activeOf(t).size() == 0, fencedOf(t).size() == 0, unconfirmedOf(t).size() == 0,
    st.lastAccepted > maxEndObs(t),
  }
  // ... and rule 8 for this worker: at least one ready leg it is not barred from
  def claimableBy(t: str, w: str): bool =
    ticketClaimable(t) and readyLegs(t).exists(l => barred(t, l, "claim", Set()).intersect(TAGS.get(w)).size() == 0)
  def workerFree(w: str): bool =
    st.up.get(w) and not(st.asleep.get(w)) and workerClaim(w).size() == 0 and not(workerFenced(w))
      and st.pending.get(w) == "" and st.localClaim.get(w) == 0
  // R-BTN-6, R-BTN-26: a worker acts only while its lease, by its own clock, is more than
  // MARGIN from its end
  def workerCanAct(w: str): bool =
    st.up.get(w) and not(st.asleep.get(w)) and st.localClaim.get(w) != 0
      and st.now - st.drift.get(w) < st.localLease.get(w) - MARGIN
  // §7.1, R-BTN-62 as amended 2026-10-15: one reading in flight per repository
  def outstanding(s: int): bool =
    (st.syncs.get(s).phase == "numbered" or st.syncs.get(s).phase == "read") and not(st.syncs.get(s).voided)

  // ---- init ----
  action init = {
    nondet d = WORKERS.setOfMaps(0.to(MAX_DRIFT)).oneOf()
    initWith(d)
  }
  action initWith(d: str -> int): bool = all {
    st' = {
      gitPath: TICKETS.mapBy(t => List()), withdrawn: TICKETS.mapBy(t => false),
      gitBudget: GIT_BUDGET,
      counter: 0, lastAccepted: 0,
      posted: TICKETS.mapBy(t => List()), postedGone: TICKETS.mapBy(t => false),
      postedBars: TICKETS.mapBy(t => Set()),
      claims: Map(), nextId: 1,
      held: TICKETS.mapBy(t => false), ownerBars: Set(), ownerBudget: OWNER_BUDGET,
      up: WORKERS.mapBy(w => true), pushed: WORKERS.mapBy(w => false),
      pending: WORKERS.mapBy(w => ""),
      asleep: WORKERS.mapBy(w => false), localClaim: WORKERS.mapBy(w => 0),
      localLease: WORKERS.mapBy(w => 0), drift: d, now: 0,
      syncs: SLOTS.mapBy(s => { phase: "idle", obs: 0, git: TICKETS.mapBy(t => List()),
                                gone: TICKETS.mapBy(t => false), bars: TICKETS.mapBy(t => Set()),
                                voided: false }),
      accepted: List(), gitRegressedEver: TICKETS.mapBy(t => false),
      actedAfterLoss: false,
    }
  }

  // ---- claims, around the hook's await (§3, R-BTN-52, R-BTN-55) ----
  // Phase 1: the candidate is computed synchronously; the hook call begins.
  action claimStart(w: str, t: str): bool = all {
    workerFree(w), st.nextId <= MAX_CLAIMS, claimableBy(t, w),
    st' = st.with("pending", st.pending.set(w, t)),
  }
  // Phase 3: the hook returned `refuse`, `order` (no refusal) or `fail` (R-BTN-52: core's
  // default order, no advice). Every gate is re-checked in one transaction against the state
  // as it is now; a candidate another request took meanwhile is refused.
  action claimFinish(w: str, hook: str): bool = {
    val t = st.pending.get(w)
    all {
      t != "",
      val grant = hook != "refuse" and st.up.get(w) and not(st.asleep.get(w))
                  and st.nextId <= MAX_CLAIMS and workerClaim(w).size() == 0 and claimableBy(t, w)
      // ghost, written apart from the guard: the gates as they stand at the grant
      val violated = hook == "refuse" or not(ticketClaimable(t))
                     or readyLegs(t).forall(l => barred(t, l, "claim", Set()).intersect(TAGS.get(w)).size() > 0)
      st' = st.with("pending", st.pending.set(w, ""))
        .with("claims", if (grant) st.claims.put(st.nextId, {
            id: st.nextId, ticket: t, worker: w, status: "active", kind: "",
            station: stationOf(st.posted.get(t)), leg: "", startBars: Set(),
            startPath: st.posted.get(t), finished: List(),
            claimObs: st.counter, endObs: -1, regressed: false, endedRegressed: false,
            confirmed: false, confirmObs: -1, fencePending: false,
            leaseUntil: st.now + TIMEOUT, gateViolation: violated })
          else st.claims)
        .with("nextId", if (grant) st.nextId + 1 else st.nextId)
        .with("localClaim", if (grant) st.localClaim.set(w, st.nextId) else st.localClaim)
        .with("localLease", if (grant) st.localLease.set(w, st.now + TIMEOUT) else st.localLease)
        .with("pushed", st.pushed.set(w, false)),
    }
  }

  // R-BTN-8: the holder pushes the running leg's evidence. It lands only if the leg leaves
  // the station git is at (else git rejects it), or not at all (lost) — what confirmation
  // guards (R-BTN-10).
  // The push is git's, not Baton's: the worker acts on the claim IT believes it holds, so a
  // worker whose lease Baton has reaped can still push — unless its own fence check stops it
  // (R-BTN-26). `actedAfterLoss` records a push for a claim Baton reaped without a fence.
  action pushEvidence(w: str, lands: bool): bool = all {
    workerCanAct(w), not(st.pushed.get(w)),
    val c = st.claims.get(st.localClaim.get(w))
    val g = st.gitPath.get(c.ticket)
    all {
      c.leg != "",
      st' = st.with("gitPath", if (lands and FROM.get(c.leg).contains(stationOf(g)))
                                 st.gitPath.set(c.ticket, g.append(c.leg)) else st.gitPath)
              .with("pushed", st.pushed.set(w, true))
              .with("actedAfterLoss", st.actedAfterLoss or (c.status != "active" and not(c.fencePending))),
    },
  }

  // R-BTN-63: finish the running leg (the claim moves to its `to`) and start `leg` when it
  // leaves that station, its runs — start_path plus claim_legs — are under max_runs, and the
  // gates that bind a holder hold (§7.2): the hold check of rule 3, rule 8 with claim+advance
  // owner bars and the holder's own `bars`, the required bar over posted plus holder bars,
  // and the hook's refusal (`hookRefuses`). No leg state is checked: the holder's word.
  action advance(w: str, leg: str, bars: Set[str], hookRefuses: bool): bool = all {
    workerCanAct(w), workerClaim(w).size() == 1,
    val c = theClaim(w)
    val fin = if (c.leg == "") c.finished else c.finished.append(c.leg)
    val stn = if (c.leg == "") c.station else TO.get(c.leg)
    val gatesOk = and {
      not(st.held.get(c.ticket)),
      barred(c.ticket, leg, "advance", bars).intersect(TAGS.get(w)).size() == 0,
      policyOk(c.ticket, leg, bars),
      not(hookRefuses),
    }
    all {
      c.leg == "" or st.pushed.get(w),                        // git first
      FROM.get(leg).contains(stn),                            // an edge (R-BTN-69)
      runs(c.startPath.concat(fin), leg) < MAX_RUNS.get(leg), // max-runs
      gatesOk,
      // ghost, written apart from the guard
      val violated = st.held.get(c.ticket) or hookRefuses or not(policyOk(c.ticket, leg, bars))
                     or TAGS.get(w).exists(g => barred(c.ticket, leg, "advance", bars).contains(g))
      st' = st.with("claims", st.claims.set(c.id, c.with("station", stn).with("finished", fin)
                .with("leg", leg).with("startBars", postedBarsOf(c.ticket, leg).union(bars))
                .with("claimObs", st.counter).with("gateViolation", c.gateViolation or violated)))
              .with("pushed", st.pushed.set(w, false)),
    },
  }

  // R-BTN-71, §6.5: an end names the station really reached — the running leg's `to` when
  // its evidence was pushed and `reached`, else its `from`. kind: done (at an end station
  // only), suspended or release.
  action endClaim(w: str, kind: str, reached: bool): bool = all {
    workerCanAct(w), workerClaim(w).size() == 1,
    val c = theClaim(w)
    val reach = reached and c.leg != "" and st.pushed.get(w)
    val fin = if (reach) c.finished.append(c.leg) else c.finished
    val stn = if (reach) TO.get(c.leg) else c.station
    val done = kind == "done"
    // R-BTN-10: a done end is also confirmed by a closure an earlier snapshot recorded,
    // when that snapshot's observation is greater than the claim's own
    val closedEarly = done and atEnd(st.posted.get(c.ticket)) and st.lastAccepted > c.claimObs
    all {
      not(done) or ENDS.contains(stn),
      st' = st.with("claims", st.claims.set(c.id, c.with("station", stn).with("finished", fin)
                .with("leg", "")
                .with("status", if (kind == "release") "released" else "completed")
                .with("kind", kind).with("endObs", st.counter).with("endedRegressed", c.regressed)
                .with("confirmed", closedEarly)
                .with("confirmObs", if (closedEarly) st.lastAccepted else -1)))
              .with("localClaim", st.localClaim.set(w, 0))
              .with("pushed", st.pushed.set(w, false)),
    },
  }

  // ---- workers dying, and the lease (§6.3, §6.6) ----
  action crash(w: str): bool = all {
    st.up.get(w),
    st' = st.with("up", st.up.set(w, false)).with("pending", st.pending.set(w, "")),
  }
  action sleep(w: str): bool = all {
    st.up.get(w), not(st.asleep.get(w)),
    st' = st.with("asleep", st.asleep.set(w, true)),
  }
  action wake(w: str): bool = all {
    st.asleep.get(w),
    st' = st.with("asleep", st.asleep.set(w, false)),
  }
  action tick: bool = all {
    st.now < MAX_TIME,
    st' = st.with("now", st.now + 1),
  }
  // §6.3: the sidecar's heartbeat renews the lease, and tells the worker what it holds.
  action heartbeat(w: str): bool = all {
    st.up.get(w), not(st.asleep.get(w)),
    if (workerClaim(w).size() == 1) {
      val c = theClaim(w)
      st' = st.with("claims", st.claims.set(c.id, c.with("leaseUntil", st.now + TIMEOUT)))
              .with("localClaim", st.localClaim.set(w, c.id))
              .with("localLease", st.localLease.set(w, st.now + TIMEOUT))
    } else {
      // no active claim: a fenced worker keeps its local claim until it clears the fence
      st' = st.with("localClaim", if (workerFenced(w)) st.localClaim else st.localClaim.set(w, 0))
    },
  }
  // R-BTN-4, §6.6: the alarm reaps a claim whose lease ran out — its worker dead or silent.
  action alarmReap(i: int): bool = all {
    st.claims.keys().contains(i),
    val c = st.claims.get(i)
    all {
      c.status == "active", c.leaseUntil <= st.now,
      // the leg stays recorded: the worker, which does not know yet, may still try to push it
      st' = st.with("claims", st.claims.set(i, c.with("status", "reaped").with("kind", "reap")
                  .with("endObs", st.counter))),
    },
  }
  // A dead worker restarts once the alarm has reaped its claim; its fence clears at its
  // timeout too (R-BTN-19).
  action reapDead(w: str): bool = all {
    not(st.up.get(w)), workerClaim(w).size() == 0,
    st' = st.with("claims", st.claims.keys().mapBy(i => {
              val c = st.claims.get(i)
              if (c.worker == w and c.fencePending) c.with("fencePending", false) else c }))
            .with("up", st.up.set(w, true)).with("asleep", st.asleep.set(w, false))
            .with("localClaim", st.localClaim.set(w, 0)).with("pushed", st.pushed.set(w, false)),
  }
  // R-BTN-19: the owner force-reaps a live worker's claim; the ticket is not re-issued until
  // the worker reports `fence-cleared` (or dies and times out, above).
  action forceReap(w: str): bool = all {
    st.ownerBudget > 0, st.up.get(w), workerClaim(w).size() == 1,
    val c = theClaim(w)
    st' = st.with("claims", st.claims.set(c.id, c.with("status", "reaped").with("kind", "reap")
                .with("endObs", st.counter).with("fencePending", true)))
            .with("ownerBudget", st.ownerBudget - 1).with("pushed", st.pushed.set(w, false)),
  }
  // R-BTN-6, R-BTN-26: the worker learns its lease is lost, kills its tool calls and reports.
  action fenceCleared(w: str): bool = all {
    st.up.get(w), not(st.asleep.get(w)), workerFenced(w),
    st' = st.with("claims", st.claims.keys().mapBy(i => {
              val c = st.claims.get(i)
              if (c.worker == w and c.fencePending) c.with("fencePending", false) else c }))
            .with("localClaim", st.localClaim.set(w, 0)),
  }

  // ---- the owner (§8, R-BTN-67, §6.7) ----
  action setHold(t: str, h: bool): bool = all {
    st.ownerBudget > 0, st.held.get(t) != h,
    st' = st.with("held", st.held.set(t, h)).with("ownerBudget", st.ownerBudget - 1),
  }
  action setOwnerBar(tag: str, applies: str): bool = all {
    st.ownerBudget > 0,
    st' = st.with("ownerBars", st.ownerBars.union(Set({ tag: tag, applies: applies })))
            .with("ownerBudget", st.ownerBudget - 1),
  }
  action liftOwnerBars: bool = all {
    st.ownerBars.size() > 0,
    st' = st.with("ownerBars", Set()),
  }
  // §6.7: an unconfirmed completion is flagged; the owner confirms it.
  action ownerResolve(i: int): bool = all {
    st.claims.keys().contains(i),
    st.claims.get(i).status == "completed", not(st.claims.get(i).confirmed),
    st' = st.with("claims", st.claims.set(i, st.claims.get(i).with("confirmed", true)
                                                              .with("confirmObs", -1))),
  }

  // ---- git: any pusher writes anything (R-BTN-66) ----
  action foreignPush(t: str, leg: str): bool = all {
    st.gitBudget > 0, FROM.get(leg).contains(stationOf(st.gitPath.get(t))),
    st' = st.with("gitPath", st.gitPath.set(t, st.gitPath.get(t).append(leg)))
            .with("gitBudget", st.gitBudget - 1),
  }
  // a PR closed, a branch deleted, a review dismissed: the path loses its last leg
  action regress(t: str): bool = {
    val g = st.gitPath.get(t)
    all {
      st.gitBudget > 0, g.length() > 0,
      st' = st.with("gitPath", st.gitPath.set(t, g.slice(0, g.length() - 1)))
              .with("gitBudget", st.gitBudget - 1)
              .with("gitRegressedEver", st.gitRegressedEver.set(t, true)),
    }
  }
  action withdraw(t: str): bool = all {
    st.gitBudget > 0, not(st.withdrawn.get(t)), not(atEnd(st.gitPath.get(t))),
    st' = st.with("withdrawn", st.withdrawn.set(t, true)).with("gitBudget", st.gitBudget - 1),
  }

  // ---- the sync: number first, then read, then post (§7.1, R-BTN-62) ----
  // R-BTN-62 as amended 2026-10-15: no number while another is outstanding (`sync-busy`).
  action syncNumber(s: int): bool = all {
    st.syncs.get(s).phase == "idle", SLOTS.forall(o => not(outstanding(o))),
    st' = st.with("counter", st.counter + 1)
            .with("syncs", st.syncs.set(s, st.syncs.get(s).with("phase", "numbered")
                                                           .with("obs", st.counter + 1)
                                                           .with("voided", false))),
  }
  // The course's sync reads git and computes any barred tags consistent with it (here, any
  // set of families on the writing legs — course logic is nondeterministic, R-BTN-50).
  action syncRead(s: int, bars: str -> Set[str]): bool = all {
    st.syncs.get(s).phase == "numbered",
    st' = st.with("syncs", st.syncs.set(s, st.syncs.get(s).with("phase", "read")
                     .with("git", st.gitPath).with("gone", st.withdrawn).with("bars", bars))),
  }

  // What an accepted snapshot does to one claim (R-BTN-35, §2e, R-BTN-10, R-BTN-71).
  pure def judge(c: Claim, obs: int, snap: List[str], prev: List[str], gone: bool): Claim =
    if (c.status == "active" and obs > c.claimObs) {
      if (gone) c.with("status", "released").with("kind", "stale").with("leg", "")
                 .with("endObs", obs)
      else if (snap.length() < prev.length() or snap.length() < c.startPath.length())
        c.with("regressed", true)
      else if (c.regressed and extendsPath(expected(c), snap)) c.with("regressed", false)
      else c
    } else if (c.status == "completed" and not(c.confirmed) and obs > c.endObs) {
      val ok = if (c.kind == "done") atEnd(snap)
               else c.endedRegressed or extendsPath(expected(c), snap)
      if (ok) c.with("confirmed", true).with("confirmObs", obs) else c
    } else if (c.status == "completed" and not(c.confirmed) and c.kind == "done"
               and obs > c.claimObs and atEnd(snap)) {
      c.with("confirmed", true).with("confirmObs", obs)
    } else c

  // R-BTN-62: Baton voids a number left outstanding too long (10 minutes); the run may still
  // read and post, and its post is refused.
  action syncVoid(s: int): bool = all {
    outstanding(s),
    st' = st.with("syncs", st.syncs.set(s, st.syncs.get(s).with("voided", true))),
  }
  // A post is accepted whole only when its number is greater than the last accepted.
  action syncPost(s: int): bool = {
    val r = st.syncs.get(s)
    all {
      r.phase == "read",
      st' = (if (r.obs > st.lastAccepted and not(r.voided))
               st.with("lastAccepted", r.obs).with("posted", r.git).with("postedGone", r.gone)
                 .with("postedBars", r.bars).with("accepted", st.accepted.append(r.obs))
                 .with("claims", st.claims.keys().mapBy(i => {
                    val c = st.claims.get(i)
                    judge(c, r.obs, r.git.get(c.ticket), st.posted.get(c.ticket),
                          r.gone.get(c.ticket)) }))
             else st)                                    // refused stale-observation
            .with("syncs", st.syncs.set(s, r.with("phase", "idle"))),
    }
  }

  action step = {
    nondet w = WORKERS.oneOf()
    nondet t = TICKETS.oneOf()
    nondet leg = LEGS.oneOf()
    nondet s = SLOTS.oneOf()
    nondet b = Set(true, false).oneOf()
    nondet b2 = Set(true, false).oneOf()
    nondet kind = Set("done", "suspended", "release").oneOf()
    nondet hook = Set("order", "refuse", "fail").oneOf()
    nondet holderBars = FAMILIES.powerset().oneOf()
    nondet postBars = TICKETS.setOfMaps(FAMILIES.powerset()).oneOf()
    nondet tag = FAMILIES.oneOf()
    nondet applies = Set("claim", "claim+advance").oneOf()
    nondet i = 1.to(MAX_CLAIMS).oneOf()
    any {
      claimStart(w, t), claimFinish(w, hook),
      pushEvidence(w, b), advance(w, leg, holderBars, b2), endClaim(w, kind, b),
      heartbeat(w), sleep(w), wake(w), tick, alarmReap(i),
      crash(w), reapDead(w), forceReap(w), fenceCleared(w),
      setHold(t, b), setOwnerBar(tag, applies), liftOwnerBars, ownerResolve(i),
      foreignPush(t, leg), regress(t), withdraw(t),
      syncNumber(s), syncRead(s, postBars), syncVoid(s), syncPost(s),
    }
  }

  // The happy path's actors only — claims, legs, pushes that land, ends, syncs, git's own
  // regressions — so random runs reach the deep states (merges, fix loops, regressions,
  // confirmations) that the full `step` rarely gets to in 40 steps. Every run of it is a run
  // of `step`, so a violation here is a real one.
  action progressStep = {
    nondet w = WORKERS.oneOf()
    nondet t = TICKETS.oneOf()
    nondet leg = LEGS.oneOf()
    nondet postBars = TICKETS.setOfMaps(Set(Set("family:b"))).oneOf()
    any {
      claimStart(w, t), claimFinish(w, "order"),
      pushEvidence(w, true), advance(w, leg, Set("family:b"), false), endClaim(w, "done", true),
      syncNumber(1), syncRead(1, postBars), syncPost(1), regress(t),
    }
  }
}
