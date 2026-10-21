// Course progress (Story 3.4): moves a runner's progress along the event's course,
// one accepted fix at a time, inside a forward window. Pure; the projection folds it
// live and on replay. Thresholds may be tuned after the test run (Epic 4), only here.
import { EARTH_RADIUS_M } from './geo.ts';
import type { LatLon } from './geo.ts';
import type { Course } from './course.ts';

/** The window reaches this far behind progress (m). */
export const BACK_WINDOW_M = 50;
/** The window always reaches at least this far ahead of progress (m)... */
export const MIN_FORWARD_WINDOW_M = 1000;
/** ...and grows at this speed since the last match (m/s), for GPS gaps. */
export const WINDOW_GROWTH_MPS = 8;
/** A fix this close to the course (m) is on it. */
export const ON_COURSE_M = 100;
/** Consecutive consistent off-window fixes near the course ahead before progress jumps there. */
export const REJOIN_FIXES = 6;
/** Speed used to guess where the runner should be since the last match (m/s). */
export const EXPECTED_SPEED_MPS = 3;

export type CourseProgress = {
  /** Distance along the course (m); never decreases. */
  readonly progressM: number;
  /** Course distance skipped by rejoin jumps (m): counts in progress, not in pace. */
  readonly skippedM: number;
  /** recordedAt of the last match (or jump, or session start). */
  readonly lastMatchAt: number;
  /** True while the last fix had no match in the window. */
  readonly offCourse: boolean;
  /** Consecutive consistent off-window fixes near the course ahead. */
  readonly rejoinCount: number;
  /** The previous counted fix's ahead match (m), or null when the count is 0. */
  readonly rejoinM: number | null;
  /** The previous counted fix's recordedAt, or null when the count is 0. */
  readonly rejoinAt: number | null;
};

export type ProgressFix = LatLon & { recordedAt: number };

/** Progress at the first accepted fix: 0, with the window clock started at it. */
export function startProgress(recordedAt: number): CourseProgress {
  return { progressM: 0, skippedM: 0, lastMatchAt: recordedAt, offCourse: false, rejoinCount: 0, rejoinM: null, rejoinAt: null };
}

const DEG_M = (EARTH_RADIUS_M * Math.PI) / 180;

/**
 * The course distance in [fromM, toM] that best matches `fix`, or null when no part
 * of that stretch is within ON_COURSE_M. Segments are clipped to the stretch and
 * projected onto a local equirectangular plane around the fix. Consecutive segments
 * within ON_COURSE_M form a pass whose closest point is its candidate; the candidate
 * nearest `expectedM` wins (the earliest on a tie).
 */
export function matchOnCourse(course: Course, fix: LatLon, fromM: number, toM: number, expectedM: number): number | null {
  const { points, cumulativeM, lengthM } = course;
  const from = Math.max(0, fromM);
  const to = Math.min(lengthM, toM);
  if (!(to >= from)) return null;
  const kx = Math.cos((fix.lat * Math.PI) / 180) * DEG_M;
  const lastSegment = points.length - 2;

  // First segment (points i, i+1) ending at or after `from` (binary search).
  let lo = 0;
  let hi = lastSegment;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cumulativeM[mid + 1]! >= from) hi = mid;
    else lo = mid + 1;
  }

  let best: number | null = null;
  let bestGap = Infinity;
  let passM: number | null = null;
  let passD = Infinity;
  const closePass = (): void => {
    if (passM !== null && Math.abs(passM - expectedM) < bestGap) {
      best = passM;
      bestGap = Math.abs(passM - expectedM);
    }
    passM = null;
    passD = Infinity;
  };

  for (let i = lo; i <= lastSegment && cumulativeM[i]! <= to; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const ca = cumulativeM[i]!;
    const segM = cumulativeM[i + 1]! - ca;
    const d0 = Math.max(ca, from);
    const d1 = Math.min(ca + segM, to);
    const f0 = segM > 0 ? (d0 - ca) / segM : 0;
    const f1 = segM > 0 ? (d1 - ca) / segM : 0;
    // Clipped segment ends, in metres relative to the fix.
    const x0 = (a.lon + (b.lon - a.lon) * f0 - fix.lon) * kx;
    const y0 = (a.lat + (b.lat - a.lat) * f0 - fix.lat) * DEG_M;
    const x1 = (a.lon + (b.lon - a.lon) * f1 - fix.lon) * kx;
    const y1 = (a.lat + (b.lat - a.lat) * f1 - fix.lat) * DEG_M;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.min(1, Math.max(0, -(x0 * dx + y0 * dy) / len2)) : 0;
    const dist = Math.hypot(x0 + t * dx, y0 + t * dy);
    if (dist <= ON_COURSE_M) {
      if (dist < passD) {
        passD = dist;
        passM = t === 0 ? d0 : t === 1 ? d1 : d0 + t * (d1 - d0);
      }
    } else {
      closePass();
    }
  }
  closePass();
  return best;
}

/** Advances progress by one accepted fix. Pure. */
export function advanceProgress(course: Course, state: CourseProgress, fix: ProgressFix): CourseProgress {
  const p = state.progressM;
  const dtS = Math.max(0, (fix.recordedAt - state.lastMatchAt) / 1000);
  const expectedM = p + EXPECTED_SPEED_MPS * dtS;
  const fromM = Math.max(0, p - BACK_WINDOW_M);
  const toM = Math.min(course.lengthM, p + Math.max(MIN_FORWARD_WINDOW_M, WINDOW_GROWTH_MPS * dtS));

  const matchM = matchOnCourse(course, fix, fromM, toM, expectedM);
  if (matchM !== null) {
    return { ...state, progressM: Math.max(p, matchM), lastMatchAt: fix.recordedAt, offCourse: false, rejoinCount: 0, rejoinM: null, rejoinAt: null };
  }

  const aheadM = matchOnCourse(course, fix, p, course.lengthM, expectedM);
  if (aheadM === null) return { ...state, offCourse: true, rejoinCount: 0, rejoinM: null, rejoinAt: null };

  // Rejoin consistency: a counted fix must move along the same stretch as the previous one.
  let count = state.rejoinCount + 1;
  if (state.rejoinCount > 0 && state.rejoinM !== null && state.rejoinAt !== null) {
    const sinceS = Math.max(0, (fix.recordedAt - state.rejoinAt) / 1000);
    if (aheadM < state.rejoinM - BACK_WINDOW_M || aheadM > state.rejoinM + ON_COURSE_M + WINDOW_GROWTH_MPS * sinceS) count = 1;
  }
  if (count >= REJOIN_FIXES) {
    const target = Math.max(p, aheadM);
    return {
      progressM: target,
      skippedM: state.skippedM + (target - p),
      lastMatchAt: fix.recordedAt,
      offCourse: false,
      rejoinCount: 0,
      rejoinM: null,
      rejoinAt: null,
    };
  }
  return { ...state, offCourse: true, rejoinCount: count, rejoinM: aheadM, rejoinAt: fix.recordedAt };
}
