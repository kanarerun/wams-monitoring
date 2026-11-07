function doPost(event) {
  try {
    const body = JSON.parse(event.postData.contents);
    const expectedSecret = PropertiesService.getScriptProperties()
      .getProperty('WAMS_MAILER_SECRET');

    if (!expectedSecret || body.secret !== expectedSecret) {
      return jsonResponse({ success: false, error: 'Unauthorized mail relay request' });
    }
    if (!isValidEmail(body.to) ||
        typeof body.subject !== 'string' || !body.subject.trim() || body.subject.length > 200 ||
        typeof body.text !== 'string' || !body.text.trim() || body.text.length > 10000) {
      return jsonResponse({ success: false, error: 'Invalid email message' });
    }

    const options = {
      to: body.to,
      subject: body.subject,
      body: body.text,
      name: 'WAMS'
    };
    // Optional HTML body (used by the admin invitation email).
    if (typeof body.html === 'string' && body.html.trim() && body.html.length <= 50000) {
      options.htmlBody = body.html;
    }

    MailApp.sendEmail(options);
    return jsonResponse({ success: true });
  } catch (error) {
    console.error('WAMS email delivery failed:', error);
    return jsonResponse({ success: false, error: error.message || 'Email delivery failed' });
  }
}

function isValidEmail(value) {
  return typeof value === 'string' &&
    value.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function jsonResponse(value) {
  return ContentService.createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}
