// Camera decisions for the live map, kept pure (no Leaflet) so they can be
// tested: given the view mode, the store's runners, the current zoom and a bit
// of bookkeeping, say what the map should do. map-view.ts only executes the
// returned action (and owns the programmatic-move guard).
import type { RunnerView } from '@running-live-tracker/shared';
import type { SelectionState } from './selection.ts';

/** Selecting (or re-centering on) a runner zooms in to at least this level. */
export const FOLLOW_MIN_ZOOM = 15;

export type LatLon = { lat: number; lon: number };

export type CameraMemory = {
  /** The overview already fitted the runners once (later events never refit it). */
  fitted: boolean;
  /** The next center on the followed runner also zooms in to FOLLOW_MIN_ZOOM. */
  zoomOnNextFollow: boolean;
  /** Last position the map was centered on while following. */
  lastCentered: LatLon | null;
};

export type CameraAction =
  | { kind: 'none' }
  /** Fit all these positions (non-empty), without animation. */
  | { kind: 'fit'; points: LatLon[] }
  /** Center here at this zoom, without animation (the zoom may change). */
  | { kind: 'center'; at: LatLon; zoom: number }
  /** Animated pan at the current zoom. */
  | { kind: 'pan'; at: LatLon }
  /** The selected runner is gone: go back to the overview. */
  | { kind: 'showAll' };

export type CameraPlan = { action: CameraAction; memory: CameraMemory };

type Runners = readonly Pick<RunnerView, 'runnerId' | 'lastPosition'>[];

export function initialCameraMemory(): CameraMemory {
  return { fitted: false, zoomOnNextFollow: false, lastCentered: null };
}

const NONE: CameraAction = { kind: 'none' };

/** Fits every runner that has a position (positions only, not tracks); no move when none has one. */
function planFit(runners: Runners, memory: CameraMemory): CameraPlan {
  const points: LatLon[] = [];
  for (const view of runners) {
    if (view.lastPosition) points.push({ lat: view.lastPosition.lat, lon: view.lastPosition.lon });
  }
  if (points.length === 0) return { action: NONE, memory };
  return { action: { kind: 'fit', points }, memory: { ...memory, fitted: true } };
}

/** Centers on the followed runner when it has a position; zooms in when a (re)selection asked for it. */
function planFollow(state: SelectionState, runners: Runners, zoom: number, memory: CameraMemory): CameraPlan {
  const position = runners.find((r) => r.runnerId === state.selectedId)?.lastPosition;
  if (!state.following || !position) return { action: NONE, memory };
  const at = { lat: position.lat, lon: position.lon };
  if (memory.zoomOnNextFollow) {
    return {
      action: { kind: 'center', at, zoom: Math.max(zoom, FOLLOW_MIN_ZOOM) },
      memory: { ...memory, zoomOnNextFollow: false, lastCentered: at },
    };
  }
  const last = memory.lastCentered;
  if (last && last.lat === at.lat && last.lon === at.lon) return { action: NONE, memory }; // e.g. a track event
  return { action: { kind: 'pan', at }, memory: { ...memory, lastCentered: at } };
}

/** After every store change (snapshot, runner or track event). */
export function planStoreChange(state: SelectionState, runners: Runners, zoom: number, memory: CameraMemory): CameraPlan {
  if (state.selectedId === null) return memory.fitted ? { action: NONE, memory } : planFit(runners, memory);
  if (!runners.some((r) => r.runnerId === state.selectedId)) return { action: { kind: 'showAll' }, memory };
  return planFollow(state, runners, zoom, memory);
}

/**
 * Once the course has loaded. In the overview, before any runner fit and while
 * no runner has a position, fit the course. Does not set `fitted`, so the first
 * runner position still triggers the usual runner fit.
 */
export function planCourseLoaded(
  state: SelectionState,
  runners: Runners,
  points: readonly LatLon[],
  memory: CameraMemory,
): CameraPlan {
  if (state.selectedId !== null || memory.fitted || points.length === 0 || runners.some((r) => r.lastPosition)) {
    return { action: NONE, memory };
  }
  return { action: { kind: 'fit', points: points.map((p) => ({ lat: p.lat, lon: p.lon })) }, memory };
}

/** After every selection change. */
export function planSelectionChange(
  previous: SelectionState,
  state: SelectionState,
  runners: Runners,
  zoom: number,
  memory: CameraMemory,
): CameraPlan {
  if (state.selectedId === null) return planFit(runners, memory);
  if (state.following && (!previous.following || previous.selectedId !== state.selectedId)) {
    // Selected, switched, re-selected or re-centered: center at once (or on the first position).
    return planFollow(state, runners, zoom, { ...memory, zoomOnNextFollow: true, lastCentered: null });
  }
  return { action: NONE, memory };
}

/** "Re-center" shows only while a runner is selected, following is paused and the runner has a position. */
export function recenterVisible(state: SelectionState, view: Pick<RunnerView, 'lastPosition'> | undefined): boolean {
  return state.selectedId !== null && !state.following && Boolean(view?.lastPosition);
}
