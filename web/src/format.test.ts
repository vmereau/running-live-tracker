import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RunnerView } from '@running-live-tracker/shared';
import { ageMs, elapsedMs, etaText, formatAge, formatClock, formatDistanceKm, formatElapsed, formatPace, progressText, runnerRowText, runnerStatsText, selectedPanelText, statusLabel } from './format.ts';

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
  assert.deepStrictEqual(selectedPanelText(view, 'Alice', null, 61_000), {
    title: 'Alice · running',
    notStarted: false,
    offCourse: false,
    rows: [
      ['Elapsed', '0:01:00'],
      ['Distance', '2.3 km'],
      ['Current pace', '4:58 /km'],
      ['Average pace', '5:02 /km'],
      ['Last update', '1 s ago'],
    ],
  });
  const later = selectedPanelText(view, 'Alice', null, 71_000).rows;
  assert.deepStrictEqual(later[0], ['Elapsed', '0:01:10']);
  assert.deepStrictEqual(later[4], ['Last update', '11 s ago']);
});

test('selectedPanelText: notStarted runner says so and shows only the last update', () => {
  const view = runnerView({
    status: 'notStarted', runStartedAt: null, lastFixAt: null, lastReceivedAt: null, lastPosition: null,
    distanceM: 0, avgPaceSPerKm: null, currentPaceSPerKm: null,
  });
  assert.deepStrictEqual(selectedPanelText(view, 'Bob', null, 5_000), {
    title: 'Bob · not started',
    notStarted: true,
    offCourse: false,
    rows: [['Last update', 'no data yet']],
  });
});

test('selectedPanelText: stopped runner shows the final time and no current pace', () => {
  const view = runnerView({ status: 'stopped', runEndedAt: 31_000, currentPaceSPerKm: null });
  const text = selectedPanelText(view, 'Carol', null, 999_000);
  assert.equal(text.title, 'Carol · stopped');
  assert.equal(text.notStarted, false);
  assert.deepStrictEqual(text.rows.slice(0, 4), [
    ['Final time', '0:00:30'],
    ['Distance', '2.3 km'],
    ['Current pace', '—'],
    ['Average pace', '5:02 /km'],
  ]);
});

// ---- course progress (Story 3.4) ----

const onCourse = { progressM: 4_567, remainingM: 5_433, progressFraction: 0.4567, distanceM: 4_567 };

test('progressText: done floored to 0.1 km, remaining rounded up to 0.1 km, percent floored', () => {
  assert.deepStrictEqual(progressText(onCourse, 10_000), { done: '4.5 / 10.0 km', remaining: '5.5 km', percent: '45 %' });
  // Never "10.0 / 10.0 km" next to "99 %".
  assert.deepStrictEqual(progressText({ progressM: 9_960, remainingM: 40, progressFraction: 0.996 }, 10_000), {
    done: '9.9 / 10.0 km',
    remaining: '0.1 km',
    percent: '99 %',
  });
  // At the finish of a course whose length is not a multiple of 100 m, done reads the total.
  assert.deepStrictEqual(progressText({ progressM: 2_270.39, remainingM: 0, progressFraction: 1 }, 2_270.39), {
    done: '2.3 / 2.3 km',
    remaining: '0.0 km',
    percent: '100 %',
  });
  // 0.57 * 100 is 56.99999… in floating point: still "57 %".
  assert.equal(progressText({ progressM: 5_700, remainingM: 4_300, progressFraction: 0.57 }, 10_000)!.percent, '57 %');
  assert.deepStrictEqual(progressText({ progressM: 10_000, remainingM: 0, progressFraction: 1 }, 10_000), {
    done: '10.0 / 10.0 km',
    remaining: '0.0 km',
    percent: '100 %',
  });
  assert.deepStrictEqual(progressText({ progressM: 0, remainingM: 2_270, progressFraction: 0 }, 2_270), { done: '0.0 / 2.3 km', remaining: '2.3 km', percent: '0 %' });
});

test('progressText: null without a course or with any progress field null', () => {
  assert.equal(progressText(onCourse, null), null);
  assert.equal(progressText({ ...onCourse, progressM: null }, 10_000), null);
  assert.equal(progressText({ ...onCourse, remainingM: null }, 10_000), null);
  assert.equal(progressText({ ...onCourse, progressFraction: null }, 10_000), null);
});

test('runnerRowText: with a course the distance reads done / total, plus the progress line and badge', () => {
  const view = runnerView(onCourse);
  assert.deepStrictEqual(runnerRowText(view, 10_000, 61_000), {
    distance: '4.5 / 10.0 km',
    distanceTitle: 'distance on course / course length',
    progress: { done: '4.5 / 10.0 km', remaining: '5.5 km', percent: '45 %' },
    offCourse: false,
    eta: null,
  });
  assert.equal(runnerRowText(runnerView({ ...onCourse, offCourse: true }), 10_000, 61_000).offCourse, true);
});

test('runnerRowText: without a course, or without progress yet, only the distance and no badge', () => {
  const plain = { distance: '2.3 km', distanceTitle: 'distance', progress: null, offCourse: false, eta: null };
  assert.deepStrictEqual(runnerRowText(runnerView({}), null, 61_000), plain);
  assert.deepStrictEqual(runnerRowText(runnerView({ offCourse: true }), null, 61_000), plain);
  // Course, but no progress (not started): nothing shown as 0.
  const notStarted = runnerView({ status: 'notStarted', runStartedAt: null, distanceM: 0, offCourse: true });
  assert.deepStrictEqual(runnerRowText(notStarted, 10_000, 61_000), { ...plain, distance: '0.0 km' });
});

test('selectedPanelText: with progress, Distance done / total, then Remaining and Complete; badge while off course', () => {
  const text = selectedPanelText(runnerView(onCourse), 'Alice', 10_000, 61_000);
  assert.equal(text.offCourse, false);
  assert.deepStrictEqual(text.rows, [
    ['Elapsed', '0:01:00'],
    ['Distance', '4.5 / 10.0 km'],
    ['Remaining', '5.5 km'],
    ['Complete', '45 %'],
    ['Current pace', '4:58 /km'],
    ['Average pace', '5:02 /km'],
    ['Last update', '1 s ago'],
  ]);
  assert.equal(selectedPanelText(runnerView({ ...onCourse, offCourse: true }), 'Alice', 10_000, 61_000).offCourse, true);
});

test('selectedPanelText: without a course or progress, no progress rows and no badge', () => {
  const text = selectedPanelText(runnerView({ offCourse: true }), 'Alice', null, 61_000);
  assert.equal(text.offCourse, false);
  assert.deepStrictEqual(text.rows.map(([label]) => label), ['Elapsed', 'Distance', 'Current pace', 'Average pace', 'Last update']);
  const noProgress = selectedPanelText(runnerView({ offCourse: true }), 'Alice', 10_000, 61_000);
  assert.equal(noProgress.offCourse, false);
  assert.deepStrictEqual(noProgress.rows[1], ['Distance', '2.3 km']);
});

// ---- estimated finish time (Story 3.5) ----

// Local times: the page shows the browser's clock, so the expectations use it too.
const etaAt = new Date(2026, 9, 21, 12, 41, 40).getTime();
const startedAt = etaAt - (3 * 3600 + 28 * 60 + 15) * 1000;
const withEta = { ...onCourse, etaAt, runStartedAt: startedAt, lastFixAt: startedAt + 1_200_000, lastReceivedAt: startedAt + 1_200_000 };

test('formatClock: local HH:mm rounded to the nearest minute', () => {
  assert.equal(formatClock(new Date(2026, 9, 21, 12, 41, 0).getTime()), '12:41');
  assert.equal(formatClock(new Date(2026, 9, 21, 12, 41, 29).getTime()), '12:41');
  assert.equal(formatClock(new Date(2026, 9, 21, 12, 41, 30).getTime()), '12:42');
  assert.equal(formatClock(new Date(2026, 9, 21, 9, 5, 10).getTime()), '09:05');
  assert.equal(formatClock(new Date(2026, 9, 21, 23, 59, 40).getTime()), '00:00');
});

test('etaText: clock and projected time; null without etaAt, without runStartedAt, or unless active', () => {
  assert.deepStrictEqual(etaText(runnerView(withEta)), { clock: '12:42', projected: '3:28:15' });
  assert.equal(etaText(runnerView({ ...withEta, etaAt: null })), null);
  assert.equal(etaText(runnerView({ ...withEta, runStartedAt: null })), null);
  assert.equal(etaText(runnerView({ ...withEta, status: 'stopped' })), null);
  assert.equal(etaText(runnerView({ ...withEta, status: 'notStarted' })), null);
});

test('runnerRowText: "finish ≈ HH:mm" with an ETA, null without', () => {
  assert.equal(runnerRowText(runnerView(withEta), 10_000, startedAt + 1_200_000).eta, 'finish ≈ 12:42');
  assert.equal(runnerRowText(runnerView({ ...withEta, etaAt: null }), 10_000, startedAt + 1_200_000).eta, null);
  assert.equal(runnerRowText(runnerView({ ...withEta, status: 'stopped', runEndedAt: startedAt + 1_200_000 }), 10_000, startedAt + 1_200_000).eta, null);
});

test('selectedPanelText: Finish ≈ and Projected time after Complete; hidden without an ETA', () => {
  const text = selectedPanelText(runnerView(withEta), 'Alice', 10_000, startedAt + 1_201_000);
  assert.deepStrictEqual(text.rows, [
    ['Elapsed', '0:20:01'],
    ['Distance', '4.5 / 10.0 km'],
    ['Remaining', '5.5 km'],
    ['Complete', '45 %'],
    ['Finish ≈', '12:42'],
    ['Projected time', '3:28:15'],
    ['Current pace', '4:58 /km'],
    ['Average pace', '5:02 /km'],
    ['Last update', '1 s ago'],
  ]);
  const noEta = selectedPanelText(runnerView({ ...withEta, etaAt: null }), 'Alice', 10_000, startedAt + 1_201_000);
  assert.deepStrictEqual(noEta.rows.map(([label]) => label), ['Elapsed', 'Distance', 'Remaining', 'Complete', 'Current pace', 'Average pace', 'Last update']);
});

test('selectedPanelText: a stopped runner reads Final time, with no ETA rows', () => {
  const stopped = runnerView({ ...withEta, status: 'stopped', etaAt: null, runEndedAt: startedAt + 1_200_000, currentPaceSPerKm: null });
  const labels = selectedPanelText(stopped, 'Alice', 10_000, startedAt + 9_999_000).rows.map(([label]) => label);
  assert.deepStrictEqual(labels, ['Final time', 'Distance', 'Remaining', 'Complete', 'Current pace', 'Average pace', 'Last update']);
});
