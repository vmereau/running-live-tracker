// pnpm backup: writes a consistent copy of the live fix log to <DATA_DIR>/backups/.
// Uses SQLite's online backup (better-sqlite3 db.backup()), safe while the server runs.
// Never file-copy tracker.db / -wal / -shm: a WAL database is not consistent on disk.
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';

/** Backup file name for a moment: tracker-<UTC ISO with ':' and '.' replaced by '-'>.db */
export function backupFileName(now: Date): string {
  return `tracker-${now.toISOString().replace(/[:.]/g, '-')}.db`;
}

/** Copies <dataDir>/tracker.db to <dataDir>/backups/ and returns the copy's path. Rejects if the DB is missing. */
export async function backupDatabase(dataDir: string, now = new Date()): Promise<string> {
  const dbPath = join(dataDir, 'tracker.db');
  const backupsDir = join(dataDir, 'backups');
  const dest = join(backupsDir, backupFileName(now));
  let db: Database.Database;
  try {
    db = new Database(dbPath, { fileMustExist: true });
  } catch (err) {
    throw new Error(`Cannot open the data store at ${dbPath}: ${(err as Error).message}`);
  }
  try {
    mkdirSync(backupsDir, { recursive: true });
    try {
      await db.backup(dest);
    } catch (err) {
      rmSync(dest, { force: true }); // never leave a partial copy that looks like a backup
      throw err;
    }
  } finally {
    db.close();
  }
  return dest;
}

if (import.meta.main) {
  // Same DATA_DIR env and default as server/src/main.ts.
  const repoRoot = resolve(import.meta.dirname, '..', '..');
  const dataDir = resolve(process.env['DATA_DIR'] ?? resolve(repoRoot, 'data'));
  try {
    const dest = await backupDatabase(dataDir);
    console.log(dest);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
