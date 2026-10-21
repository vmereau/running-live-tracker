# Race readiness: keeping the home PC up

The race depends on one Windows PC at home: the tracker server (one Node process) and the
Tailscale daemon must stay up for the whole race and come back on their own after a reboot
or a crash, with nobody touching the PC (AD-14). This runbook covers the one-time setup, the
reboot test, `pnpm race-check`, the logs and the race-week checklist.

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
- [ ] Public-URL `pnpm simulate` dry run with a phone browser watching, the day before.
- [ ] Race morning, after switching to the race config: `pnpm race-check --base-url https://<host>.<tailnet>.ts.net`
      again, all `PASS`.
