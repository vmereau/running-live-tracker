import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { backupDatabase } from './backup.ts';

const scriptPath = join(import.meta.dirname, 'backup.ts');

/** A temp data dir holding a WAL-mode tracker.db with one row; the connection stays open (like a live server). */
function liveDataDir() {
  const dataDir = mkdtempSync(join(tmpdir(), 'rlt-backup-'));
  const db = new Database(join(dataDir, 'tracker.db'));
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE t (v TEXT)');
  db.prepare('INSERT INTO t (v) VALUES (?)').run('hello');
  return { dataDir, db };
}

test('backupDatabase names the copy after the UTC time, creates backups/ and copies the rows', async () => {
  const { dataDir, db } = liveDataDir();
  try {
    assert.ok(!existsSync(join(dataDir, 'backups')));
    const dest = await backupDatabase(dataDir, new Date(Date.UTC(2026, 9, 21, 7, 5, 9, 42)));
    assert.equal(dest, join(dataDir, 'backups', 'tracker-2026-10-21T07-05-09-042Z.db'));
    assert.ok(existsSync(dest));
    const copy = new Database(dest, { readonly: true, fileMustExist: true });
    try {
      assert.deepStrictEqual(copy.prepare('SELECT v FROM t').all(), [{ v: 'hello' }]);
    } finally {
      copy.close();
    }
  } finally {
    db.close();
  }
});

test('backupDatabase rejects naming the path when tracker.db is missing, and creates nothing', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'rlt-backup-empty-'));
  await assert.rejects(backupDatabase(dataDir), (err: Error) => err.message.includes(join(dataDir, 'tracker.db')));
  assert.deepStrictEqual(readdirSync(dataDir), []);
});

test('backupDatabase rejects and leaves no copy when backups/ cannot be created', async () => {
  const { dataDir, db } = liveDataDir();
  try {
    writeFileSync(join(dataDir, 'backups'), 'not a folder');
    await assert.rejects(backupDatabase(dataDir));
    assert.equal(readFileSync(join(dataDir, 'backups'), 'utf8'), 'not a folder');
    assert.ok(!readdirSync(dataDir).some((f) => f.startsWith('tracker-')));
  } finally {
    db.close();
  }
});

test('backup CLI uses DATA_DIR and prints the backup path', () => {
  const { dataDir, db } = liveDataDir();
  try {
    const res = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8', env: { ...process.env, DATA_DIR: dataDir } });
    assert.equal(res.status, 0, res.stderr);
    const printed = res.stdout.trim();
    assert.ok(printed.startsWith(join(dataDir, 'backups', 'tracker-')), printed);
    assert.ok(existsSync(printed));
    assert.deepStrictEqual(readdirSync(join(dataDir, 'backups')).length, 1);
  } finally {
    db.close();
  }
});

test('backup CLI exits 1 naming the path when tracker.db is missing', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'rlt-backup-empty-'));
  const res = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8', env: { ...process.env, DATA_DIR: dataDir } });
  assert.equal(res.status, 1);
  assert.ok(res.stderr.includes(join(dataDir, 'tracker.db')), res.stderr);
  assert.equal(res.stdout, '');
  assert.deepStrictEqual(readdirSync(dataDir), []);
});
