// Baton's core as a state machine — a draft of R3-1243 (spike, written against
// docs#212 at 1dae3316, BATON_SPEC as amended 2026-10-14 after the sixth review).
//
// What is modelled: claims and their lease (R-BTN-4), stations and legs from a course
// file (R-BTN-69), advance on the holder's word (R-BTN-63), ends naming the station
// reached (R-BTN-71), git first (R-BTN-8), observation numbers and whole-post
// acceptance (R-BTN-62), confirmation by path extension (R-BTN-10, R-BTN-71), staleness
// only when the ticket is taken away and regressions flagged (R-BTN-35, §2e), per-leg
// max_runs counted from start_path (R-BTN-63), reaping (§6.6), any pusher writing git
// (R-BTN-66), and the owner resolving a flagged completion (§6.7).
// What is abstracted: time (the 30-minute and 6-hour flags are "eventually"), hooks,
// bars and tiers, fencing inside the worker, held histories, repositories.
module baton {
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
  // max_runs; a leg without one may run without limit, which the course file allows
  // only off every cycle (R-BTN-69). 99 stands for "no limit".
  pure val MAX_RUNS: str -> int = Map(
    "implement" -> 99, "review" -> 3, "fix" -> 2, "adjudicate" -> 99, "merge" -> 99)

  pure val TICKETS = Set("t1", "t2")
  pure val WORKERS = Set("w1", "w2")
  pure val SLOTS = Set(1, 2)          // two sync runs may overlap (§7.1)
  pure val MAX_CLAIMS = 6             // bounds the state space
  pure val GIT_BUDGET = 2             // foreign pushes, regressions and withdrawals per run

  // ---- path helpers ----
  pure def stationOf(p: List[str]): str = p.foldl(START, (s, l) => TO.get(l))
  pure def runs(p: List[str], leg: str): int = p.select(x => x == leg).length()
  pure def isPrefix(p: List[str], q: List[str]): bool =
    p.length() <= q.length() and p.indices().forall(i => p[i] == q[i])
  pure def validPath(q: List[str]): bool =
    q.indices().forall(i => FROM.get(q[i]).contains(stationOf(q.slice(0, i))))
  // R-BTN-71: q extends p — begins with it and continues, if at all, by edges.
  pure def extendsPath(p: List[str], q: List[str]): bool = isPrefix(p, q) and validPath(q)
  pure def legsFrom(st: str): Set[str] = LEGS.filter(l => FROM.get(l).contains(st))
  // The legs a ticket may still run from where path p leaves it (§2e: under max_runs).
  pure def readyLegs(p: List[str]): Set[str] =
    if (ENDS.contains(stationOf(p))) Set()
    else legsFrom(stationOf(p)).filter(l => runs(p, l) < MAX_RUNS.get(l))
  pure def atEnd(p: List[str]): bool = ENDS.contains(stationOf(p))

  // ---- state ----
  type Claim = {
    id: int, ticket: str, worker: str,
    status: str,         // active | completed | released | reaped
    kind: str,           // "" | done | suspended | stale | release
    station: str,        // R-BTN-63: the last station it reached
    leg: str,            // the leg it is running; "" for none
    startPath: List[str],
    finished: List[str], // claim_legs it finished, in order
    claimObs: int,       // counter at the claim or its latest advance (R-BTN-62)
    endObs: int,
    regressed: bool,     // regressed_since IS NOT NULL (§2e)
    endedRegressed: bool,
    confirmed: bool,
    confirmObs: int,     // the observation that confirmed it; -1 for the owner
  }
  type Sync = { phase: str, obs: int, git: str -> List[str], gone: str -> bool }

  // git (the truth)
  var gitPath: str -> List[str]
  var withdrawn: str -> bool
  var gitBudget: int
  // Baton
  var counter: int                      // last observation number handed out
  var lastAccepted: int
  var posted: str -> List[str]          // ticket_stations.path of the head snapshot
  var postedGone: str -> bool           // closed_tickets withdrawn
  var claims: int -> Claim
  var nextId: int
  // workers
  var up: str -> bool
  var pushed: str -> bool               // evidence of the running leg pushed (R-BTN-8)
  // sync runs
  var syncs: int -> Sync
  // ghosts, for the properties
  var accepted: List[int]
  var gitRegressedEver: str -> bool
  var lastStep: str

  // ---- derived ----
  def activeOf(t: str): Set[int] =
    claims.keys().filter(i => claims.get(i).ticket == t and claims.get(i).status == "active")
  def workerClaim(w: str): Set[int] =
    claims.keys().filter(i => claims.get(i).worker == w and claims.get(i).status == "active")
  def maxEndObs(t: str): int =
    claims.keys().filter(i => claims.get(i).ticket == t and claims.get(i).status != "active")
      .fold(-1, (m, i) => if (claims.get(i).endObs > m) claims.get(i).endObs else m)
  def unconfirmedOf(t: str): Set[int] =
    claims.keys().filter(i => claims.get(i).ticket == t and claims.get(i).status == "completed"
                              and not(claims.get(i).confirmed))
  pure def expected(c: Claim): List[str] = c.startPath.concat(c.finished)

  // §7.2 rules 1 and 3 and §6.7: the gates of a ticket at a claim.
  def claimable(t: str): bool = and {
    not(postedGone.get(t)),
    readyLegs(posted.get(t)).size() > 0,
    activeOf(t).size() == 0,
    unconfirmedOf(t).size() == 0,
    lastAccepted > maxEndObs(t),
  }

  // ---- init ----
  action init = all {
    gitPath' = TICKETS.mapBy(t => List()),
    withdrawn' = TICKETS.mapBy(t => false),
    gitBudget' = GIT_BUDGET,
    counter' = 0,
    lastAccepted' = 0,
    posted' = TICKETS.mapBy(t => List()),
    postedGone' = TICKETS.mapBy(t => false),
    claims' = Map(),
    nextId' = 1,
    up' = WORKERS.mapBy(w => true),
    pushed' = WORKERS.mapBy(w => false),
    syncs' = SLOTS.mapBy(s => { phase: "idle", obs: 0, git: TICKETS.mapBy(t => List()),
                                gone: TICKETS.mapBy(t => false) }),
    accepted' = List(),
    gitRegressedEver' = TICKETS.mapBy(t => false),
    lastStep' = "init",
  }

  // ---- worker actions ----
  // R-BTN-4, §6.2: one active claim per ticket and per worker, at the posted station.
  action claim(w: str, t: str): bool = all {
    up.get(w), workerClaim(w).size() == 0, nextId <= MAX_CLAIMS, claimable(t),
    claims' = claims.put(nextId, {
      id: nextId, ticket: t, worker: w, status: "active", kind: "",
      station: stationOf(posted.get(t)), leg: "", startPath: posted.get(t), finished: List(),
      claimObs: counter, endObs: -1, regressed: false, endedRegressed: false,
      confirmed: false, confirmObs: -1 }),
    nextId' = nextId + 1, pushed' = pushed.set(w, false),
    gitPath' = gitPath, withdrawn' = withdrawn, gitBudget' = gitBudget, counter' = counter,
    lastAccepted' = lastAccepted, posted' = posted, postedGone' = postedGone, up' = up,
    syncs' = syncs, accepted' = accepted, gitRegressedEver' = gitRegressedEver,
    lastStep' = "claim",
  }

  // R-BTN-8: the holder pushes the running leg's evidence. The push lands only if the
  // leg leaves the station git is at (else git rejects it, a non-fast-forward), or not
  // at all (lost), which is what confirmation guards (R-BTN-10).
  action pushEvidence(w: str, lands: bool): bool = {
    val ids = workerClaim(w)
    all {
      up.get(w), ids.size() == 1, not(pushed.get(w)),
      val c = claims.get(ids.fold(0, (a, i) => i))
      all {
        c.leg != "",
        val g = gitPath.get(c.ticket)
        gitPath' = if (lands and FROM.get(c.leg).contains(stationOf(g)))
                     gitPath.set(c.ticket, g.append(c.leg)) else gitPath,
      },
      pushed' = pushed.set(w, true),
      withdrawn' = withdrawn, gitBudget' = gitBudget, counter' = counter,
      lastAccepted' = lastAccepted, posted' = posted, postedGone' = postedGone,
      claims' = claims, nextId' = nextId, up' = up, syncs' = syncs, accepted' = accepted,
      gitRegressedEver' = gitRegressedEver, lastStep' = "push",
    }
  }

  // R-BTN-63: finish the running leg (the claim moves to its `to`), start `leg` when it
  // leaves that station and its runs — start_path plus claim_legs — are under max_runs.
  // No leg state is checked: the holder's word.
  action advance(w: str, leg: str): bool = {
    val ids = workerClaim(w)
    all {
      up.get(w), ids.size() == 1,
      val c = claims.get(ids.fold(0, (a, i) => i))
      val fin = if (c.leg == "") c.finished else c.finished.append(c.leg)
      val st = if (c.leg == "") c.station else TO.get(c.leg)
      all {
        c.leg == "" or pushed.get(w),                      // git first
        FROM.get(leg).contains(st),
        runs(c.startPath.concat(fin), leg) < MAX_RUNS.get(leg),
        claims' = claims.set(c.id, c.with("station", st).with("finished", fin)
                                     .with("leg", leg).with("claimObs", counter)),
      },
      pushed' = pushed.set(w, false),
      gitPath' = gitPath, withdrawn' = withdrawn, gitBudget' = gitBudget, counter' = counter,
      lastAccepted' = lastAccepted, posted' = posted, postedGone' = postedGone,
      nextId' = nextId, up' = up, syncs' = syncs, accepted' = accepted,
      gitRegressedEver' = gitRegressedEver, lastStep' = "advance",
    }
  }

  // R-BTN-71, §6.5: an end names the station really reached. `reached` = the running leg
  // got to its `to` (its evidence pushed); otherwise it is given up at its `from`.
  // kind: done (only at an end station), suspended, or release.
  action endClaim(w: str, kind: str, reached: bool): bool = {
    val ids = workerClaim(w)
    all {
      up.get(w), ids.size() == 1,
      val c = claims.get(ids.fold(0, (a, i) => i))
      val reach = reached and c.leg != "" and pushed.get(w)
      val fin = if (reach) c.finished.append(c.leg) else c.finished
      val st = if (reach) TO.get(c.leg) else c.station
      val done = kind == "done"
      // R-BTN-10: a done end is also confirmed by a closure an earlier snapshot recorded,
      // when that snapshot's observation is greater than the claim's own.
      val closedEarly = done and atEnd(posted.get(c.ticket)) and lastAccepted > c.claimObs
      all {
        not(done) or ENDS.contains(st),
        claims' = claims.set(c.id, c.with("station", st).with("finished", fin).with("leg", "")
          .with("status", if (kind == "release") "released" else "completed")
          .with("kind", kind).with("endObs", counter).with("endedRegressed", c.regressed)
          .with("confirmed", closedEarly)
          .with("confirmObs", if (closedEarly) lastAccepted else -1)),
      },
      pushed' = pushed.set(w, false),
      gitPath' = gitPath, withdrawn' = withdrawn, gitBudget' = gitBudget, counter' = counter,
      lastAccepted' = lastAccepted, posted' = posted, postedGone' = postedGone,
      nextId' = nextId, up' = up, syncs' = syncs, accepted' = accepted,
      gitRegressedEver' = gitRegressedEver, lastStep' = kind,
    }
  }

  action crash(w: str): bool = all {
    up.get(w), up' = up.set(w, false),
    gitPath' = gitPath, withdrawn' = withdrawn, gitBudget' = gitBudget, counter' = counter,
    lastAccepted' = lastAccepted, posted' = posted, postedGone' = postedGone,
    claims' = claims, nextId' = nextId, pushed' = pushed, syncs' = syncs,
    accepted' = accepted, gitRegressedEver' = gitRegressedEver, lastStep' = "crash",
  }

  // §6.6: the alarm reaps the claim of a worker whose lease ran out. (Fencing a live
  // worker is outside this draft: a crashed worker never wakes holding its claim.)
  action reap(w: str): bool = {
    val ids = workerClaim(w)
    all {
      not(up.get(w)), ids.size() == 1,
      val c = claims.get(ids.fold(0, (a, i) => i))
      claims' = claims.set(c.id, c.with("status", "reaped").with("leg", "")
                                   .with("endObs", counter)),
      up' = up.set(w, true), pushed' = pushed.set(w, false),
      gitPath' = gitPath, withdrawn' = withdrawn, gitBudget' = gitBudget, counter' = counter,
      lastAccepted' = lastAccepted, posted' = posted, postedGone' = postedGone,
      nextId' = nextId, syncs' = syncs, accepted' = accepted,
      gitRegressedEver' = gitRegressedEver, lastStep' = "reap",
    }
  }

  // ---- git: any pusher writes anything (R-BTN-66) ----
  action foreignPush(t: str, leg: str): bool = all {
    gitBudget > 0, FROM.get(leg).contains(stationOf(gitPath.get(t))),
    gitPath' = gitPath.set(t, gitPath.get(t).append(leg)), gitBudget' = gitBudget - 1,
    withdrawn' = withdrawn, counter' = counter, lastAccepted' = lastAccepted,
    posted' = posted, postedGone' = postedGone, claims' = claims, nextId' = nextId,
    up' = up, pushed' = pushed, syncs' = syncs, accepted' = accepted,
    gitRegressedEver' = gitRegressedEver, lastStep' = "foreign-push",
  }
  // A PR closed, a branch deleted, a review dismissed: the path loses its last leg.
  action regress(t: str): bool = all {
    gitBudget > 0, gitPath.get(t).length() > 0,
    gitPath' = gitPath.set(t, gitPath.get(t).slice(0, gitPath.get(t).length() - 1)),
    gitBudget' = gitBudget - 1, gitRegressedEver' = gitRegressedEver.set(t, true),
    withdrawn' = withdrawn, counter' = counter, lastAccepted' = lastAccepted,
    posted' = posted, postedGone' = postedGone, claims' = claims, nextId' = nextId,
    up' = up, pushed' = pushed, syncs' = syncs, accepted' = accepted,
    lastStep' = "regress",
  }
  action withdraw(t: str): bool = all {
    gitBudget > 0, not(withdrawn.get(t)), not(atEnd(gitPath.get(t))),
    withdrawn' = withdrawn.set(t, true), gitBudget' = gitBudget - 1,
    gitPath' = gitPath, counter' = counter, lastAccepted' = lastAccepted,
    posted' = posted, postedGone' = postedGone, claims' = claims, nextId' = nextId,
    up' = up, pushed' = pushed, syncs' = syncs, accepted' = accepted,
    gitRegressedEver' = gitRegressedEver, lastStep' = "withdraw",
  }

  // ---- the sync: number first, then read, then post (§7.1, R-BTN-62) ----
  action syncNumber(s: int): bool = all {
    syncs.get(s).phase == "idle",
    counter' = counter + 1,
    syncs' = syncs.set(s, syncs.get(s).with("phase", "numbered").with("obs", counter + 1)),
    gitPath' = gitPath, withdrawn' = withdrawn, gitBudget' = gitBudget,
    lastAccepted' = lastAccepted, posted' = posted, postedGone' = postedGone,
    claims' = claims, nextId' = nextId, up' = up, pushed' = pushed, accepted' = accepted,
    gitRegressedEver' = gitRegressedEver, lastStep' = "sync-number",
  }
  action syncRead(s: int): bool = all {
    syncs.get(s).phase == "numbered",
    syncs' = syncs.set(s, syncs.get(s).with("phase", "read").with("git", gitPath)
                                       .with("gone", withdrawn)),
    gitPath' = gitPath, withdrawn' = withdrawn, gitBudget' = gitBudget, counter' = counter,
    lastAccepted' = lastAccepted, posted' = posted, postedGone' = postedGone,
    claims' = claims, nextId' = nextId, up' = up, pushed' = pushed, accepted' = accepted,
    gitRegressedEver' = gitRegressedEver, lastStep' = "sync-read",
  }

  // What an accepted snapshot does to one claim.
  pure def judge(c: Claim, obs: int, snap: List[str], prev: List[str], gone: bool): Claim =
    if (c.status == "active" and obs > c.claimObs) {
      // R-BTN-35: stale only when the ticket is taken away.
      if (gone) c.with("status", "released").with("kind", "stale").with("leg", "")
                 .with("endObs", obs)
      // §2e: shorter than git showed before — flag it.
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

  action syncPost(s: int): bool = {
    val r = syncs.get(s)
    all {
      r.phase == "read",
      if (r.obs > lastAccepted) all {
        lastAccepted' = r.obs, posted' = r.git, postedGone' = r.gone,
        accepted' = accepted.append(r.obs),
        claims' = claims.keys().mapBy(i => {
          val c = claims.get(i)
          judge(c, r.obs, r.git.get(c.ticket), posted.get(c.ticket), r.gone.get(c.ticket))
        }),
      } else all {                                       // refused stale-observation
        lastAccepted' = lastAccepted, posted' = posted, postedGone' = postedGone,
        accepted' = accepted, claims' = claims,
      },
      syncs' = syncs.set(s, r.with("phase", "idle")),
      gitPath' = gitPath, withdrawn' = withdrawn, gitBudget' = gitBudget, counter' = counter,
      nextId' = nextId, up' = up, pushed' = pushed, gitRegressedEver' = gitRegressedEver,
      lastStep' = "sync-post",
    }
  }

  // §6.7: an unconfirmed completion is flagged; the owner confirms it (or releases).
  action ownerResolve(i: int): bool = all {
    claims.keys().contains(i),
    claims.get(i).status == "completed", not(claims.get(i).confirmed),
    claims' = claims.set(i, claims.get(i).with("confirmed", true).with("confirmObs", -1)),
    gitPath' = gitPath, withdrawn' = withdrawn, gitBudget' = gitBudget, counter' = counter,
    lastAccepted' = lastAccepted, posted' = posted, postedGone' = postedGone,
    nextId' = nextId, up' = up, pushed' = pushed, syncs' = syncs, accepted' = accepted,
    gitRegressedEver' = gitRegressedEver, lastStep' = "owner-resolve",
  }

  action step = {
    nondet w = WORKERS.oneOf()
    nondet t = TICKETS.oneOf()
    nondet leg = LEGS.oneOf()
    nondet s = SLOTS.oneOf()
    nondet b = Set(true, false).oneOf()
    nondet kind = Set("done", "suspended", "release").oneOf()
    nondet i = 1.to(MAX_CLAIMS).oneOf()
    any {
      claim(w, t), pushEvidence(w, b), advance(w, leg), endClaim(w, kind, b),
      crash(w), reap(w),
      foreignPush(t, leg), regress(t), withdraw(t),
      syncNumber(s), syncRead(s), syncPost(s),
      ownerResolve(i),
    }
  }
}
