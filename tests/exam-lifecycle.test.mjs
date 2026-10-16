import test from 'node:test';
import assert from 'node:assert/strict';
import { computeEffectiveStatus, getRemainingExamSeconds } from '../server/exam-lifecycle.js';

const scheduledStart = Date.parse('2026-10-16T08:00:00.000Z');

test('scheduled exam stays closed before its scheduled start', () => {
  const exam = {
    status: 'scheduled',
    schedule: new Date(scheduledStart).toISOString(),
    time_limit: 30
  };

  assert.equal(computeEffectiveStatus(exam, scheduledStart - 1), 'scheduled');
  assert.equal(computeEffectiveStatus(exam, scheduledStart), 'live');
});

test('scheduled exam ends when its configured duration from schedule expires', () => {
  const exam = {
    status: 'live',
    schedule: new Date(scheduledStart).toISOString(),
    live_started_at: new Date(scheduledStart).toISOString(),
    time_limit: 30
  };

  assert.equal(computeEffectiveStatus(exam, scheduledStart + 30 * 60 * 1000 - 1), 'live');
  assert.equal(computeEffectiveStatus(exam, scheduledStart + 30 * 60 * 1000), 'ended');
});

test('manual live start anchors the duration independently from the schedule', () => {
  const manualStart = scheduledStart + 60 * 60 * 1000;
  const exam = {
    status: 'live',
    schedule: new Date(scheduledStart).toISOString(),
    live_started_at: new Date(manualStart).toISOString(),
    time_limit: 30
  };

  assert.equal(computeEffectiveStatus(exam, manualStart + 30 * 60 * 1000), 'ended');
});

test('late entry receives only the time remaining until exam end', () => {
  const exam = {
    status: 'live',
    schedule: new Date(scheduledStart).toISOString(),
    live_started_at: new Date(scheduledStart).toISOString(),
    time_limit: 30
  };

  assert.equal(getRemainingExamSeconds(exam, scheduledStart + 10 * 60 * 1000), 20 * 60);
  assert.equal(getRemainingExamSeconds({ ...exam, status: 'ended' }, scheduledStart), 0);
});
