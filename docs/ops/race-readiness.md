# Race readiness: keeping the home PC up

The race depends on one Windows PC at home: the tracker server (one Node process) and the
Tailscale daemon must stay up for the whole race and come back on their own after a reboot
or a crash, with nobody touching the PC (AD-14). This runbook covers the one-time setup, the
reboot test, `pnpm race-check`, the logs, `pnpm session-report`, the public dry run, the
phone soak test, the two-runner test run (`pnpm run-log`, tolerance, tuning) and the
race-week checklist.

Related notes: [tailscale-funnel.md](tailscale-funnel.md) (public access through Funnel) and
[events-and-backups.md](events-and-backups.md) (test-run and race configs, switching, backups).

How it fits together:

- Windows logs the user on automatically at boot (auto-logon).
- A Task Scheduler task runs `ops/windows/start-server.ps1` at that logon. The script is a
  supervisor loop: it starts `node server/src/main.ts` and, whenever node exits (crash, kill,
  config error), waits 10 s and starts it again.
- The Tailscale service starts at boot and keeps Funnel serving `https://<host>.ts.net` →
  `http://127.0.0.1:8787`. The server binds `127.0.0.1` only and knows nothing about Tailscale.

## One-time setup

Run these on the home PC in PowerShell, from the repo root (for example
`D:\github\perso\running-live-tracker`).

### 1. Power: never sleep or hibernate on AC

Administrator PowerShell:

```powershell
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
```

Use these two commands rather than `powercfg /hibernate off`: race-check reads the timeout values,
and with hibernation turned off it may not be able to read `HIBERNATEIDLE`.

`pnpm race-check` reads both values back (`SUB_SLEEP STANDBYIDLE` and `HIBERNATEIDLE` of the
active power plan). If you switch power plans later, run the commands again.

### 2. Build the web app and prepare the configs

```powershell
pnpm install
pnpm --filter web build
```

Create the test-run and race configs as described in
[events-and-backups.md](events-and-backups.md#two-configs).

### 3. Register the logon task

Edit `$repo` and `-EventConfig` (relative to the repo root, or absolute), then run in a normal
(non-admin) PowerShell as the user who will be logged on automatically:

```powershell
$repo = 'D:\github\perso\running-live-tracker'
$arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$repo\ops\windows\start-server.ps1`" -EventConfig config\event.race.json"
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'running-live-tracker' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force
```

- `-ExecutionTimeLimit ([TimeSpan]::Zero)` means no time limit (the default would stop the
  task after 72 h). `-RestartCount`/`-RestartInterval` restart the supervisor itself if it ever dies.
- The script also takes `-DataDir <path>` (default `<repo>\data`) and `-Port <n>` (default 8787).
  If you change the port, change the Funnel target too.
- `node` must be on that user's `PATH`. The supervisor looks it up at every start and logs
  `cannot start the server` in `supervisor.log` if it is missing.

Start it now without logging off, and check it:

```powershell
Start-ScheduledTask -TaskName 'running-live-tracker'
curl.exe http://127.0.0.1:8787/api/v1/health
```

**Switching events** (test run → race): register the task again with the other
`-EventConfig` (the snippet above with `-Force` replaces it), then restart:

```powershell
Stop-ScheduledTask -TaskName 'running-live-tracker'
# Stopping the task stops the supervisor, not always its node child: stop whatever listens on 8787.
Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
Start-ScheduledTask -TaskName 'running-live-tracker'
```

Killing only the node process (leaving the task running) restarts the server with the same
config 10 s later.

### 4. Tailscale: start at boot, stay logged in, keep Funnel on

- **Service**: `services.msc` → *Tailscale* → Startup type **Automatic** (the installer's
  default). Check in PowerShell: `Get-Service Tailscale | Select-Object Status, StartType`.
- **Run unattended**: Tailscale tray icon → *Preferences* → **Run unattended**. Without it
  the connection depends on the user's session.
- **Key expiry**: in the admin console, *Machines* → this PC → **Disable key expiry**, so the
  node is not logged out in the middle of race week.
- **Funnel**: once, in a terminal:

  ```powershell
  tailscale funnel --bg 8787
  tailscale funnel status
  ```

  `--bg` stores the Funnel config in the daemon, so it comes back after every reboot. Do not use
  the foreground `tailscale funnel 8787` for the race. Details: [tailscale-funnel.md](tailscale-funnel.md).

### 5. Auto-logon

Use [Sysinternals Autologon](https://learn.microsoft.com/sysinternals/downloads/autologon):
run `Autologon64.exe`, enter the user, domain (the PC name for a local account) and password,
and press *Enable*. It stores the password encrypted as an LSA secret. Run it again and press
*Disable* after the race if you want the login screen back.

Auto-logon is not automated or checked by the scripts (the password is involved); it is on the
manual checklist below.

## Reboot test

Do this after the setup, and again in race week:

1. Restart Windows (`Restart-Computer`) and do not touch the keyboard or mouse.
2. Wait 2–3 minutes. The desktop appears without a password, and nothing visible starts (the
   supervisor's window is hidden).
3. From the PC: `pnpm race-check --base-url https://<host>.<tailnet>.ts.net`, and every line is
   `PASS`.
4. From a phone on **mobile data** (Wi-Fi off, Tailscale app off), open
   `https://<host>.<tailnet>.ts.net/api/v1/health`: it answers `{"ok":true,...}` with the race
   `eventId`. Then open the map at `/`.
5. Crash restart: kill the server and check that the supervisor brings it back:

   ```powershell
   Get-NetTCPConnection -LocalPort 8787 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
   Start-Sleep 15
   curl.exe http://127.0.0.1:8787/api/v1/health
   Get-Content data\logs\supervisor.log -Tail 3
   ```

   Health answers again and `supervisor.log` has a new "exited with code" line.

Step 4 matters: on the PC itself the `ts.net` name goes over the tailnet, not through the public
Funnel ingress, so `race-check` from the PC does not prove that spectators can reach it.

## `pnpm race-check`

```powershell
pnpm race-check --base-url https://<host>.<tailnet>.ts.net
pnpm race-check --base-url https://<host>.<tailnet>.ts.net --config config\event.race.json
```

`--config` defaults to `EVENT_CONFIG`, then `config/event.json`, the same as the server. Pass the
config the supervisor task runs. Output: one line per check, then a summary. Exit code 0 when
nothing failed, 1 otherwise (`SKIP` does not fail the run).

| Check | `PASS` when |
| --- | --- |
| `health` | `GET <base-url>/api/v1/health` answers 200 with `{ok:true, serverNow, eventId}` |
| `event` | the live `eventId` is the config's `eventId` (both are named on a mismatch) |
| `window` | the config's `closesAt` is still ahead. Before `opensAt` it passes with "opens in …" |
| `runners` | the runners in `GET /api/v1/snapshot` are exactly the config's runners (display names listed) |
| `course` | the config has a `coursePath` and the server has the course loaded (length in km), or neither has one |
| `sleep` | Windows "Sleep after" on AC power is never (`SUB_SLEEP STANDBYIDLE` = 0) |
| `hibernate` | Windows "Hibernate after" on AC power is never (`SUB_SLEEP HIBERNATEIDLE` = 0) |

The window comes from the config file because the public event info has no window: a matching
`eventId` means the config's window is the active one. `sleep` and `hibernate` are `SKIP` when not
run on Windows or when `powercfg` fails.

## Logs

All under `<DATA_DIR>\logs` (default `<repo>\data\logs`):

| File | What |
| --- | --- |
| `server-<UTC date of boot>.log` | The server's JSON log lines (the same lines as its stdout), appended. A new file per boot day; a server running past midnight UTC keeps writing to its boot day's file. No raw keys and no request bodies. |
| `stdout.log` | stdout of the latest server run, overwritten at each restart (the same lines as the server log) |
| `stderr-<yyyyMMdd-HHmmss>.log` | stderr of one run, kept only when not empty: boot errors (invalid config, bad GPX, port in use) and crash stacks |
| `supervisor.log` | One line when the supervisor starts and one per server exit: UTC time, pid, exit code, run time, stderr file |

There is no rotation. The files are small for a single race, but clear old ones by hand.

```powershell
Get-Content data\logs\supervisor.log -Tail 20
Get-Content data\logs\server-2026-11-08.log -Wait -Tail 20     # follow the live log
```

## `pnpm session-report`

The server-side proof for the dry run and the soak test: a read-only report of what the
fix log holds for each session. It reads `<DATA_DIR>\tracker.db` directly (read-only, safe while
the server runs) and the event config for the window and the runner names. No HTTP calls.

```powershell
pnpm session-report                                           # sessions of EVENT_CONFIG / config\event.json
pnpm session-report --config config\event.test-run.json       # sessions started in that event's window
pnpm session-report --config config\event.test-run.json --session <sessionId>   # one session, any start time
pnpm session-report --config config\event.dry-run.json --gap 10s
```

`--config` and `DATA_DIR` default as for the server. A session is in the report when its
`sessionStartedAt` is in `[opensAt, closesAt]` of the config, ordered by start. One block per
session, then a summary line:

| Line | What |
| --- | --- |
| header | runner display name (the raw `runnerId` when not in the config), `sessionId`, verdict |
| `started` | `sessionStartedAt` (Start pressed on the phone) |
| `fixes` | number of fixes, first → last fix time and the time between them |
| `distance` | km along the stored fixes (raw GPS, not snapped to the course) |
| `end` | time of the `end` record, or `not received` |
| `missing` | seq ranges absent from `0..` the highest stored seq, e.g. `12..15, 40` |
| `max gap` | longest time between two consecutive fixes |
| `track gaps > …` | consecutive fixes more than `--gap` apart (by recorded time): **no position was recorded** (no GPS fix, app killed, phone off) |
| `upload gaps > …` | consecutive records received more than `--gap` apart (by server time): **nothing reached the server** (no mobile data); the backlog came later |
| `max upload` | largest delay between a record being recorded on the phone and received by the server |

All times are UTC. The verdict is `COMPLETE` when no seq is missing and `end` was received,
`INCOMPLETE` when seqs are missing (records lost), `INCOMPLETE (no end)` when `end` has not
arrived (still running, or Stop not uploaded yet). Gaps never change the verdict: whether each one
matches a place without signal is for the runner to judge. Exit code 0 only when every reported
session is `COMPLETE`; 1 otherwise, and also when no session is in the window
(`no sessions in <eventId> window (<from> – <to>)`), for an unknown `--session`, a missing DB or a
bad config.

`--gap` defaults to `30s`: the phone and `pnpm simulate` record a fix every 5 s
(`FIX_INTERVAL_MS = 5_000`) and the phone uploads every 10 s, so 30 s is several missed fixes or
uploads, not jitter. With `pnpm simulate --time-scale N` the fixes are stamped in simulated time:
`track gaps` and `max upload` mean nothing there, and an offline `--gap` keeps recording fixes, so
it shows as an `upload gap` of `duration / N` of wall time. Pass a smaller `--gap` then (`10s` for
the dry run below).

## Public dry run

The whole pipeline through the public URL, with `pnpm simulate` as the runners and a phone on
mobile data as the spectator. Do it once in race week, and **repeat it the day before the race**.

1. **Make a dry-run config.** Copy the race config to `config/event.dry-run.json` (git-ignored, see
   [events-and-backups.md](events-and-backups.md#two-configs)) and change only:
   - `eventId`: its own, e.g. `dry-run-2026-11-07`;
   - `opensAt` / `closesAt`: a window covering the dry run (e.g. now − 1 h to now + 4 h) and
     **disjoint from the race and test-run windows**. A session belongs to the event its start time
     falls in: run under the race config's window, the dry run's sessions would land in the race.

   Keep the same runners, keys and `coursePath`, so the page looks like race day.
2. **Run the task with it**: register the task with `-EventConfig config\event.dry-run.json` and
   restart it, as in *Switching events* under [Register the logon task](#3-register-the-logon-task).
   `pnpm race-check --base-url https://<host>.<tailnet>.ts.net --config config\event.dry-run.json`
   is all `PASS`.
3. **Phone**: Wi-Fi off, Tailscale app off, open `https://<host>.<tailnet>.ts.net/`.
4. **Simulate every runner** (from the PC or any machine), with every runner's key:

   ```powershell
   pnpm -s simulate --base-url https://<host>.<tailnet>.ts.net --gpx config\courses\race.gpx `
     --key=<runner-1-key> --key=<runner-2-key> --time-scale 10 --stagger 1m --gap 10m+5m
   ```

   Write `--key=<key>`, not `--key <key>`: a key can start with `-`, and the second form then
   fails with "argument is ambiguous". It ends with `simulation done: every record acked` (exit 0). At 10× a marathon at the default
   pace takes about 20–25 min of wall time.
5. **Tick on the phone** while it runs:
   - [ ] a marker and a track per runner, in the runner's color, moving along the course;
   - [ ] stats update (pace, distance, last-update age);
   - [ ] course progress (km done out of total km) and the estimated finish time;
   - [ ] switching runners in the list shows the other runner's figures;
   - [ ] during the 5 min simulated gap (30 s of wall time) the runner's last-update age grows, then
         the gap in the track **fills in** when it ends;
   - [ ] the page never needed a reload, up to each runner's finish.
6. **Server side**: `pnpm session-report --config config\event.dry-run.json --gap 10s`: every
   session `COMPLETE`, each with an `upload gap` of about 30 s at the simulated gap, exit 0.
7. **Switch back to the race config**: register the task with `-EventConfig config\event.race.json`,
   restart it, and `pnpm race-check --base-url https://<host>.<tailnet>.ts.net` is all `PASS` with the
   race `eventId`.

Results:

| Date | Tailscale version | Phone / browser / carrier | Pass / fail | Notes |
| --- | --- | --- | --- | --- |
| | | | | |
| *(repeat the day before the race)* | | | | |

## Phone soak test

Each runner's own phone tracks for at least 5 h pocketed with the screen locked, and the server
ends up with the whole track and nothing left in the phone's outbox. Run it under the **test-run
config** (the task running `config\event.test-run.json`, its window covering the soak), never the
race config.

Before, on the phone:

1. App installed (release APK). Settings: the public URL and that runner's key; *Test connection*
   shows `Connected — event <test-run eventId>`.
2. Permissions screen all granted, including **No battery optimization** for the app.
3. Vendor settings, which Android's battery-optimization switch does not cover. Check those of
   the phone's brand (menus move between versions: search the settings for the words):
   - **Samsung**: *Settings → Battery → Background usage limits*: add the app to **Never sleeping
     apps**, and check it is not in *Sleeping* / *Deep sleeping apps*. App info → *Battery* →
     **Unrestricted**.
   - **Xiaomi / Redmi / POCO**: app info → **Autostart** on, *Battery saver* → **No restrictions**.
     Lock the app in recents.
   - **Huawei / Honor**: *Battery → App launch*: turn off *Manage automatically* for the app
     (**manual**), with auto-launch, secondary launch and run in background on.
   - **OnePlus / Oppo / realme**: app info → *Battery* → **Allow background activity** /
     *Don't optimize*; turn off *Sleep standby optimization* and *Optimize battery use* for the app
     if present.
   - Others: [dontkillmyapp.com](https://dontkillmyapp.com) for the brand.
4. Phone charged (note the %), battery saver off.

The test:

1. Press **Start**, lock the screen, put the phone in a pocket (a run, a walk or a day out, ideally
   passing places without signal).
2. After **≥ 5 h**, unlock and press **Stop**. Note the battery %.
3. Wait until **Pending** on the main screen reaches **0**: the outbox is empty and the
   "Uploading N pending" notification is gone. If it does not, note the value and keep the phone
   on a network.
4. On the PC: `pnpm session-report --config config\event.test-run.json` (or `--session <id>`):
   the session is `COMPLETE`, the fixes span ≥ 5 h, and every `track gap` and `upload gap` is at a
   time when the phone had no GPS or no signal (tunnel, underground, dead zone). A gap anywhere else
   means the phone stopped the app: fix the vendor settings and redo the test.

Results (one row per runner phone):

| Runner | Phone / Android version | Date | Duration | Battery start → end % | Gaps and their cause | Vendor settings needed | Pass / fail |
| --- | --- | --- | --- | --- | --- | --- | --- |
| | | | | | | | |
| | | | | | | | |

## Two-runner test run

The SPEC success signal, for real: both runners on their own phones at the same time, the race
course loaded, and a friend following them on a phone browser from start to finish. It is also
the one planned chance to measure how far the page is from each runner's watch (NFR7). Run it
under the **test-run config**, never the race config.

Before:

1. **Config**: `config/event.test-run.json` (see
   [events-and-backups.md](events-and-backups.md#two-configs)) with both runners, their keys, the
   **race** `coursePath`, and a window covering the test run (disjoint from the race window). The
   task runs it (*Switching events* under [Register the logon task](#3-register-the-logon-task)),
   and `pnpm race-check --base-url https://<host>.<tailnet>.ts.net --config config\event.test-run.json`
   is all `PASS`.
2. **Phones**: both set up as for the [Phone soak test](#phone-soak-test) (URL, key, *Test
   connection* shows the test-run `eventId`, permissions, vendor battery settings), charged.
3. **Watches**: each runner records the run on their own watch or running app as usual, started
   at the same moment as the tracker.
4. **Friend**: a phone on mobile data (Wi-Fi off) with the shared link
   `https://<host>.<tailnet>.ts.net/`.
5. **Recorder**: on the PC, start `pnpm run-log` before the start (it waits for the runners):

   ```powershell
   pnpm run-log --base-url http://127.0.0.1:8787
   ```

   Every 15 s (`--interval`) it reads `GET /api/v1/snapshot`, prints one status line and appends
   each runner's figures (status, distance, progress, remaining, average and current pace, ETA,
   last fix, start, end) to `data\run-logs\<eventId>-<UTC start>.csv`. Point it at localhost, not
   at the public URL: each snapshot carries every track. A failed poll prints `poll failed: …` and
   is retried at the next one; it never stops the recording. Leave the window open for the whole
   run (the PC must not sleep anyway).

The run:

1. Both runners press **Start** on the tracker and on their watch at the start line, then lock
   the screen and pocket the phone.
2. The friend ticks, from start to finish:
   - [ ] both runners are in the list, each with a marker and a track in their color;
   - [ ] switching between the runners works at any time and shows that runner's figures;
   - [ ] for each runner: live position, pace and stats (distance, elapsed, last-update age);
   - [ ] for each runner: km done out of total km, and an estimated finish time (from 1 km on);
   - [ ] the page kept updating to each runner's finish without a reload.
3. At the finish each runner stops the watch and presses **Stop** on the tracker as soon as they
   can, then waits until **Pending** reaches **0**.
4. `run-log` ends by itself once every runner it saw running is stopped (or press Ctrl-C) and
   prints, per runner: `finish` (the fix at which progress reached the course length, else the
   Stop), `elapsed`, `distance`, `avg pace`, and one line per 5 km checkpoint with the ETA the page
   showed there and its error against the actual finish (`+` = it predicted later than the runner
   finished, `-` = earlier). The CSV stays for any later analysis. How exact these are:
   - all times are **UTC**; watches and running apps show local time, so convert before comparing;
   - the finish and each checkpoint are read from the polls, so they can be up to one
     `--interval` (15 s) late;
   - a `Stop pressed` finish (the course matching never reached the very end; the line says how
     many km were left) includes the time it took to get the phone out and press Stop. Every ETA
     error is then too negative by that much: take the finish from the watch instead and correct
     the errors by (Stop − watch finish).
   A runner who was already stopped before `run-log` started (an earlier session in the window)
   shows as `not started`: their figures are not from this run.
5. `pnpm session-report --config config\event.test-run.json`: both sessions `COMPLETE`.

Success signal results:

| Date | Runners | Friend's phone / browser / carrier | Checklist all ticked | Notes (what failed, when) |
| --- | --- | --- | --- | --- |
| | | | | |

### Tolerance: page vs watch

From the `run-log` summary (page) and each runner's watch or app (watch), one block per runner.
With a course the page's distance is the progress along the course (it never exceeds the course
length); the watch measures the path actually run, so it usually reads a little more.

| Runner | Figure | Page | Watch / app | Difference |
| --- | --- | --- | --- | --- |
| | Distance (km) | | | |
| | Elapsed (h:mm:ss) | | | |
| | Average pace (min/km) | | | |
| | Finish time (UTC) | | | |
| | ETA error at 5 / 10 / 15 / 20 / … km | | — | |
| | Distance (km) | | | |
| | Elapsed (h:mm:ss) | | | |
| | Average pace (min/km) | | | |
| | Finish time (UTC) | | | |
| | ETA error at 5 / 10 / 15 / 20 / … km | | — | |

**Accepted tolerance** (NFR7), written once both blocks are filled in, e.g. "distance within
±2 %, average pace within ±5 s/km, ETA within ±5 min from half-way": _______________________.
Differences inside it need no change. A difference outside it is a reason to tune (below), or to
accept it here with the reason.

### Tuning

Only when the test run measured a difference outside the accepted tolerance, and only through the
named constants in `server/src/domain` (AD-7, AD-8). Nothing else changes: not the projection, the
wire contract, the web page or the app. `MAX_ACCURACY_M` (fixes with a worse accuracy are ignored,
in `server/src/projection/apply-records.ts`) is not a tuning knob.

| Constant | File | Default | Affects | Change it when |
| --- | --- | --- | --- | --- |
| `BACK_WINDOW_M` | `domain/progress.ts` | 50 m | how far behind progress a fix may still match | progress stalls where GPS noise puts the runner slightly behind |
| `MIN_FORWARD_WINDOW_M` | `domain/progress.ts` | 1000 m | how far ahead a fix may match | progress jumps to a later part of the course that passes nearby |
| `WINDOW_GROWTH_MPS` | `domain/progress.ts` | 8 m/s | how fast the forward window grows during a GPS gap | progress is stuck after a long gap (tunnel) |
| `ON_COURSE_M` | `domain/progress.ts` | 100 m | how far from the course a fix still counts as on it | *off course* shows while on course (GPS noise between buildings), or never shows on a detour |
| `REJOIN_FIXES` | `domain/progress.ts` | 6 | consistent fixes near the course ahead before progress jumps there | a rejoin after a gap or detour is too slow or too eager |
| `EXPECTED_SPEED_MPS` | `domain/progress.ts` | 3 m/s | where the runner is guessed to be since the last match | progress picks the wrong one of two nearby course parts after a gap |
| `MIN_AVG_PACE_DISTANCE_M` | `domain/stats.ts` | 100 m | when the average pace appears | the first average pace is wild |
| `CURRENT_PACE_MIN_WINDOW_S` / `_M` | `domain/stats.ts` | 60 s / 200 m | how smooth the current pace is | the current pace jumps around (raise) or lags too much (lower) |
| `ETA_MIN_DISTANCE_M` | `domain/eta.ts` | 1000 m | when the ETA appears | the early ETA is wild |
| ETA basis | `domain/eta.ts` (`etaAt`) | average pace | what the ETA extrapolates from | the ETA error grows towards the end as the runner slows: a blend with the current pace may follow, still in `etaAt` only |

How:

1. Change the constant (or `etaAt`) in `server/src/domain`, with a comment giving the measured
   reason and the test-run date.
2. Update the golden tests that encode the old value (`server/src/domain/*.test.ts`, and the
   projection tests whose expected figures move). Every other test, the live-equals-replay test
   included, must pass unchanged.
3. `pnpm check` all green.
4. See the effect on the test run: take a backup on the PC (`pnpm backup`), boot a local server
   on another port with a `DATA_DIR` holding a copy of it (as `tracker.db`) and the test-run
   config, and run
   `pnpm run-log --base-url http://127.0.0.1:<port> --out <scratch folder>\replay.csv` once. Pass
   `--out`: otherwise the CSV lands in the real `data\run-logs\` next to the test run's own. Press
   `Ctrl-C` after the first status line: every runner is already stopped, so it never ends by itself.
   The summary then shows the runners as `not started`, but the CSV rows hold the final distance
   and average pace recomputed from the stored log (derived values are never stored). The ETA
   history cannot be replayed this way.
5. Record what changed, from what to what, and why:

| Date | Constant | From → to | Measured reason | Tests updated |
| --- | --- | --- | --- | --- |
| | | | | |

## Race-week checklist

The checks `race-check` cannot automate. Tick them in race week, and again the day before:

- [ ] Windows Update **paused** for race week (*Settings* → *Windows Update* → *Pause updates*),
      covering race day. An update reboot mid-race would cost minutes even with autostart.
- [ ] Auto-logon on: the reboot test above reached the desktop without a password.
- [ ] Power plugged in, router and internet up, PC not on a switchable socket.
- [ ] The race config is the one the task runs: `race-check` `event` is `PASS` with the race
      `eventId`, and `window` says "opens in …" with the right start time.
- [ ] `pnpm race-check --base-url https://<host>.<tailnet>.ts.net` all `PASS`, and the phone on
      mobile data gets 200 from `/api/v1/health`.
- [ ] Backup taken (`pnpm backup`, see [events-and-backups.md](events-and-backups.md#backup)).
- [ ] [Public dry run](#public-dry-run) (public-URL `pnpm simulate` with a phone browser watching)
      passed in race week and again the day before, recorded in its results table, and the task is
      back on the race config.
- [ ] [Phone soak test](#phone-soak-test) passed on every runner's phone, recorded in its results
      table, with the vendor battery settings it needed still set.
- [ ] [Two-runner test run](#two-runner-test-run) done: the friend's success-signal checklist all
      ticked, the page-vs-watch tolerance and the accepted tolerance recorded, and any tuning it
      called for logged with `pnpm check` green. The task is back on the race config.
- [ ] Race morning, after switching to the race config: `pnpm race-check --base-url https://<host>.<tailnet>.ts.net`
      again, all `PASS`.
