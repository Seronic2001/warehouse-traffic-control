# Warehouse Traffic Control: 3D simulator

This is a browser demo of Project A. 50 to 200 robots share a grid safely by using per-cell leases, fencing epochs and Chandy–Misra–Haas deadlock detection.

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # static build in dist/ (any static host works)
```

## What to show in a demo

| Key | Action |
|---|---|
| `T` | **Guided tour** (starts automatically on the first visit). It walks through the floor, regions, managers, robots, leases, wait-for arrows, deadlock detection, crashes and fencing, one component at a time. Use `←` / `→` to step through and `Esc` to leave. |
| `1` | **Four-robot deadlock.** A cycle forms across regions 5, 6, 9 and 10. Probes chase the wait-for edges, and the lowest-priority robot yields. |
| `2` | **Crash a lease holder.** Its leases expire. The empty cell is re-granted with a new epoch, and the occupied cell becomes **Blocked** until the crew sends **Cleared**. |
| `3` | **Pause past the lease.** The frozen robot resumes and acts on epoch 1, the world rejects the move because the epoch is now 2, and the robot resyncs. |
| `4` | **Region manager crash.** M5 loses its table. Robots in region 5 stop as their leases run low. M5 restarts with a new incarnation number, rebuilds its table from robot reports, and refuses grants until it's done. |
| `B` | **Benchmark** (runs in a Web Worker): strategies vs density (collisions, throughput, deadlocks, time to resolve, wait distribution and p95, messages per move); the lease safety margin under a hostile network; and recovery times after injected robot crashes, pauses and manager crashes. |
| `Space` / `R` / `Esc` | Pause or resume / restart from the seed / close or exit |
| `D` | Toggle light / dark theme (also the sun/moon button; the choice is remembered) |

Click any robot to see its leases, epochs, expiry bars and what it is waiting for. The inspector also has **Crash** and **Freeze** buttons and lets you follow the robot with the camera. Click a cell to see the manager's table entry for it: state, owner, epoch and queue. The cell inspector can also crash that region's manager. The left panel sets network delay and loss, lease length, the **safety margin** and **clock drift**.

## How it maps to the proposal

| Proposal component | Code |
|---|---|
| World simulator (ground truth, collisions, fencing) | `src/sim/simulation.js` |
| Robots: one process each, with A* and leases | `src/sim/robot.js`, `src/sim/astar.js` |
| Region managers: 4×4 regions, reservation table | `src/sim/manager.js` |
| Network layer with delay and loss | `src/sim/network.js` |
| Live view | `src/render/*`, `src/ui/*` |
| Failure scenarios | `src/sim/scenarios.js` |

Robots, managers and the world only talk to each other through network messages. The single exception is the move actuator, which is where fencing happens. Every run is replayable from its seed.

### Traffic rules added to keep 200 robots moving

* **One-way lanes.** Highways are two-lane roads and aisles alternate direction, so head-on swaps can't be planned.
* **Don't block the box.** Before entering a 2×2 crossing, a robot must lease every cell through it plus the exit cell, requested in global cell order. U-turns inside a crossing aren't allowed.
* **Drive-through station bays.** Each bay sits off the ring road, so drop-offs never block through-traffic.
* **Victim selection.** Probes record whether each robot in the cycle has an alternative route. The lowest-priority robot that *can* move elsewhere yields. If none can, the lowest-priority robot yields. Priorities age while robots wait.

### Region manager crash and reconciliation

A crashed manager loses its whole reservation table. On restart it increments an **incarnation number**, the only state it keeps on stable storage. It broadcasts `RECONCILE` and rebuilds the table from the robots' `REPORT`s (leases they still hold, and where each robot is). Requests that arrive in the meantime are buffered and get no grant. Any occupied cell nobody claims becomes Blocked. Every epoch issued after the restart is above `incarnation × 1,000,000`, so it is higher than any epoch from an earlier life, and a stale lease can never pass fencing.

### Safety guarantees under stress

* A robot never resyncs mid-move, and never releases a cell it physically occupies.
* Managers never grant a cell their floor sensor reports occupied by another robot.
* Stress test: 144 runs (about 416,000 moves) with up to 40% message loss, ±20% clock drift, short leases, every safety margin, and injected failures. The result was **0 collisions**.

### Findings so far (seed 42, 2 minutes of simulated time)

* Protected collisions stay at **0** in every protocol run. Baseline reaches about 50 to 80 collisions per 1,000 moves.
* Detection stays at about 110 tasks/min from 120 to 200 robots, with very few deadlocks.
* Safety margin under a hostile network (20% loss, delay up to 300 ms, ±20% drift, 2 s leases) has a clear sweet spot. With no margin, robots lose about 26 leases per 1,000 moves. Around 0.6–0.8 s, losses drop to about 14 and throughput peaks. At 1.6 s, the margin eats most of the lease and robots can almost never move.
* Recovery: a crashed robot's lease is taken back after about 2.8 s and its Blocked cell is cleared after about 7.4 s. A paused robot resyncs 0.3 s after waking. A crashed manager is granting again after about 4.3 s (4 s down plus reconciliation).
* Ordered acquisition, as implemented here (queue for the next cell, then grab the rest of the segment all-or-nothing with backoff), works at low density but collapses at 200 robots from repeated backoff. That is worth discussing in the report rather than hiding.
