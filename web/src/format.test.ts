import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RunnerView } from '@running-live-tracker/shared';
import { ageMs, elapsedMs, formatAge, formatDistanceKm, formatElapsed, formatPace, runnerStatsText, selectedPanelText, statusLabel } from './format.ts';

test('formats ages as seconds below a minute and floored minutes above', () => {
  assert.equal(formatAge(0), '0 s ago');
  assert.equal(formatAge(59_999), '59 s ago');
  assert.equal(formatAge(60_000), '1 min ago');
  assert.equal(formatAge(119_999), '1 min ago');
  assert.equal(formatAge(3_600_000), '60 min ago');
});

test('no received data reads "no data yet"', () => {
  assert.equal(ageMs(null, 1000), null);
  assert.equal(formatAge(null), 'no data yet');
});

test('age is measured against the given (server-aligned) now and never negative', () => {
  assert.equal(ageMs(1000, 6000), 5000);
  assert.equal(ageMs(9000, 6000), 0);
  assert.equal(formatAge(ageMs(9000, 6000)), '0 s ago');
});

test('status labels', () => {
  assert.equal(statusLabel('notStarted'), 'not started');
  assert.equal(statusLabel('active'), 'running');
  assert.equal(statusLabel('stopped'), 'stopped');
});

test('elapsed: null before the start, ticks with now, frozen at runEndedAt, never negative', () => {
  assert.equal(elapsedMs({ runStartedAt: null, runEndedAt: null }, 5_000), null);
  assert.equal(elapsedMs({ runStartedAt: 1_000, runEndedAt: null }, 5_000), 4_000);
  assert.equal(elapsedMs({ runStartedAt: 1_000, runEndedAt: null }, 6_000), 5_000);
  assert.equal(elapsedMs({ runStartedAt: 1_000, runEndedAt: 3_000 }, 99_000), 2_000);
  assert.equal(elapsedMs({ runStartedAt: 9_000, runEndedAt: null }, 5_000), 0);
});

test('formatElapsed: h:mm:ss, floored, "—" for null', () => {
  assert.equal(formatElapsed(null), '—');
  assert.equal(formatElapsed(0), '0:00:00');
  assert.equal(formatElapsed(59_999), '0:00:59');
  assert.equal(formatElapsed(61_000), '0:01:01');
  assert.equal(formatElapsed(3_600_000 + 2 * 60_000 + 3_000), '1:02:03');
  assert.equal(formatElapsed(36_000_000), '10:00:00');
});

test('formatDistanceKm: one decimal', () => {
  assert.equal(formatDistanceKm(0), '0.0 km');
  assert.equal(formatDistanceKm(1_234), '1.2 km');
  assert.equal(formatDistanceKm(9_960), '10.0 km');
  assert.equal(formatDistanceKm(42_195), '42.2 km');
});

test('formatPace: m:ss /km rounded to the nearest second with carry, "—" for null', () => {
  assert.equal(formatPace(null), '—');
  assert.equal(formatPace(300), '5:00 /km');
  assert.equal(formatPace(299.6), '5:00 /km');
  assert.equal(formatPace(299.4), '4:59 /km');
  assert.equal(formatPace(59.5), '1:00 /km');
  assert.equal(formatPace(302), '5:02 /km');
  assert.equal(formatPace(725), '12:05 /km');
});

test('runnerStatsText: each server value lands in its own slot; elapsed ticks while active, frozen when stopped', () => {
  const active = { runStartedAt: 1_000, runEndedAt: null, distanceM: 2_345, currentPaceSPerKm: 298, avgPaceSPerKm: 302 };
  assert.deepStrictEqual(runnerStatsText(active, 61_000), { elapsed: '0:01:00', distance: '2.3 km', currentPace: '4:58 /km', avgPace: '5:02 /km' });
  assert.equal(runnerStatsText(active, 62_000).elapsed, '0:01:01');

  const stopped = { ...active, runEndedAt: 31_000, currentPaceSPerKm: null };
  assert.equal(runnerStatsText(stopped, 61_000).elapsed, '0:00:30');
  assert.equal(runnerStatsText(stopped, 99_000).elapsed, '0:00:30');
  assert.equal(runnerStatsText(stopped, 99_000).currentPace, '—');
  assert.equal(runnerStatsText(stopped, 99_000).avgPace, '5:02 /km');

  const notStarted = { runStartedAt: null, runEndedAt: null, distanceM: 0, currentPaceSPerKm: null, avgPaceSPerKm: null };
  assert.deepStrictEqual(runnerStatsText(notStarted, 5_000), { elapsed: '—', distance: '0.0 km', currentPace: '—', avgPace: '—' });
});

function runnerView(overrides: Partial<RunnerView>): RunnerView {
  return {
    runnerId: 'r1',
    status: 'active',
    runStartedAt: 1_000,
    runEndedAt: null,
    lastFixAt: 60_000,
    lastReceivedAt: 60_000,
    lastPosition: { lat: 48.85, lon: 2.35 },
    distanceM: 2_345,
    progressM: null,
    remainingM: null,
    progressFraction: null,
    offCourse: false,
    avgPaceSPerKm: 302,
    currentPaceSPerKm: 298,
    etaAt: null,
    ...overrides,
  };
}

test('selectedPanelText: active runner shows every stat, elapsed and age tick with now', () => {
  const view = runnerView({});
  assert.deepStrictEqual(selectedPanelText(view, 'Alice', 61_000), {
    title: 'Alice · running',
    notStarted: false,
    rows: [
      ['Elapsed', '0:01:00'],
      ['Distance', '2.3 km'],
      ['Current pace', '4:58 /km'],
      ['Average pace', '5:02 /km'],
      ['Last update', '1 s ago'],
    ],
  });
  const later = selectedPanelText(view, 'Alice', 71_000).rows;
  assert.deepStrictEqual(later[0], ['Elapsed', '0:01:10']);
  assert.deepStrictEqual(later[4], ['Last update', '11 s ago']);
});

test('selectedPanelText: notStarted runner says so and shows only the last update', () => {
  const view = runnerView({
    status: 'notStarted', runStartedAt: null, lastFixAt: null, lastReceivedAt: null, lastPosition: null,
    distanceM: 0, avgPaceSPerKm: null, currentPaceSPerKm: null,
  });
  assert.deepStrictEqual(selectedPanelText(view, 'Bob', 5_000), {
    title: 'Bob · not started',
    notStarted: true,
    rows: [['Last update', 'no data yet']],
  });
});

test('selectedPanelText: stopped runner shows the final elapsed time and no current pace', () => {
  const view = runnerView({ status: 'stopped', runEndedAt: 31_000, currentPaceSPerKm: null });
  const text = selectedPanelText(view, 'Carol', 999_000);
  assert.equal(text.title, 'Carol · stopped');
  assert.equal(text.notStarted, false);
  assert.deepStrictEqual(text.rows.slice(0, 4), [
    ['Elapsed', '0:00:30'],
    ['Distance', '2.3 km'],
    ['Current pace', '—'],
    ['Average pace', '5:02 /km'],
  ]);
});
