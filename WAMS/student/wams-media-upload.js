(function () {
  const DB_NAME = 'wams-media-upload-queue';
  const STORE_NAME = 'uploads';
  const MAX_ATTEMPTS = 4;
  const CLIENT_CONCURRENCY = 3;
  const BASE_DELAY_MS = 250;
  const MAX_DELAY_MS = 4000;
  const active = new Set();
  const waiting = [];
  const memoryFallback = new Map();
  let databasePromise;
  let running = 0;

  function makeCaptureId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    return Array.from(bytes, (byte, index) =>
      [4, 6, 8, 10].includes(index) ? `-${byte.toString(16).padStart(2, '0')}` : byte.toString(16).padStart(2, '0')
    ).join('');
  }

  function openDatabase() {
    if (!('indexedDB' in window)) return Promise.reject(new Error('IndexedDB is unavailable'));
    if (!databasePromise) {
      databasePromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains(STORE_NAME)) {
            request.result.createObjectStore(STORE_NAME, { keyPath: 'captureId' });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('Unable to open media upload storage'));
      });
    }
    return databasePromise;
  }

  async function storeEntry(entry) {
    memoryFallback.set(entry.captureId, entry);
    try {
      const database = await openDatabase();
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, 'readwrite');
        transaction.objectStore(STORE_NAME).put(entry);
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error || new Error('Unable to persist media upload'));
        transaction.onabort = () => reject(transaction.error || new Error('Media upload persistence was aborted'));
      });
    } catch (error) {
      console.error('Unable to persist media upload in IndexedDB:', error);
    }
  }

  async function removeEntry(captureId) {
    memoryFallback.delete(captureId);
    try {
      const database = await openDatabase();
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, 'readwrite');
        transaction.objectStore(STORE_NAME).delete(captureId);
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error || new Error('Unable to clear saved media upload'));
      });
    } catch (error) {
      console.error('Unable to remove completed media upload from IndexedDB:', error);
    }
  }

  async function listEntries() {
    try {
      const database = await openDatabase();
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, 'readonly');
        const request = transaction.objectStore(STORE_NAME).getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error || new Error('Unable to load saved media uploads'));
      });
    } catch (error) {
      console.error('Unable to read saved media uploads:', error);
      return Array.from(memoryFallback.values());
    }
  }

  function authToken() {
    return localStorage.getItem('token') || localStorage.getItem('wamsToken');
  }

  function notifyFailure(entry, message, attempts) {
    const detail = {
      captureId: entry.captureId,
      type: entry.type,
      sessionId: entry.sessionId,
      message: String(message || 'Media upload failed').slice(0, 300),
      attempts
    };
    window.dispatchEvent(new CustomEvent('wams-media-upload-failed', { detail }));
    const hint = window.showHint;
    if (typeof hint === 'function') hint('A monitoring upload failed. Your exam can continue; your instructor may need to review it.');
  }

  async function reportFailure(entry) {
    if (entry.failureReported) return true;
    const token = authToken();
    if (!token) return false;
    try {
      const response = await fetch(`/api/sessions/${entry.sessionId}/media-upload-failures`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({
          capture_id: entry.captureId,
          capture_type: entry.type,
          message: entry.failureMessage,
          attempts: entry.attempts
        })
      });
      if (response.ok) {
        entry.failureReported = true;
        await storeEntry(entry);
        return true;
      }
      return false;
    } catch (error) {
      console.warn('Unable to report permanent media upload failure:', error);
      return false;
    }
  }

  async function persistFailure(entry, error) {
    entry.failed = true;
    entry.failureMessage = String(error && error.message || 'Media upload failed').slice(0, 300);
    entry.retryableFailure = error.retryable !== false;
    await storeEntry(entry);
    await reportFailure(entry);
    notifyFailure(entry, entry.failureMessage, entry.attempts);
  }

  function retryableStatus(status) {
    return status === 408 || status === 425 || status === 429 || status >= 500;
  }

  async function upload(entry) {
    const token = authToken();
    if (!token) throw new Error('Student session is no longer available');
    const headers = {
      'Authorization': `Bearer ${token}`,
      'X-Capture-Id': entry.captureId,
      'X-Session-Id': String(entry.sessionId),
    };
    if (entry.captureTrigger) headers['X-Capture-Trigger'] = entry.captureTrigger;
    let body = entry.blob;
    if (entry.blob) {
      headers['Content-Type'] = entry.blob.type;
      headers['X-Capture-Metadata'] = JSON.stringify(entry.metadata || {});
    } else {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify({
        capture_id: entry.captureId,
        audio_data: JSON.stringify(entry.metadata || {}),
        flagged: Boolean(entry.metadata && entry.metadata.flagged)
      });
    }
    const response = await fetch(entry.url, {
      method: 'POST',
      headers,
      body
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(result.error || `Media upload failed (${response.status})`);
      error.retryable = retryableStatus(response.status);
      throw error;
    }
    if (!result.success) {
      const error = new Error('Server did not confirm the media upload');
      error.retryable = false;
      throw error;
    }
    return result;
  }

  async function process(entry) {
    if (entry.failed) {
      if (!entry.retryableFailure) {
        await reportFailure(entry);
        notifyFailure(entry, entry.failureMessage, entry.attempts || 0);
        return;
      }
      entry.failed = false;
      entry.failureReported = false;
      entry.attempts = 0;
      await storeEntry(entry);
    }
    let lastError;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      entry.attempts = attempt;
      await storeEntry(entry);
      try {
        const result = await upload(entry);
        await removeEntry(entry.captureId);
        window.dispatchEvent(new CustomEvent('wams-media-uploaded', { detail: { ...result, type: entry.type } }));
        return result;
      } catch (error) {
        lastError = error;
        if (error.retryable === false || attempt === MAX_ATTEMPTS) break;
        const delay = Math.min(BASE_DELAY_MS * (2 ** (attempt - 1)), MAX_DELAY_MS);
        await new Promise(resolve => setTimeout(resolve, delay + Math.floor(Math.random() * 100)));
      }
    }
    await persistFailure(entry, lastError);
    throw lastError;
  }

  function drain() {
    while (running < CLIENT_CONCURRENCY && waiting.length) {
      const task = waiting.shift();
      running++;
      process(task.entry)
        .then(task.resolve, task.reject)
        .finally(() => {
          active.delete(task.entry.captureId);
          running--;
          drain();
        });
    }
  }

  async function enqueue(options) {
    const entry = {
      ...options,
      captureId: options.captureId || makeCaptureId(),
      attempts: 0,
      failed: false,
      createdAt: Date.now()
    };
    await storeEntry(entry);
    if (!entry.blob && entry.type !== 'audio') {
      const error = new Error('Screenshot encoding failed');
      error.retryable = false;
      await persistFailure(entry, error);
      throw error;
    }
    active.add(entry.captureId);
    return new Promise((resolve, reject) => {
      waiting.push({ entry, resolve, reject });
      drain();
    });
  }

  async function flushPending() {
    const entries = await listEntries();
    for (const entry of entries) {
      if (active.has(entry.captureId)) continue;
      active.add(entry.captureId);
      waiting.push({
        entry,
        resolve: () => {},
        reject: error => console.error('Saved media upload remains pending:', error)
      });
    }
    drain();
  }

  window.wamsMediaUpload = {
    enqueue,
    flushPending,
    makeCaptureId,
    canvasToJpegBlob(canvas, quality = 0.72, maxDimension = 1280) {
      return new Promise((resolve, reject) => {
        const scale = Math.min(1, maxDimension / Math.max(canvas.width, canvas.height));
        const output = document.createElement('canvas');
        output.width = Math.max(1, Math.round(canvas.width * scale));
        output.height = Math.max(1, Math.round(canvas.height * scale));
        const context = output.getContext('2d');
        if (!context) {
          reject(new Error('Screenshot canvas is unavailable'));
          return;
        }
        context.drawImage(canvas, 0, 0, output.width, output.height);
        output.toBlob(blob => blob ? resolve(blob) : reject(new Error('Screenshot encoding failed')), 'image/jpeg', quality);
      });
    }
  };

  window.addEventListener('online', flushPending);
  flushPending();
})();
