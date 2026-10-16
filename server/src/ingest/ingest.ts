// Ingest protocol (AD-3, AD-5, AD-12): authenticate a runner key, validate one
// batch, check session ownership, store it in one transaction and build the ack.
// The only writer of the fix log. Runner identity comes from the key alone.
import { IngestBatch, MAX_BATCH_RECORDS } from '@running-live-tracker/shared';
import type { IngestAck } from '@running-live-tracker/shared';
import type { KeyLookup } from '../config/key-lookup.ts';
import { SessionOwnerMismatchError } from '../store/open-store.ts';
import type { Store } from '../store/open-store.ts';

export type IngestErrorCode = 'INVALID_BATCH' | 'BATCH_TOO_LARGE' | 'SESSION_OWNER_MISMATCH';

export type IngestRejection = { ok: false; status: 400 | 409 | 413; code: IngestErrorCode; message: string };

export type IngestAccepted = {
  ok: true;
  ack: IngestAck;
  /** Records in the batch, and how many of them were new (the rest were already stored). */
  recordCount: number;
  inserted: number;
  /** receivedAt - max recordedAt in the batch: how far the phone's clock trails (or leads) the server's. */
  clockSkewMs: number;
};

export type IngestResult = IngestAccepted | IngestRejection;

export type Ingest = {
  /** runnerId for an `Authorization: Bearer <key>` header, or undefined (missing, malformed or unknown key). */
  authenticate(authorizationHeader: string | undefined): string | undefined;
  /** Validates and stores one batch for an authenticated runner. Rejections store nothing. */
  ingestBatch(runnerId: string, body: unknown): IngestResult;
};

export type CreateIngestOptions = {
  store: Store;
  findRunner: KeyLookup;
  /** Server clock, epoch ms. */
  now: () => number;
};

const BEARER = /^Bearer +(\S+) *$/i;

function reject(status: IngestRejection['status'], code: IngestErrorCode, message: string): IngestRejection {
  return { ok: false, status, code, message };
}

export function createIngest({ store, findRunner, now }: CreateIngestOptions): Ingest {
  return {
    authenticate(authorizationHeader) {
      if (typeof authorizationHeader !== 'string') return undefined;
      const key = BEARER.exec(authorizationHeader)?.[1];
      return key === undefined ? undefined : findRunner(key);
    },

    ingestBatch(runnerId, body) {
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        return reject(400, 'INVALID_BATCH', 'Body must be a JSON object');
      }
      const records = (body as { records?: unknown }).records;
      if (Array.isArray(records) && records.length > MAX_BATCH_RECORDS) {
        return reject(413, 'BATCH_TOO_LARGE', `A batch holds at most ${MAX_BATCH_RECORDS} records, got ${records.length}`);
      }
      const parsed = IngestBatch.safeParse(body);
      if (!parsed.success) {
        // Paths and rule messages only: zod messages do not echo the submitted values.
        const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
        return reject(400, 'INVALID_BATCH', `Invalid batch: ${issues.join('; ')}`);
      }
      const batch = parsed.data;

      const owner = store.sessionOwner(batch.sessionId);
      if (owner !== undefined && owner !== runnerId) {
        return reject(409, 'SESSION_OWNER_MISMATCH', 'This session belongs to another runner');
      }

      const receivedAt = now();
      let inserted: number;
      try {
        ({ inserted } = store.appendBatch({
          runnerId,
          sessionId: batch.sessionId,
          sessionStartedAt: batch.sessionStartedAt,
          receivedAt,
          records: batch.records,
        }));
      } catch (err) {
        if (err instanceof SessionOwnerMismatchError) {
          return reject(409, 'SESSION_OWNER_MISMATCH', 'This session belongs to another runner');
        }
        throw err;
      }

      // The schema guarantees at least one record, in increasing seq order.
      const last = batch.records[batch.records.length - 1]!;
      const maxRecordedAt = Math.max(...batch.records.map((r) => r.recordedAt));
      return {
        ok: true,
        ack: { sessionId: batch.sessionId, ackedThroughSeq: last.seq, serverNow: receivedAt },
        recordCount: batch.records.length,
        inserted,
        clockSkewMs: receivedAt - maxRecordedAt,
      };
    },
  };
}
