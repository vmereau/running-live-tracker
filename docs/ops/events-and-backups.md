# Test-run and race events, backups and restore

The test run(s) and the race share one SQLite fix log (`<DATA_DIR>/tracker.db`) but use
separate event configs. The projection shows only sessions whose `sessionStartedAt` falls
in the active config's `[opensAt, closesAt]` window. Sessions outside it are still stored
and acked, just never shown, so test-run positions never appear in the race.

Public access (Tailscale Funnel) is covered in [tailscale-funnel.md](tailscale-funnel.md).

## Two configs

Make both from the example. Every `config/*.json` except `*.example.json` is git-ignored,
because the files hold key hashes:

```sh
cp config/event.example.json config/event.test-run.json
cp config/event.example.json config/event.race.json
```

In each file:

- `eventId`: distinct, for example `test-run-2026-10` and `race-2026-11`. `GET /api/v1/health`
  reports it, which is how you check which event is live.
- `opensAt` / `closesAt`: epoch **milliseconds**, UTC. Keep the two windows disjoint. For
  example, in Node: `new Date('2026-11-08T07:00:00Z').getTime()`.

  A session belongs to an event only by its start time (`sessionStartedAt`, when Start was
  pressed on the phone), never by when its positions were recorded or received. A phone started
  before `opensAt`, for example during warm-up, is stored and acked but hidden for the whole run.
  Open the race window well before the start gun and close it well after the last finisher. To
  recover a hidden session, move `opensAt` earlier and restart the server: the stored positions
  then appear.
- `runners`: one entry per runner, made with `pnpm keygen <runnerId>` (paste the printed
  entry, adjust `displayName` and `color`). The same key and `keyHash` may be used in both
  configs. The phone keeps its settings, and its sessions land in whichever window they start in.
- `coursePath` (optional): the GPX of that event's course.

## Switching events

The config is read only at boot. To switch, stop the server and start it with the other
config:

```sh
EVENT_CONFIG=config/event.race.json pnpm dev                 # Git Bash
```

```powershell
$env:EVENT_CONFIG='config/event.race.json'; pnpm dev           # PowerShell
```

Then check `curl http://127.0.0.1:8787/api/v1/health`: `eventId` must be the one you expect.

## Backup

```sh
pnpm backup
```

This writes `<DATA_DIR>/backups/tracker-<UTC time>.db` (for example
`tracker-2026-11-08T06-30-00-000Z.db`) and prints its path. It uses SQLite's online backup
(better-sqlite3 `db.backup()`), so it is safe while the server is running and the copy is
consistent, with the WAL already folded in. It uses the same `DATA_DIR` as the server
(default `<repo>/data`), and exits 1 without creating anything if `tracker.db` is missing.

Never copy `tracker.db`, `tracker.db-wal` or `tracker.db-shm` by hand while the server is
running: the files are not consistent on disk.

## Restore

1. Stop the server.
2. Move the current `tracker.db`, `tracker.db-wal` and `tracker.db-shm` (whichever exist) out
   of `DATA_DIR` into a dated folder, for example `<DATA_DIR>/backups/replaced-2026-11-08T09-00Z/`.
   Do not delete them. A `-wal` file is only left over after a crash or a kill, and it holds that
   database's last writes, so keep it with its `tracker.db`. Left in place, it would also be
   replayed onto the restored file.
3. Copy the backup to `<DATA_DIR>/tracker.db`. The backup file alone is enough.
4. Start the server. The boot replay rebuilds the same state the live server had at backup time.
