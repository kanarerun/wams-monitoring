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

test('a student entering right after go-live gets the full duration', () => {
  const exam = {
    status: 'live',
    schedule: new Date(scheduledStart).toISOString(),
    live_started_at: new Date(scheduledStart).toISOString(),
    time_limit: 45
  };
  // Went live 2 minutes ago, student entered now: full 45 minutes, not 43.
  const enteredAt = new Date(scheduledStart + 2 * 60 * 1000).toISOString();
  assert.equal(getRemainingExamSeconds(exam, scheduledStart + 2 * 60 * 1000, enteredAt), 45 * 60);
  // Re-entering 10 minutes into their own session: 35 minutes left.
  const enteredMs = scheduledStart + 2 * 60 * 1000;
  assert.equal(getRemainingExamSeconds(exam, enteredMs + 10 * 60 * 1000, enteredAt), 35 * 60);
});

test('a stated live_started_at in the future cannot eat the countdown', () => {
  const exam = {
    status: 'live',
    schedule: new Date(scheduledStart).toISOString(),
    live_started_at: new Date(scheduledStart + 60 * 60 * 1000).toISOString(),
    time_limit: 45
  };
  assert.equal(getRemainingExamSeconds(exam, scheduledStart), 45 * 60);
});
