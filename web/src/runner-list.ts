// Compact runner list overlay: an "All runners" button (pressed in the
// overview), a stats block for the selected runner, then per runner a color
// swatch, name, status, a ticking "last update" age and a stats line (ticking
// elapsed time, then the server's distance and paces, only formatted here),
// plus the connection banner. Rows are keyed and updated in place so a tap is
// never lost to a re-render.
import type { Snapshot } from '@running-live-tracker/shared';
import type { Store } from './store.ts';
import type { Selection } from './selection.ts';
import type { ConnectionStatus } from './live-client.ts';
import { ageMs, formatAge, runnerStatsText, selectedPanelText, statusLabel } from './format.ts';

const TICK_MS = 1_000;
const FALLBACK_COLOR = '#555555';

type Row = {
  item: HTMLLIElement;
  button: HTMLButtonElement;
  swatch: HTMLElement;
  name: HTMLElement;
  status: HTMLElement;
  age: HTMLElement;
  elapsed: HTMLElement;
  distance: HTMLElement;
  currentPace: HTMLElement;
  avgPace: HTMLElement;
};

export type RunnerList = { setConnection: (status: ConnectionStatus) => void };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

export function createRunnerList(root: HTMLElement, banner: HTMLElement, store: Store, selection: Selection): RunnerList {
  const title = el('div', 'panel-title');
  const allButton = el('button', 'all-runners');
  allButton.type = 'button';
  allButton.textContent = 'All runners';
  allButton.addEventListener('click', () => selection.showAll());
  const detail = el('div', 'panel-detail');
  const detailTitle = el('div', 'detail-title');
  const detailNote = el('div', 'detail-note');
  detailNote.textContent = 'Not started yet';
  const detailStats = el('dl', 'detail-stats');
  detail.append(detailTitle, detailNote, detailStats);
  detail.hidden = true;
  const list = el('ul', 'runner-list');
  title.textContent = 'Live runners';
  root.replaceChildren(title, allButton, detail, list);

  const rows = new Map<string, Row>();

  function displayName(snapshot: Snapshot, runnerId: string): string {
    return snapshot.event.runners.find((r) => r.runnerId === runnerId)?.displayName ?? runnerId;
  }

  function createRow(runnerId: string): Row {
    const item = el('li');
    const button = el('button', 'runner');
    button.type = 'button';
    const swatch = el('span', 'swatch');
    const text = el('span', 'runner-text');
    const name = el('span', 'runner-name');
    const meta = el('span', 'runner-meta');
    const status = el('span');
    const age = el('span');
    meta.append(status, ' · ', age);
    const stats = el('span', 'runner-stats');
    const elapsed = el('span');
    const distance = el('span');
    const currentPace = el('span');
    const avgPace = el('span');
    elapsed.title = 'elapsed time';
    distance.title = 'distance';
    currentPace.title = 'current pace';
    avgPace.title = 'average pace';
    stats.append(elapsed, ' · ', distance, ' · now ', currentPace, ' · avg ', avgPace);
    text.append(name, meta, stats);
    button.append(swatch, text);
    button.addEventListener('click', () => selection.select(runnerId));
    item.append(button);
    return { item, button, swatch, name, status, age, elapsed, distance, currentPace, avgPace };
  }

  /** Everything that moves with the clock alone: last-update age and elapsed time. */
  function renderTicking(): void {
    const snapshot = store.getState().snapshot;
    if (!snapshot) return;
    const now = store.now();
    for (const view of snapshot.runners) {
      const row = rows.get(view.runnerId);
      if (!row) continue;
      const age = ageMs(view.lastReceivedAt, now);
      row.age.textContent = age === null ? formatAge(age) : `last update ${formatAge(age)}`;
      row.elapsed.textContent = runnerStatsText(view, now).elapsed;
    }
  }

  /** The selected runner's stats block (server values formatted; elapsed and age tick). */
  function renderStats(): void {
    const snapshot = store.getState().snapshot;
    const { selectedId } = selection.get();
    const view = snapshot?.runners.find((r) => r.runnerId === selectedId);
    if (!snapshot || !view) {
      detail.hidden = true;
      return;
    }
    const text = selectedPanelText(view, displayName(snapshot, view.runnerId), store.now());
    detail.hidden = false;
    detailTitle.textContent = text.title;
    detailNote.hidden = !text.notStarted;
    // Rebuilt on every render: the block holds no controls, so no tap can be lost.
    const cells: HTMLElement[] = [];
    for (const [label, value] of text.rows) {
      const dt = el('dt');
      const dd = el('dd');
      dt.textContent = label;
      dd.textContent = value;
      cells.push(dt, dd);
    }
    detailStats.replaceChildren(...cells);
  }

  function renderDetail(): void {
    const { selectedId } = selection.get();
    allButton.setAttribute('aria-pressed', String(selectedId === null));
    allButton.classList.toggle('selected', selectedId === null);
    renderStats();
    for (const [id, row] of rows) {
      const isSelected = id === selectedId;
      row.button.classList.toggle('selected', isSelected);
      row.button.setAttribute('aria-pressed', String(isSelected));
    }
  }

  function render(snapshot: Snapshot): void {
    title.textContent = snapshot.event.name;
    const seen = new Set<string>();
    snapshot.runners.forEach((view, index) => {
      seen.add(view.runnerId);
      let row = rows.get(view.runnerId);
      if (!row) {
        row = createRow(view.runnerId);
        rows.set(view.runnerId, row);
      }
      const config = snapshot.event.runners.find((r) => r.runnerId === view.runnerId);
      row.swatch.style.background = config?.color ?? FALLBACK_COLOR;
      row.name.textContent = displayName(snapshot, view.runnerId);
      row.status.textContent = statusLabel(view.status);
      const stats = runnerStatsText(view, store.now());
      row.distance.textContent = stats.distance;
      row.currentPace.textContent = stats.currentPace;
      row.avgPace.textContent = stats.avgPace;
      // Keep the DOM order equal to the snapshot order, moving rows only when needed.
      const current = list.children[index] ?? null;
      if (current !== row.item) list.insertBefore(row.item, current);
    });
    for (const [id, row] of rows) {
      if (!seen.has(id)) {
        row.item.remove();
        rows.delete(id);
      }
    }
    renderTicking();
    renderDetail();
  }

  store.subscribe(({ snapshot }) => {
    if (snapshot) render(snapshot);
  });
  selection.subscribe(renderDetail);
  renderDetail();
  setInterval(() => {
    renderTicking();
    renderStats();
  }, TICK_MS);

  return {
    setConnection(status) {
      banner.hidden = status === 'open';
      banner.textContent = status === 'connecting' ? 'connecting…' : 'reconnecting…';
    },
  };
}
