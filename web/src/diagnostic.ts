// Story 1.2 diagnostic page: proves the SSE stream survives the path to a
// phone (Tailscale Funnel, mobile data). Kept at /diagnostic.html (Story 1.6) for the Story 4.3 soak test.
// EventSource never exposes `: ping` comments, so a second fetch-based reader
// on the same URL logs every frame with its arrival time and gap.
import type { Snapshot } from '@running-live-tracker/shared';
import { createFrameSplitter } from './sse-frames.ts';

const LIVE_URL = '/api/v1/live';
const RECONNECT_DELAY_MS = 3_000;
const SLOW_GAP_MS = 25_000; // pings every 20 s; anything slower is flagged
const MAX_LOG_LINES = 200;

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
};

function setText(id: string, text: string | number, cls?: 'ok' | 'bad'): void {
  const el = $(id);
  el.textContent = String(text);
  el.className = cls ?? '';
}

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour12: false });
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
function duration(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
}

function log(text: string, slow = false): void {
  const list = $('log');
  const li = document.createElement('li');
  li.textContent = text;
  if (slow) li.className = 'slow';
  list.prepend(li);
  while (list.children.length > MAX_LOG_LINES) list.lastElementChild?.remove();
}

// ---- EventSource: open/error counts and snapshot arrival ----

let esOpens = 0;
let esErrors = 0;
let esSnapshots = 0;
const source = new EventSource(LIVE_URL);
source.addEventListener('open', () => {
  setText('es-opens', ++esOpens);
  setText('es-state', 'open', 'ok');
});
source.addEventListener('error', () => {
  setText('es-errors', ++esErrors, 'bad');
  setText('es-state', source.readyState === EventSource.CLOSED ? 'closed' : 'reconnecting', 'bad');
});
source.addEventListener('snapshot', (e) => {
  const snap = JSON.parse((e as MessageEvent<string>).data) as Snapshot;
  setText('es-snapshots', ++esSnapshots);
  setText('es-last', `${clock(Date.now())} (${snap.runners.length} runners)`);
});

// ---- Raw fetch reader: every frame, pings included ----

let connectedAt: number | null = null;
let lastFrameAt: number | null = null;
let pings = 0;
let maxGap = 0;
let reconnects = 0;

function onFrame(label: string): void {
  const now = Date.now();
  const gap = lastFrameAt === null ? null : now - lastFrameAt;
  lastFrameAt = now;
  if (gap !== null && gap > maxGap) {
    maxGap = gap;
    setText('raw-maxgap', secs(maxGap), maxGap > SLOW_GAP_MS ? 'bad' : undefined);
  }
  const slow = gap !== null && gap > SLOW_GAP_MS;
  log(`${clock(now)}  ${label}${gap === null ? '' : `  +${secs(gap)}`}`, slow);
}

async function readStream(): Promise<void> {
  setText('raw-state', 'connecting');
  const res = await fetch(LIVE_URL, { cache: 'no-store' });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  connectedAt = Date.now();
  lastFrameAt = null;
  setText('raw-state', 'open', 'ok');
  log(`${clock(connectedAt)}  connected (content-type: ${res.headers.get('content-type')})`);
  const push = createFrameSplitter();
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  try {
    await readFrames(reader, push);
  } finally {
    // Release the old connection before runRawReader opens a new one.
    void reader.cancel().catch(() => {});
  }
}

async function readFrames(
  reader: ReadableStreamDefaultReader<string>,
  push: ReturnType<typeof createFrameSplitter>,
): Promise<void> {
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error('stream ended by server');
    for (const frame of push(value)) {
      if (frame.kind === 'comment') {
        setText('raw-pings', ++pings);
        onFrame(`: ${frame.text}`);
      } else if (frame.event === 'snapshot') {
        const snap = JSON.parse(frame.data) as Snapshot;
        setText('raw-event', `${snap.event.name} (${snap.event.eventId})`);
        setText('raw-runners', snap.runners.map((r) => `${r.runnerId}: ${r.status}`).join(', ') || 'none');
        onFrame(`snapshot, ${snap.runners.length} runners, serverNow ${clock(snap.serverNow)}`);
      } else {
        onFrame(`event ${frame.event}`);
      }
    }
  }
}

async function runRawReader(): Promise<void> {
  for (;;) {
    try {
      await readStream();
    } catch (err) {
      const lasted = connectedAt === null ? '' : ` after ${duration(Date.now() - connectedAt)}`;
      log(`${clock(Date.now())}  disconnected${lasted}: ${(err as Error).message}`, true);
      connectedAt = null;
      setText('raw-state', 'disconnected, retrying', 'bad');
    }
    await new Promise((r) => setTimeout(r, RECONNECT_DELAY_MS));
    setText('raw-reconnects', ++reconnects, 'bad');
  }
}

setInterval(() => {
  setText('raw-elapsed', connectedAt === null ? '-' : duration(Date.now() - connectedAt));
}, 1_000);

void runRawReader();
