// Live map page (Story 1.6). Wiring only: the store is fed by the SSE client,
// the map and the list read it and share the runner selection.
import 'leaflet/dist/leaflet.css';
import './styles.css';
import { createStore } from './store.ts';
import { createSelection } from './selection.ts';
import { connectLive } from './live-client.ts';
import { createMapView } from './map-view.ts';
import { createRunnerList } from './runner-list.ts';

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
};

const store = createStore();
const selection = createSelection();
createMapView($('map'), store, selection);
const list = createRunnerList($('panel'), $('banner'), store, selection);
connectLive(store, list.setConnection);
