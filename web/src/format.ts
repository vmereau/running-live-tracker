// Display formatting for the map page. Ages and elapsed time are the only derived
// numbers the page computes (AD-2); distance, paces and course progress come from
// the server as-is.
import type { RunnerStatus, RunnerView } from '@running-live-tracker/shared';

const EM_DASH = '—';

/** Age of the last received record, never negative; null when nothing was received yet. */
export function ageMs(lastReceivedAt: number | null, now: number): number | null {
  if (lastReceivedAt === null) return null;
  return Math.max(0, now - lastReceivedAt);
}

/** "last update N s ago" text body: seconds below one minute, floored minutes from there on. */
export function formatAge(age: number | null): string {
  if (age === null) return 'no data yet';
  const ms = Math.max(0, age);
  if (ms < 60_000) return `${Math.floor(ms / 1000)} s ago`;
  return `${Math.floor(ms / 60_000)} min ago`;
}

const STATUS_LABELS: Record<RunnerStatus, string> = {
  notStarted: 'not started',
  active: 'running',
  stopped: 'stopped',
};

export function statusLabel(status: RunnerStatus): string {
  return STATUS_LABELS[status];
}

/** (runEndedAt ?? now) − runStartedAt, never negative; null before the run started. */
export function elapsedMs(view: Pick<RunnerView, 'runStartedAt' | 'runEndedAt'>, now: number): number | null {
  if (view.runStartedAt === null) return null;
  return Math.max(0, (view.runEndedAt ?? now) - view.runStartedAt);
}

/** h:mm:ss (floored seconds); "—" for null. */
export function formatElapsed(ms: number | null): string {
  if (ms === null) return EM_DASH;
  const total = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Kilometres with one decimal: 1234 → "1.2 km". */
export function formatDistanceKm(distanceM: number): string {
  return `${(distanceM / 1000).toFixed(1)} km`;
}

/** m:ss /km, rounded to the nearest second (299.6 → "5:00 /km"); "—" for null. */
export function formatPace(sPerKm: number | null): string {
  if (sPerKm === null || !Number.isFinite(sPerKm)) return EM_DASH;
  const total = Math.round(sPerKm);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')} /km`;
}

export type RunnerStatsText = { elapsed: string; distance: string; currentPace: string; avgPace: string };

/** The stats line of one runner row: server values formatted, elapsed measured against `now`. */
export function runnerStatsText(
  view: Pick<RunnerView, 'runStartedAt' | 'runEndedAt' | 'distanceM' | 'currentPaceSPerKm' | 'avgPaceSPerKm'>,
  now: number,
): RunnerStatsText {
  return {
    elapsed: formatElapsed(elapsedMs(view, now)),
    distance: formatDistanceKm(view.distanceM),
    currentPace: formatPace(view.currentPaceSPerKm),
    avgPace: formatPace(view.avgPaceSPerKm),
  };
}

export type ProgressText = {
  /** "X.X / Y.Y km": progress floored to 0.1 km, so it never reads as done before the finish. */
  done: string;
  /** "Z.Z km", rounded up to 0.1 km: 40 m left reads "0.1 km". */
  remaining: string;
  /** "N %", floored. */
  percent: string;
};

type ProgressFields = Pick<RunnerView, 'progressM' | 'remainingM' | 'progressFraction'>;

/** The server's course progress formatted; null without a course (`lengthM` null) or without progress. */
export function progressText(view: ProgressFields, lengthM: number | null): ProgressText | null {
  if (lengthM === null || view.progressM === null || view.remainingM === null || view.progressFraction === null) return null;
  const totalKm = (lengthM / 1000).toFixed(1);
  // At the finish the done figure is the total; before it, floored so it never reads as done.
  const doneKm = view.progressM >= lengthM ? totalKm : (Math.floor(view.progressM / 100) / 10).toFixed(1);
  return {
    done: `${doneKm} / ${totalKm} km`,
    remaining: `${(Math.ceil(view.remainingM / 100 - 1e-9) / 10).toFixed(1)} km`,
    percent: `${Math.floor(view.progressFraction * 100 + 1e-9)} %`,
  };
}

export type RunnerRowText = {
  /** "X.X / Y.Y km" with progress, else the distance "X.X km". */
  distance: string;
  /** Tooltip of the distance slot. */
  distanceTitle: string;
  /** The row's progress line; null hides it. */
  progress: ProgressText | null;
  /** Shows the "off course" badge: only alongside progress. */
  offCourse: boolean;
};

/** The course-dependent part of a runner row; `lengthM` is snapshot.event.lengthM. */
export function runnerRowText(
  view: ProgressFields & Pick<RunnerView, 'runStartedAt' | 'runEndedAt' | 'distanceM' | 'currentPaceSPerKm' | 'avgPaceSPerKm' | 'offCourse'>,
  lengthM: number | null,
  now: number,
): RunnerRowText {
  const progress = progressText(view, lengthM);
  return {
    distance: progress?.done ?? runnerStatsText(view, now).distance,
    distanceTitle: progress ? 'distance on course / course length' : 'distance',
    progress,
    offCourse: progress !== null && view.offCourse,
  };
}

export type SelectedPanelText = {
  /** "Name · status". */
  title: string;
  /** True while the runner has not started: the panel says so instead of showing run stats. */
  notStarted: boolean;
  /** Shows the "off course" badge: only alongside progress. */
  offCourse: boolean;
  /** Label/value pairs in display order. Elapsed and last update move with `now`. */
  rows: [label: string, value: string][];
};

/**
 * The stats block of the selected runner: server values formatted, elapsed and age
 * measured against `now`. With progress (`lengthM` is snapshot.event.lengthM), the
 * distance reads "X.X / Y.Y km" and Remaining and Complete rows follow it.
 */
export function selectedPanelText(view: RunnerView, name: string, lengthM: number | null, now: number): SelectedPanelText {
  const title = `${name} · ${statusLabel(view.status)}`;
  const age = ageMs(view.lastReceivedAt, now);
  const lastUpdate: [string, string] = ['Last update', formatAge(age)];
  if (view.status === 'notStarted') return { title, notStarted: true, offCourse: false, rows: [lastUpdate] };
  const stats = runnerStatsText(view, now);
  const progress = progressText(view, lengthM);
  const distanceRows: [string, string][] = progress
    ? [
        ['Distance', progress.done],
        ['Remaining', progress.remaining],
        ['Complete', progress.percent],
      ]
    : [['Distance', stats.distance]];
  return {
    title,
    notStarted: false,
    offCourse: progress !== null && view.offCourse,
    rows: [
      ['Elapsed', stats.elapsed],
      ...distanceRows,
      ['Current pace', stats.currentPace],
      ['Average pace', stats.avgPace],
      lastUpdate,
    ],
  };
}
