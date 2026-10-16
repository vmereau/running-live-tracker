// Append-only SQLite fix log (AD-1, AD-12): the source of truth for every position.
// Insert-only: the session row is written once by the first batch, records are
// insert-or-ignore on (sessionId, seq). Nothing is ever updated or deleted.
// "Ignore" is ON CONFLICT DO NOTHING on the primary key only: plain INSERT OR IGNORE
// would also silently drop rows that break a CHECK or NOT NULL constraint.
import Database from 'better-sqlite3';
import type { IngestRecord } from '@running-live-tracker/shared';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  sessionId        TEXT    NOT NULL PRIMARY KEY,
  runnerId         TEXT    NOT NULL,
  sessionStartedAt INTEGER NOT NULL,
  firstReceivedAt  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS records (
  sessionId  TEXT    NOT NULL REFERENCES sessions (sessionId),
  seq        INTEGER NOT NULL,
  kind       TEXT    NOT NULL CHECK (kind IN ('fix', 'end')),
  recordedAt INTEGER NOT NULL,
  receivedAt INTEGER NOT NULL,
  lat        REAL,
  lon        REAL,
  accuracyM  REAL,
  altitudeM  REAL,
  speedMps   REAL,
  PRIMARY KEY (sessionId, seq)
);
`;

export type AppendBatchInput = {
  runnerId: string;
  sessionId: string;
  sessionStartedAt: number;
  /** Server receive time, epoch ms; stamped on the session (first batch only) and on every new record. */
  receivedAt: number;
  records: readonly IngestRecord[];
};

export type StoredSession = {
  sessionId: string;
  runnerId: string;
  sessionStartedAt: number;
  firstReceivedAt: number;
};

/** A records row. Optional fields are SQL NULL in storage (the wire omits them instead). */
export type StoredRecord = {
  sessionId: string;
  seq: number;
  kind: 'fix' | 'end';
  recordedAt: number;
  receivedAt: number;
  lat: number | null;
  lon: number | null;
  accuracyM: number | null;
  altitudeM: number | null;
  speedMps: number | null;
};

export type Store = {
  /** runnerId owning the session, or undefined if the session is not stored yet. */
  sessionOwner(sessionId: string): string | undefined;
  /**
   * One transaction: inserts the session row if new, then every record, skipping (sessionId, seq) already stored.
   * Throws SessionOwnerMismatchError (and stores nothing) if the session belongs to another runner.
   * Returns how many records were new.
   */
  appendBatch(input: AppendBatchInput): { inserted: number };
  readSession(sessionId: string): StoredSession | undefined;
  /** Records of one session in seq order. */
  readRecords(sessionId: string): StoredRecord[];
  close(): void;
};

export class SessionOwnerMismatchError extends Error {
  override name = 'SessionOwnerMismatchError';
}

/** Opens (creating if needed) the fix log at `path`; `:memory:` works for tests. */
export function openStore(path: string): Store {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);

  const selectOwner = db.prepare<[string], { runnerId: string }>('SELECT runnerId FROM sessions WHERE sessionId = ?');
  const insertSession = db.prepare(
    `INSERT INTO sessions (sessionId, runnerId, sessionStartedAt, firstReceivedAt)
     VALUES (@sessionId, @runnerId, @sessionStartedAt, @firstReceivedAt)
     ON CONFLICT (sessionId) DO NOTHING`,
  );
  const insertRecord = db.prepare(
    `INSERT INTO records (sessionId, seq, kind, recordedAt, receivedAt, lat, lon, accuracyM, altitudeM, speedMps)
     VALUES (@sessionId, @seq, @kind, @recordedAt, @receivedAt, @lat, @lon, @accuracyM, @altitudeM, @speedMps)
     ON CONFLICT (sessionId, seq) DO NOTHING`,
  );
  const selectSession = db.prepare<[string], StoredSession>('SELECT * FROM sessions WHERE sessionId = ?');
  const selectRecords = db.prepare<[string], StoredRecord>('SELECT * FROM records WHERE sessionId = ? ORDER BY seq');

  const sessionOwner = (sessionId: string): string | undefined => selectOwner.get(sessionId)?.runnerId;

  const appendBatch = db.transaction((input: AppendBatchInput): { inserted: number } => {
    const { runnerId, sessionId, sessionStartedAt, receivedAt } = input;
    insertSession.run({ sessionId, runnerId, sessionStartedAt, firstReceivedAt: receivedAt });
    if (sessionOwner(sessionId) !== runnerId) {
      // Throwing inside db.transaction rolls the whole batch back.
      throw new SessionOwnerMismatchError(`session ${sessionId} belongs to another runner`);
    }
    let inserted = 0;
    for (const r of input.records) {
      const fix = r.kind === 'fix' ? r : undefined;
      const result = insertRecord.run({
        sessionId,
        seq: r.seq,
        kind: r.kind,
        recordedAt: r.recordedAt,
        receivedAt,
        lat: fix?.lat ?? null,
        lon: fix?.lon ?? null,
        accuracyM: fix?.accuracyM ?? null,
        altitudeM: fix?.altitudeM ?? null,
        speedMps: fix?.speedMps ?? null,
      });
      inserted += result.changes;
    }
    return { inserted };
  });

  return {
    sessionOwner,
    appendBatch: (input) => appendBatch(input),
    readSession: (sessionId) => selectSession.get(sessionId),
    readRecords: (sessionId) => selectRecords.all(sessionId),
    close: () => db.close(),
  };
}
