/* SQLite stores DATETIME as "YYYY-MM-DD HH:MM:SS" in UTC. `new Date(value)` reads
   that as *local* time, which shifted countdowns by the server's UTC offset
   (e.g. a fresh 45-minute exam opening with ~2-3 minutes left in Manila). Every
   timestamp below goes through this parser. */
export function toTimestamp(value) {
  if (!value) return NaN;
  if (value instanceof Date) return value.getTime();
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(text)) {
    return new Date(text.replace(' ', 'T') + 'Z').getTime();
  }
  return new Date(text).getTime();
}

/* Start of the exam window. Only timestamps at/after the scheduled start count:
   an exam created (or published) a week early used to start counting down from
   that moment, so students entered a 45-minute exam with 42 minutes left. */
function examWindowStart(exam, parse) {
  const scheduleMs = parse(exam.schedule);
  const liveMs = parse(exam.live_started_at);
  if (Number.isFinite(liveMs) && (!Number.isFinite(scheduleMs) || liveMs >= scheduleMs)) return liveMs;
  if (Number.isFinite(scheduleMs)) return scheduleMs;
  if (Number.isFinite(liveMs)) return liveMs;
  return NaN;
}

export function computeEffectiveStatus(exam, now = Date.now(), parse = toTimestamp) {
  if (exam.status === 'ended') return 'ended';

  const startMs = examWindowStart(exam, parse);
  const isLive = exam.status === 'live' ||
    (exam.status === 'scheduled' && Number.isFinite(startMs) && startMs <= now);
  if (!isLive) return 'scheduled';

  // Exam is live: it ends once the window is over. An exam with no usable start
  // timestamp (started manually without a schedule) has no fixed end.
  const durationMs = (Number(exam.time_limit) || 60) * 60000;
  if (Number.isFinite(startMs) && now >= startMs + durationMs) return 'ended';
  return 'live';
}

/* Timestamp (ms) the exam window started counting from, or NaN when there is no
   usable start yet. */
export function getExamStartMs(exam, parse = toTimestamp) {
  return examWindowStart(exam, parse);
}

/* Remaining time for one student. A student's session is their own timer: full
   duration from the moment they entered. The exam window is only the fallback
   for entries recorded before sessions were stamped, so the class still ends
   together. */
export function getRemainingExamSeconds(exam, now = Date.now(), sessionStartedAt = null, parse = toTimestamp) {
  const durationSeconds = Math.max(0, (Number(exam.time_limit) || 60) * 60);
  if (exam.status === 'ended') return 0;
  if (exam.status !== 'live') return durationSeconds;

  const sessionMs = parse(sessionStartedAt);
  if (Number.isFinite(sessionMs)) {
    return Math.max(0, Math.ceil((sessionMs + durationSeconds * 1000 - now) / 1000));
  }

  const startMs = examWindowStart(exam, parse);
  if (!Number.isFinite(startMs) || startMs > now) return durationSeconds;
  return Math.max(0, Math.ceil((startMs + durationSeconds * 1000 - now) / 1000));
}
