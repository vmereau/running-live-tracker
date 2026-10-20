// Leaflet map: one circle marker (current position) and one polyline (recorded
// track) per runner, in the runner's configured color, synced from the store.
// View modes come from `selection`: in the "All runners" overview the map fits
// the runners' positions on the first data and on every showAll(), and is
// otherwise left to the spectator; with a runner selected and followed, a store
// change that moves that runner pans to its new position (a track event or an
// unchanged position does nothing). A hand pan or zoom pauses following
// and shows a "Re-center" control. The event's course (Story 3.3), once
// loaded, is drawn as a dashed neutral line in its own pane beneath every
// track; while no runner has a position, the overview fits it. The decisions
// live in camera.ts; this module only executes them.
import L from 'leaflet';
import type { RunnerView, Snapshot, TrackPoint } from '@running-live-tracker/shared';
import type { Store } from './store.ts';
import type { Selection, SelectionState } from './selection.ts';
import {
  type CameraAction,
  type CameraPlan,
  type LatLon,
  initialCameraMemory,
  planCourseLoaded,
  planSelectionChange,
  planStoreChange,
  recenterVisible,
} from './camera.ts';

const FALLBACK_COLOR = '#555555';
const MARKER_RADIUS = 7;
const MARKER_RADIUS_SELECTED = 11;
const LINE_WEIGHT = 3;
const LINE_WEIGHT_SELECTED = 6;
const OVERVIEW_MAX_ZOOM = 16;
const COURSE_STYLE: L.PolylineOptions = {
  pane: 'course',
  interactive: false,
  color: '#3a3a3a',
  weight: 4,
  opacity: 0.6,
  dashArray: '8 8',
  lineCap: 'butt',
};

export type MapView = {
  /** Draws the course beneath the tracks (replacing any previous one) and fits it if nothing else was fitted yet. */
  setCourse(points: readonly LatLon[]): void;
};

type Layers = { color: string; line: L.Polyline; marker: L.CircleMarker | null; track: TrackPoint[] | undefined };

export function createMapView(container: HTMLElement, store: Store, selection: Selection): MapView {
  const map = L.map(container, { worldCopyJump: true }).setView([20, 0], 2);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  // Markers live above every track so a thick selected line never hides them.
  map.createPane('runners').style.zIndex = '450';
  // The course sits below the tracks (overlayPane, 400) and never takes taps.
  const coursePane = map.createPane('course');
  coursePane.style.zIndex = '350';
  coursePane.style.pointerEvents = 'none';
  let courseLine: L.Polyline | null = null;

  const layers = new Map<string, Layers>();
  let camera = initialCameraMemory();
  /** True while code moves the map: a zoomstart seen then is not the spectator's. */
  let programmatic = false;

  /**
   * Runs a programmatic move. Moves that change the zoom must use `animate: false`
   * so their zoomstart fires synchronously, inside this guard.
   */
  function guarded(move: () => void): void {
    programmatic = true;
    try {
      move();
    } finally {
      programmatic = false;
    }
  }

  // Only real hand gestures pause following. `movestart` is never used: animated
  // pans and invalidateSize (rotation, address bar, resize) fire it too.
  map.on('dragstart', () => selection.pauseFollow());
  map.on('zoomstart', () => {
    if (!programmatic) selection.pauseFollow();
  });

  const recenter = createRecenterControl(() => selection.resumeFollow());
  recenter.addTo(map); // added after the zoom control, so it sits right under it

  function colorOf(snapshot: Snapshot, runnerId: string): string {
    return snapshot.event.runners.find((r) => r.runnerId === runnerId)?.color ?? FALLBACK_COLOR;
  }

  function selectedView(): RunnerView | undefined {
    const { selectedId } = selection.get();
    if (selectedId === null) return undefined;
    return store.getState().snapshot?.runners.find((r) => r.runnerId === selectedId);
  }

  function style(runnerId: string, entry: Layers): void {
    const selected = selection.get().selectedId === runnerId;
    entry.line.setStyle({ weight: selected ? LINE_WEIGHT_SELECTED : LINE_WEIGHT, opacity: selected ? 1 : 0.8 });
    entry.marker?.setStyle({ weight: selected ? 3 : 2 });
    entry.marker?.setRadius(selected ? MARKER_RADIUS_SELECTED : MARKER_RADIUS);
    if (selected) {
      entry.line.bringToFront();
      entry.marker?.bringToFront();
    }
  }

  function sync(snapshot: Snapshot): void {
    const seen = new Set<string>();
    for (const view of snapshot.runners) {
      const id = view.runnerId;
      seen.add(id);
      const color = colorOf(snapshot, id);
      let entry = layers.get(id);
      if (!entry || entry.color !== color) {
        if (entry) remove(entry);
        entry = { color, line: L.polyline([], { color, interactive: false }).addTo(map), marker: null, track: undefined };
        layers.set(id, entry);
      }
      // The store keeps untouched runners' track arrays by reference: only re-project changed ones.
      const track = snapshot.tracks[id];
      if (track !== entry.track) {
        entry.track = track;
        entry.line.setLatLngs((track ?? []).map((p) => [p.lat, p.lon] as L.LatLngTuple));
      }
      if (view.lastPosition) {
        const at: L.LatLngTuple = [view.lastPosition.lat, view.lastPosition.lon];
        if (entry.marker) {
          entry.marker.setLatLng(at);
        } else {
          entry.marker = L.circleMarker(at, {
            pane: 'runners',
            radius: MARKER_RADIUS,
            color: '#ffffff',
            weight: 2,
            fillColor: color,
            fillOpacity: 1,
          }).addTo(map);
          entry.marker.on('click', () => selection.select(id));
        }
      } else if (entry.marker) {
        entry.marker.remove();
        entry.marker = null;
      }
      style(id, entry);
    }
    for (const [id, entry] of layers) {
      if (!seen.has(id)) {
        remove(entry);
        layers.delete(id);
      }
    }
  }

  function remove(entry: Layers): void {
    entry.line.remove();
    entry.marker?.remove();
  }

  /** Executes a camera plan and keeps its bookkeeping. */
  function run({ action, memory }: CameraPlan): void {
    camera = memory;
    execute(action);
  }

  function execute(action: CameraAction): void {
    switch (action.kind) {
      case 'none':
        return;
      case 'fit': {
        const bounds = L.latLngBounds(action.points.map((p) => [p.lat, p.lon] as L.LatLngTuple));
        guarded(() => map.fitBounds(bounds, { padding: [40, 40], maxZoom: OVERVIEW_MAX_ZOOM, animate: false }));
        return;
      }
      case 'center':
        guarded(() => map.setView([action.at.lat, action.at.lon], action.zoom, { animate: false }));
        return;
      case 'pan':
        // Same zoom: an animated pan fires only movestart, which never pauses following.
        map.panTo([action.at.lat, action.at.lon]);
        return;
      case 'showAll':
        selection.showAll(); // its listener restyles, fits and updates the control
        return;
    }
  }

  function runners(): RunnerView[] {
    return store.getState().snapshot?.runners ?? [];
  }

  function updateRecenter(): void {
    recenter.setVisible(recenterVisible(selection.get(), selectedView()));
  }

  store.subscribe(({ snapshot }) => {
    if (!snapshot) return;
    sync(snapshot);
    const plan = planStoreChange(selection.get(), snapshot.runners, map.getZoom(), camera);
    run(plan);
    if (plan.action.kind !== 'showAll') updateRecenter();
  });

  let previous: SelectionState = selection.get();
  selection.subscribe((state) => {
    for (const [id, entry] of layers) style(id, entry);
    const plan = planSelectionChange(previous, state, runners(), map.getZoom(), camera);
    previous = state;
    run(plan);
    updateRecenter();
  });

  function setCourse(points: readonly LatLon[]): void {
    courseLine?.remove();
    courseLine = L.polyline(points.map((p) => [p.lat, p.lon] as L.LatLngTuple), COURSE_STYLE).addTo(map);
    run(planCourseLoaded(selection.get(), runners(), points, camera));
  }

  return { setCourse };
}

type RecenterControl = L.Control & { setVisible: (visible: boolean) => void };

function createRecenterControl(onPress: () => void): RecenterControl {
  const container = L.DomUtil.create('div', 'leaflet-bar recenter-control');
  const button = L.DomUtil.create('button', 'recenter-button', container);
  button.type = 'button';
  button.textContent = 'Re-center';
  button.title = 'Follow the selected runner again';
  L.DomEvent.disableClickPropagation(container);
  L.DomEvent.disableScrollPropagation(container);
  L.DomEvent.on(button, 'click', () => onPress());
  container.hidden = true;

  const control = new L.Control({ position: 'topleft' }) as RecenterControl;
  control.onAdd = () => container;
  control.setVisible = (visible) => {
    container.hidden = !visible;
  };
  return control;
}
