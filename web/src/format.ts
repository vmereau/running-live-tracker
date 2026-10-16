// Display formatting for the map page. Ages are the only derived numbers the
// page computes (AD-2); everything else comes from the server as-is.
import type { RunnerStatus } from '@running-live-tracker/shared';

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
