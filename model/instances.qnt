// Instances of the model. `sim`: R3-1243's bounds — 3 workers, 2 tickets, 2 overlapping sync
// runs — for `quint run` (npm run model). `small`: 2 workers, 1 ticket, 1 sync run — for
// Apalache's bounded proof (npm run model:verify), which explodes on `sim` past a few steps.
module sim {
  import properties(P_TICKETS = Set("t1", "t2"), P_WORKERS = Set("w1", "w2", "w3"),
                    P_SLOTS = Set(1, 2), P_MAX_CLAIMS = 6, P_GIT_BUDGET = 2,
                    P_OWNER_BUDGET = 2).* from "./properties"
}
module small {
  import properties(P_TICKETS = Set("t1"), P_WORKERS = Set("w1", "w2"),
                    P_SLOTS = Set(1), P_MAX_CLAIMS = 3, P_GIT_BUDGET = 1,
                    P_OWNER_BUDGET = 1).* from "./properties"
}
