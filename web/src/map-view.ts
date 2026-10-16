// Leaflet map: one circle marker (current position) and one polyline (recorded
// track) per runner, in the runner's configured color, synced from the store.
// The view fits the data once, on the first snapshot that has any; after that
// only the spectator moves the map (or selecting a runner pans to it).
import L from 'leaflet';
import type { Snapshot, TrackPoint } from '@running-live-tracker/shared';
import type { Store } from './store.ts';
import type { Selection } from './selection.ts';

const FALLBACK_COLOR = '#555555';
const MARKER_RADIUS = 7;
const MARKER_RADIUS_SELECTED = 11;
const LINE_WEIGHT = 3;
const LINE_WEIGHT_SELECTED = 6;

type Layers = { color: string; line: L.Polyline; marker: L.CircleMarker | null; track: TrackPoint[] | undefined };

export function createMapView(container: HTMLElement, store: Store, selection: Selection): void {
  const map = L.map(container, { worldCopyJump: true }).setView([20, 0], 2);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  // Markers live above every track so a thick selected line never hides them.
  map.createPane('runners').style.zIndex = '450';

  const layers = new Map<string, Layers>();
  let fitted = false;

  function colorOf(snapshot: Snapshot, runnerId: string): string {
    return snapshot.event.runners.find((r) => r.runnerId === runnerId)?.color ?? FALLBACK_COLOR;
  }

  function style(runnerId: string, entry: Layers): void {
    const selected = selection.get() === runnerId;
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
          entry.marker.on('click', () => selection.toggle(id));
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
    if (!fitted) fitOnce(snapshot);
  }

  function remove(entry: Layers): void {
    entry.line.remove();
    entry.marker?.remove();
  }

  function fitOnce(snapshot: Snapshot): void {
    const points: L.LatLngTuple[] = [];
    for (const view of snapshot.runners) {
      if (view.lastPosition) points.push([view.lastPosition.lat, view.lastPosition.lon]);
    }
    for (const track of Object.values(snapshot.tracks)) {
      for (const p of track) points.push([p.lat, p.lon]);
    }
    if (points.length === 0) return;
    fitted = true;
    map.fitBounds(L.latLngBounds(points), { padding: [40, 40], maxZoom: 16 });
  }

  store.subscribe(({ snapshot }) => {
    if (snapshot) sync(snapshot);
  });

  selection.subscribe((runnerId) => {
    for (const [id, entry] of layers) style(id, entry);
    if (runnerId === null) return;
    const position = store.getState().snapshot?.runners.find((r) => r.runnerId === runnerId)?.lastPosition;
    if (position) map.panTo([position.lat, position.lon]);
  });
}
