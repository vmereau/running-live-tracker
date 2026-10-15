---
id: SPEC-running-live-tracker
companions: []
sources: []
---

> **Canonical contract.** This SPEC and the files in `companions:` are the complete, preservation-validated contract for what to build, test, and validate. Source documents listed in frontmatter are for traceability — consult them only if you need narrative rationale or prose color this contract intentionally omits.

# Running Live Tracker

## Why

A personal project with two parts. Valentin and the other runners who use it want friends to follow their marathon live, even when the friends aren't on the course. Friends should see where each runner is, how fast they're going and how much of the course remains. An Android app on each runner's phone streams its position to a self-hosted server, and the server gives spectators a web page that shows the run as it happens.

## Capabilities

- **CAP-1**
  - **intent:** A runner starts and stops tracking a run from the Android app. While tracking is on, the app sends position updates to the server.
  - **success:** The runner starts tracking in the app, moves, then stops. The server holds that run's positions for the time in between.
- **CAP-2**
  - **intent:** A spectator sees the current positions of all active runners on one live map, with no manual reload, and can pick out a runner.
  - **success:** Two phones stream at the same time, and both markers appear and follow their runners' movement.
- **CAP-3**
  - **intent:** The web UI shows live stats for each runner: elapsed time, distance covered, current pace and average pace (min/km). Spectators can view all runners or switch between them.
  - **success:** Switching to another runner changes the stats shown. The values stay close to what each runner's own watch or app reports.
- **CAP-4**
  - **intent:** One GPX course is set up on the server and shared by all runners in the race. The web UI shows the course and each runner's progress along it: km done out of total km, km remaining and percent complete.
  - **success:** The GPX configured on the server appears on the map, and each runner's progress figures match their position on the course.
- **CAP-5**
  - **intent:** When a GPX is attached, the web UI shows each runner's estimated finish time.
  - **success:** The estimated finish time appears for a runner with a GPX and changes when their pace changes.
- **CAP-6**
  - **intent:** The server accepts positions only from phones that hold a secret key set up on both the phone and the server. The key also tells the server which runner the positions belong to.
  - **success:** A post without a valid key is rejected. A post with a valid key is recorded for the right runner.
- **CAP-7**
  - **intent:** The app keeps the positions it records while there's no signal and sends them once the connection returns. The web UI shows how long ago each runner last sent an update.
  - **success:** With airplane mode on for 2 minutes mid-run, the page shows the runner's last update getting older. Once the connection returns, the gap in the track fills in.

## Constraints

- The phone client is Android only.
- The server runs on Valentin's home PC. A tunnel (Cloudflare Tunnel, Tailscale Funnel or similar) gives it a public HTTPS address that phones on mobile data and friends' browsers can reach. There's no router port forwarding.
- The home PC, its power and the home internet connection must stay up for the whole race. If any of them goes down, tracking stops for everyone.
- Viewers get in through one shared link. There are no viewer accounts and no login.
- Runners, runs, secret keys and the GPX course are set up on the server. The app and web UI don't manage them.
- While tracking, the phone sends a position every 5–10 seconds.
- Tracking must keep working for a full marathon (several hours) with the phone in a pocket and the screen locked.

## Non-goals

- An iOS client.
- Training history, analytics, or replaying a run in the UI. The product is live only.
- Social features (comments, cheers, sharing feeds).
- Viewer accounts, or runners signing themselves up.

## Success signal

- During a real test run before the marathon, two runners stream at the same time. A friend opens the shared link on their phone and from start to finish can switch between the runners. They see live position, pace and stats, and for a runner with a GPX they also see km done out of total km and an estimated finish time.

## Assumptions

- Runners and their secret keys are registered on the server, the same way as GPX courses.
- There's no replay UI. Positions stay stored on the server, so replay could be added after the race.
