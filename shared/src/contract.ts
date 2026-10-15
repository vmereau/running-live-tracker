// Wire contract (AD-9): the only definition of the shapes exchanged between
// the phone, the server and the web page. Schemas strip unknown keys by
// default so a phone sending an extra field is not rejected; only EventInfo is
// strict, because it is a public payload that must never leak config fields.
import { z } from 'zod';

/** Largest number of records accepted in one ingest batch (AD-3). Enforced by ingest (413), not by the schema. */
export const MAX_BATCH_RECORDS = 200;

const epochMs = z.number().int().nonnegative();
const seq = z.number().int().nonnegative();
const lat = z.number().min(-90).max(90);
const lon = z.number().min(-180).max(180);
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'expected a #rrggbb color');

// ---- ingest (phone -> server) ----

export const FixRecord = z.object({
  seq,
  kind: z.literal('fix'),
  recordedAt: epochMs,
  lat,
  lon,
  accuracyM: z.number().positive(),
  altitudeM: z.number().optional(),
  speedMps: z.number().nonnegative().optional(),
});
export type FixRecord = z.infer<typeof FixRecord>;

export const EndRecord = z.object({
  seq,
  kind: z.literal('end'),
  recordedAt: epochMs,
});
export type EndRecord = z.infer<typeof EndRecord>;

export const IngestRecord = z.discriminatedUnion('kind', [FixRecord, EndRecord]);
export type IngestRecord = z.infer<typeof IngestRecord>;

export const IngestBatch = z.object({
  sessionId: z.uuidv4(),
  sessionStartedAt: epochMs,
  records: z
    .array(IngestRecord)
    .min(1)
    .refine(
      (records) => records.every((r, i) => i === 0 || r.seq > records[i - 1]!.seq),
      { message: 'records must be in strictly increasing seq order' },
    ),
});
export type IngestBatch = z.infer<typeof IngestBatch>;

export const IngestAck = z.object({
  sessionId: z.uuidv4(),
  ackedThroughSeq: seq,
  serverNow: epochMs,
});
export type IngestAck = z.infer<typeof IngestAck>;

// ---- errors ----

export const ErrorBody = z.object({
  error: z.object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'expected a SCREAMING_SNAKE code'),
    message: z.string(),
  }),
});
export type ErrorBody = z.infer<typeof ErrorBody>;

// ---- read side (server -> web) ----

export const EventInfo = z.strictObject({
  eventId: z.string().min(1),
  name: z.string(),
  hasCourse: z.boolean(),
  lengthM: z.number().nonnegative().nullable(),
  runners: z.array(
    z.strictObject({
      runnerId: z.string().min(1),
      displayName: z.string(),
      color: hexColor,
    }),
  ),
});
export type EventInfo = z.infer<typeof EventInfo>;

export const TrackPoint = z.object({
  lat,
  lon,
  recordedAt: epochMs,
});
export type TrackPoint = z.infer<typeof TrackPoint>;

export const RunnerStatus = z.enum(['notStarted', 'active', 'stopped']);
export type RunnerStatus = z.infer<typeof RunnerStatus>;

export const RunnerView = z.object({
  runnerId: z.string().min(1),
  status: RunnerStatus,
  runStartedAt: epochMs.nullable(),
  runEndedAt: epochMs.nullable(),
  lastFixAt: epochMs.nullable(),
  lastReceivedAt: epochMs.nullable(),
  lastPosition: z.object({ lat, lon }).nullable(),
  distanceM: z.number().nonnegative(),
  progressM: z.number().nonnegative().nullable(),
  remainingM: z.number().nonnegative().nullable(),
  progressFraction: z.number().min(0).max(1).nullable(),
  offCourse: z.boolean(),
  avgPaceSPerKm: z.number().positive().nullable(),
  currentPaceSPerKm: z.number().positive().nullable(),
  etaAt: epochMs.nullable(),
});
export type RunnerView = z.infer<typeof RunnerView>;

export const Snapshot = z.object({
  serverNow: epochMs,
  event: EventInfo,
  runners: z.array(RunnerView),
  tracks: z.record(z.string(), z.array(TrackPoint)),
});
export type Snapshot = z.infer<typeof Snapshot>;

// ---- SSE payloads (AD-6) ----

export const RunnerEvent = z.object({
  serverNow: epochMs,
  view: RunnerView,
});
export type RunnerEvent = z.infer<typeof RunnerEvent>;

export const TrackEvent = z.object({
  serverNow: epochMs,
  runnerId: z.string().min(1),
  points: z.array(TrackPoint),
});
export type TrackEvent = z.infer<typeof TrackEvent>;
