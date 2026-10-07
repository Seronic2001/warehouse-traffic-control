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
| `5` | **Network partition.** A Wi-Fi dead zone cuts R0 off while it holds a lease on the cell ahead. Its renewals are lost, so by its own clock the lease runs out and it refuses to move. A moment later the manager's copy expires too: the empty cell goes to R1 with a higher epoch and R0's own cell is Blocked. When the network heals, R0's renewals come back "lost", it resyncs with the world and gets its cell back. |
| `6` | **Crash in a lift** (3 floors). R0 crashes halfway down lift L0. Its car lease expires with it inside, so the lift goes **out of service** and waiting robots reroute through the other lifts. A crew winches the car to a floor and clears it. |
| `V` | **Floor view** (multi-storey only): cycles between all floors (an exploded stack) and each single floor. The same choice is in the floor bar under the mode tabs. |
| `M` | **Message timeline** for the selected robot (also the **Timeline** button in the inspector). Each process the robot talks to gets a lane: itself, its region managers, the world, other robots. Each message is an arrow from sender to receiver; lost messages end in a ×. Above the robot's lane are the leases it believes it holds. A lease bar turns hatched once the robot's own clock says it has expired. Hover for details, toggle message kinds, and pick a 4/8/16 s window. |
| `[` / `]` | **Rewind / forward 5 s.** The scrubber above the dock can drag to any earlier moment of the run. Marks on it show deadlocks, crashes, fencing, manager failures and partitions; click one to jump to 1 s before it. Playing on from an earlier moment replays the same future. Acting there (crash, freeze, cut the network) starts a new branch. |
| `B` | **Benchmark** (runs on a pool of Web Workers, one per spare CPU core; about 25 s on an 8-core laptop): strategies vs density (collisions, throughput, deadlocks, time to resolve, wait distribution and p95, messages per move); the lease safety margin under a hostile network; recovery times after injected robot crashes, pauses and manager crashes; and congestion control on vs off over 10-minute runs. |
| `C` | **Distributed vs centralised** (about 30 s on 8 cores, 56 runs). Races this design against a single central server that owns every cell, finds deadlocks by searching its whole wait-for graph, and knows every region's load exactly. Robots, leases, fencing, network and routing are identical. A scorecard marks each category *distributed better*, *close* or *centralised better*, computed from the runs. |
| `Space` / `R` / `Esc` | Pause or resume / restart from the seed / close or exit |
| `D` | Toggle light / dark theme (also the sun/moon button; the choice is remembered) |

Click any robot to see its leases, epochs, expiry bars and what it is waiting for. The inspector also has **Crash** and **Freeze** buttons, opens the robot's message timeline, and lets you follow the robot with the camera. Click a cell to see the manager's table entry for it: state, owner, epoch and queue. The cell inspector can also crash that region's manager or **cut the network** for every robot in the 5×5 cells around it for 8 s. The left panel sets network delay and loss, lease length, the **safety margin** and **clock drift**, and switches **congestion control** on or off. The **Region load** layer tints each region by how full its manager says it is, with the percentage next to each manager. A region at or above the admission threshold is outlined.

## How it maps to the proposal

| Proposal component | Code |
|---|---|
| World simulator (ground truth, collisions, fencing) | `src/sim/simulation.js` |
| Robots: one process each, with A* and leases | `src/sim/robot.js`, `src/sim/astar.js` |
| Region managers: 4×4 regions, reservation table | `src/sim/manager.js` |
| Network layer with delay and loss | `src/sim/network.js` |
| Live view | `src/render/*`, `src/ui/*` |
| Failure scenarios | `src/sim/scenarios.js` |
| Replay (checkpoints + action log) | `src/sim/history.js` |
| Message timeline recorder | `src/sim/trace.js`, `src/ui/timeline.js` |
| Floors and lifts (layout, A* rides) | `src/sim/layout.js`, `src/sim/astar.js` |
| Lift managers | `src/sim/lift.js` |

Robots, managers and the world only talk to each other through network messages. The single exception is the move actuator, which is where fencing happens. Every run is replayable from its seed.

### Replay

The simulation is deterministic: the same seed and the same user actions at the same ticks always produce the same run. History therefore keeps a deep copy of the whole simulation every 2.5 s (a few milliseconds each) plus the log of user actions. To show an earlier moment, it restores the nearest copy and steps forward, replaying the actions on the way. A seek takes well under 0.2 s. A headless test checks that a rewound run ends in exactly the same state as an uninterrupted one, including after branching.

### Congestion control

Deadlock detection keeps the floor from freezing, but at 150–200 robots long queues build up around blocks and throughput sags over time. Congestion control spreads the traffic without adding anything a robot has to wait for:

* **Load gossip.** Each region manager knows its own load: leased cells divided by open cells. Every second, it pushes its whole view of all 16 regions' loads to its neighbouring managers. Merging keeps the newer entry, by tick stamp. A crashed manager starts with an empty view.
* **Piggybacked to robots.** Every GRANT, QUEUED and RENEWED reply carries the manager's current view, so robots learn the loads at no extra message cost. Views older than 20 s are ignored.
* **Congestion-aware routing.** A* adds a per-step cost for entering a region in proportion to how far its load is above 0.3, so robots detour around crowded regions.
* **Admission at dispatch.** When a robot picks its next job, it draws a few candidates and skips any in a region at or above 0.32 load.

A hard gate (robots waiting at a region's border for room) was deliberately avoided. Two full regions waiting on each other would deadlock, and since nobody *holds* a cell in that wait, probes couldn't see it. Here nothing ever blocks on admission, so safety and the deadlock argument are unchanged.

### Network partitions

A dead zone cuts every robot inside it off from the network, in both directions. Managers and the world keep running. To a manager, a robot behind a partition is indistinguishable from a crashed one, and the protocol handles it the same way: wait out the lease, re-grant empty cells, Block occupied ones. The cut-off robot is safe because it computes its lease expiry from when it *sent* its last successful renewal, which is always earlier than the manager's copy. With the safety margin, it stops trusting the lease before the manager hands the cell to anyone else. While a lease is nearly out, a robot retries renewals at most every 4 ticks, so a cut-off robot doesn't flood the network. Stress test: 240 random partitions across 12 runs of 160 robots (about 172,000 moves), with and without loss and drift: **0 collisions**.

### Traffic rules added to keep 200 robots moving

* **One-way lanes.** Highways are two-lane roads and aisles alternate direction, so head-on swaps can't be planned.
* **Don't block the box.** Before entering a 2×2 crossing, a robot must lease every cell through it plus the exit cell, requested in global cell order. U-turns inside a crossing aren't allowed.
* **Drive-through station bays.** Each bay sits off the ring road, so drop-offs never block through-traffic.
* **Victim selection.** A yield only helps if it frees something, so probes record two facts about each robot in the cycle. First, whether it merely *reserved* the cell the robot behind it wants: yielding releases a reservation, but a robot can't give up a cell it's standing in. Second, whether it has an alternative route. The lowest-priority robot that releases a reservation yields. Failing that, the lowest-priority robot with another way to go. Failing that, the lowest-priority robot. A victim that is standing in the wanted cell also steps aside into an empty neighbouring cell (a normal leased move) before replanning. Priorities age while robots wait.

  This replaced a "lowest priority yields" rule that could gridlock the whole floor: in one 200-robot run, a 2-robot cycle at a crossing re-formed 53 times because the chosen victim was standing in the cell the other robot needed, and all 200 robots ended up queued behind it.

### Region manager crash and reconciliation

A crashed manager loses its whole reservation table. On restart it increments an **incarnation number**, the only state it keeps on stable storage. It broadcasts `RECONCILE` and rebuilds the table from the robots' `REPORT`s (leases they still hold, and where each robot is). Requests that arrive in the meantime are buffered and get no grant. Any occupied cell nobody claims becomes Blocked. Every epoch issued after the restart is above `incarnation × 1,000,000`, so it is higher than any epoch from an earlier life, and a stale lease can never pass fencing.

### Safety guarantees under stress

* A robot never resyncs mid-move, and never releases a cell it physically occupies.
* Managers never grant a cell their floor sensor reports occupied by another robot.
* Stress test: 144 runs (about 416,000 moves) with up to 40% message loss, ±20% clock drift, short leases, every safety margin, and injected failures. The result was **0 collisions**.

### Findings so far (seed 42, 2 minutes of simulated time)

* Protected collisions stay at **0** in every protocol run. Baseline has 18 collisions per 1,000 moves at 50 robots, rising to 80 at 200.
* Detection peaks at about 125 tasks/min around 150 robots. In 2-minute runs at 200 robots the floor saturates and throughput falls to about 60–80, still with almost no deadlocks (0.07 per 1,000 moves).
* Congestion control, total tasks over 14 simulated minutes, mean of 4 seeds: 120 robots 1290 → 1474 (+14%), 150 robots 890 → 1447 (+63%), 200 robots 769 → 995 (+29%). Without it, 150 robots sag from about 120 to about 30 tasks/min over the run; with it they hold 90–120. At 200 robots every region is busy, so there is little room to route around, and the floor is simply over capacity. More dedicated parking or wider highways would be the next step there.
* Safety margin under a hostile network (20% loss, delay up to 300 ms, ±20% drift, 2 s leases) has a clear sweet spot. With no margin, robots lose about 22 leases per 1,000 moves. Around 0.6–0.8 s, losses drop to about 14 and throughput peaks. At 1.6 s, the margin eats most of the lease and robots can almost never move.
* Recovery: a crashed robot's lease is taken back after about 2.7 s and its Blocked cell is cleared after about 7.3 s. A paused robot resyncs 0.3 s after waking. A crashed manager is granting again after about 4.3 s (4 s down plus reconciliation).
* Ordered acquisition, as implemented here (queue for the next cell, then grab the rest of the segment all-or-nothing with backoff), works at low density but collapses at 200 robots from repeated backoff. That is worth discussing in the report rather than hiding.

### Distributed vs centralised (`C`)

The centralised baseline is `mode: 'central'`: one manager (M0) owns all cells, needs no gossip, and runs cycle detection on its full wait-for graph every 0.4 s (a cycle counts once any member has waited as long as a robot waits before probing, the same rule as the probes). `mgrRate` caps how many messages one coordinator node can handle per tick; extra messages wait in its inbox. It is 0 (unlimited) by default, so existing modes behave exactly as before.

The **Centralised** mode tab runs it live. The 16 region-manager nodes are replaced by one server tower over the middle of the floor. Every request, grant and renewal flies to that tower. Crashing it from any cell's inspector turns the whole floor red until it has reconciled.

Results (seeds 1–3, default settings):

| Category | Distributed | Centralised | Verdict |
|---|---|---|---|
| Collisions | 0 | 0 | close |
| Throughput, mean of 50–200 robots (unlimited server) | 96 | 96 | close |
| p95 lease wait, 150 robots | 2.67 s | 2.83 s | close |
| Deadlock resolution | 0.72 s | 0.84 s | close |
| Messages per move, 150 robots | 8.8 | 7.6 | close (central is ahead, and further ahead at 200 robots: no probes or gossip) |
| Busiest coordinator node, 200 robots | 114 msgs/s | 950 msgs/s | distributed |
| Throughput at 200 robots when each node handles 600 msgs/s | 106 | 0 | distributed |
| Per-node capacity needed for 90% throughput, 200 robots | 200 msgs/s | 800 msgs/s | distributed |
| Robots cut off per coordinator crash (120 robots) | 14 | 120 | distributed |
| Tasks lost to a coordinator crash every 45 s | 3% | 10% | distributed |
| Recovery after a coordinator crash | 4.3 s | 4.3 s | close |

In short, a fast enough central server matches the distributed design in normal operation and sends fewer messages. The distributed design wins on per-node load, on running with modest hardware, and on how much of the floor a crash takes down. Below about 800 msgs/s the central server suffers congestion collapse: renewals queue behind requests, leases run out, robots resync, and that adds even more traffic.

### Multi-storey warehouse

Set **Floors** (1–3) and **Lifts** (1–8) in the left panel. Each floor is the same 48×32 grid with its own 16 region managers. Pickups are on every floor. Packing stations are on the **ground and first floor**, and every job drops at one of them, chosen at random between the two floors. So ground- and first-floor robots serve both station floors, and second-floor robots deliver to either. Many jobs therefore need lift rides. Lifts are drawn in light green, deeper green while a robot holds the car. With one floor (the default), every run is identical to the single-floor simulator.

**Layout.** Each lift sits in the middle of an aisle at the same spot on every floor. That aisle becomes a one-way lobby of six cells: two queue cells, the entry, the shaft, the exit and one more. Robots waiting for the car queue inside the lobby, off the highways, and never meet a robot leaving the car head-on. (An earlier version put lifts in the outer wall. Their queues spilled onto the ring road that also serves the packing stations, and throughput fell as robots were added.)

**Protocol.** Each lift has a **lift manager**. It leases out the car exactly as a region manager leases out a cell: one holder at a time, a queue, an epoch, fencing, expiry, crash and reconciliation. The differences:

* All shaft cells of a lift (one per floor) are the same resource, so they share one table entry and one epoch, and a grant fences them all.
* The manager first calls the car to the waiting robot's floor. It is wired to the lift's motor, not a network peer. It grants the lease only once the car is there. The world also refuses to let a robot into a shaft unless the car is parked at that floor.
* **There is no Wi-Fi in the shaft.** A robot can't renew while riding, so a car lease lasts a full ride plus the normal lease. A robot boards only if its lease covers the whole ride plus the safety margin.
* A robot asks for both shaft cells of a ride at once. They belong to the same manager, so this can't break the global ordering. It asks for the exit cell after arriving, which only robots leaving that lift ever use.
* The car serves the highest-priority waiter on the floor where the car already is, so it avoids empty trips. A waiter on another floor goes first once it has waited 8 s, so nobody starves.
* Waiting for the car is a normal wait-for edge to the car's holder. Probes therefore find deadlocks through a lift, and across floors, without any change.
* If a car lease expires with a robot inside, the whole lift is **out of service** until the crew clears it. A stuck car is winched to a floor.

**Verified.**

* Stress test (with stations on the ground floor only): 24 runs on 3 floors with message loss up to 15%, clock drift up to 20% and injected crashes and pauses (326,000 moves, 3,310 rides). Results: 0 collisions, never two robots in a shaft, and the car always at the floor of any robot standing in the shaft.
* With stations on the ground and first floor: 12 more runs (145,000 moves, 1,314 rides), again 0 collisions and no shaft or car violations.
* Forced failures all recover:
  * A robot crashing mid-ride takes the lift out of service after 5.6 s; it is back after about 10 s.
  * A lift manager crashing during a ride reconciles in 5.5 s.
  * A robot that freezes inside the car past its lease is fenced on its stale epoch, resyncs and gets the car back.

**Findings (90 robots, 3 minutes, mean of 2 seeds).** Lifts are the bottleneck. With 3 floors, throughput goes from 7 tasks/min with 1 lift to 20 with 2, 38 with 4, 46 with 6 and 56 with 8. The mean wait for a car falls from 8.4 s to 4.7 s. One floor manages 84 tasks/min, two floors with 4 lifts 58. A ride holds a car for about 3.5 s: drive in, ride, wait for the exit cell, drive out. Empty trips to the next waiter add more. So a lift moves about one robot every 4–5 s. The **Benchmark** (`B`) has these sweeps in section E.
