const TRANSIENT_ERROR_CODES = new Set([
  'SQLITE_BUSY',
  'SQLITE_LOCKED',
  'SQLITE_IOERR',
  'SQLITE_PROTOCOL',
  'HRANA_WEBSOCKET_ERROR',
  'HRANA_WEBSOCKET_CLOSED'
]);

export function isTransientDatabaseError(error) {
  const code = String(error && (error.code || error.cause?.code) || '').toUpperCase();
  if (TRANSIENT_ERROR_CODES.has(code)) return true;
  const message = String(error && error.message || '').toLowerCase();
  return /database is locked|database is busy|temporar(?:y|ily)|connection reset|socket hang up|timed? out|http 5\d\d/.test(message);
}

export async function retryTransientWrite(write, {
  attempts = 4,
  baseDelayMs = 100,
  onRetry = () => {}
} = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await write();
    } catch (error) {
      if (attempt >= attempts || !isTransientDatabaseError(error)) throw error;
      onRetry(error, attempt);
      const delay = Math.min(baseDelayMs * (2 ** (attempt - 1)), 2000);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

export class MediaWriteQueue {
  constructor(concurrency = 4) {
    this.concurrency = concurrency;
    this.active = 0;
    this.waiting = [];
  }

  run(write) {
    return new Promise((resolve, reject) => {
      this.waiting.push({ write, resolve, reject });
      this.drain();
    });
  }

  drain() {
    while (this.active < this.concurrency && this.waiting.length) {
      const job = this.waiting.shift();
      this.active++;
      Promise.resolve()
        .then(job.write)
        .then(job.resolve, job.reject)
        .finally(() => {
          this.active--;
          this.drain();
        });
    }
  }
}
