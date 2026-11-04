(function () {
  async function renderMediaUploadFailures({ panel, examId, sessionId, token }) {
    if (!panel) return;
    panel.replaceChildren();

    try {
      let failures = [];
      if (token) {
        const response = await fetch(`/api/exams/${examId}/media-upload-failures`, {
          headers: { 'Authorization': 'Bearer ' + token }
        });
        if (!response.ok) throw new Error(`Unable to load media upload failures (${response.status})`);
        const result = await response.json();
        failures = Array.isArray(result) ? result : [];
      }

      failures = failures.filter(failure => String(failure.session_id) === String(sessionId));
      if (!failures.length) {
        panel.hidden = true;
        return;
      }

      panel.hidden = false;
      const title = document.createElement('strong');
      title.textContent = 'Media upload failures';
      const list = document.createElement('ul');
      failures.forEach(failure => {
        const item = document.createElement('li');
        item.textContent = `${failure.capture_type} capture (${failure.attempts} attempts): ${failure.message}`;
        list.appendChild(item);
      });
      panel.append(title, list);
    } catch (error) {
      console.error('Unable to load media upload failure notifications:', error);
      panel.hidden = false;
      panel.textContent = 'Unable to load media upload failure notifications.';
    }
  }

  window.renderMediaUploadFailures = renderMediaUploadFailures;
})();
