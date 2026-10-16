export function computeEffectiveStatus(exam, now = Date.now()){
  if(exam.status === 'ended') return 'ended';

  if(exam.status === 'scheduled'){
    const scheduledStart = exam.schedule ? new Date(exam.schedule).getTime() : NaN;
    return Number.isFinite(scheduledStart) && scheduledStart <= now ? 'live' : 'scheduled';
  }

  if(exam.status !== 'live') return 'scheduled';

  const startValue = exam.live_started_at || exam.schedule;
  const startMs = startValue ? new Date(startValue).getTime() : NaN;
  const durationMs = (Number(exam.time_limit) || 60) * 60000;
  if(Number.isFinite(startMs) && now >= startMs + durationMs) return 'ended';
  return 'live';
}

export function getRemainingExamSeconds(exam, now = Date.now()){
  const durationSeconds = Math.max(0, (Number(exam.time_limit) || 60) * 60);
  if(exam.status === 'ended') return 0;
  const startValue = exam.live_started_at || exam.schedule;
  if(exam.status !== 'live' || !startValue) return durationSeconds;

  const startMs = new Date(startValue).getTime();
  if(!Number.isFinite(startMs) || startMs > now) return durationSeconds;
  return Math.max(0, Math.ceil((startMs + durationSeconds * 1000 - now) / 1000));
}
