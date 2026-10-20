// The event's GPX course (Story 3.3). The course is not part of the live
// stream: once a snapshot says `hasCourse`, it is fetched once from
// GET /api/v1/course (a GeoJSON LineString, [lon, lat]) and handed over as
// {lat, lon} points. A failed fetch is retried on the next snapshot.
import { CourseGeoJson } from '@running-live-tracker/shared';
import type { LatLon } from './camera.ts';
import type { Store } from './store.ts';

export const COURSE_URL = '/api/v1/course';

/** Validates a /api/v1/course body and swaps it to {lat, lon}. Throws on an invalid body. */
export function parseCourse(json: unknown): LatLon[] {
  return CourseGeoJson.parse(json).coordinates.map(([lon, lat]) => ({ lat, lon }));
}

export type FetchCourse = (url: string) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;

/**
 * Calls `onCourse` once with the course points, after the first snapshot with
 * `hasCourse`. At most one fetch runs at a time and none after a success; a
 * failure (network error, non-200, invalid body) is logged with console.warn
 * and retried on the next snapshot (a fresh SSE snapshot, not a runner or track event).
 */
export function watchCourse(
  store: Store,
  onCourse: (points: LatLon[]) => void,
  fetchCourse: FetchCourse = (url) => fetch(url),
): void {
  let state: 'idle' | 'loading' | 'done' = 'idle';
  // runner and track events copy the snapshot but keep its `event` object; a new
  // SSE snapshot brings a new one. Only new snapshots may start a (re)try.
  let lastEvent: unknown = null;

  async function load(): Promise<void> {
    state = 'loading';
    let points: LatLon[];
    try {
      const res = await fetchCourse(COURSE_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      points = parseCourse(await res.json());
    } catch (err) {
      state = 'idle';
      console.warn('course fetch failed, retrying on the next snapshot:', err);
      return;
    }
    state = 'done';
    onCourse(points);
  }

  store.subscribe(({ snapshot }) => {
    if (!snapshot || snapshot.event === lastEvent) return;
    lastEvent = snapshot.event;
    if (state === 'idle' && snapshot.event.hasCourse) void load();
  });
}
