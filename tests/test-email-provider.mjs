import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { isEmailConfigured, sendEmail } from '../server/email.js';

const appsScriptSource = readFileSync('scripts/google-apps-script-mailer.js', 'utf8');
const configuredEnv = {
  GOOGLE_APPS_SCRIPT_URL: 'https://script.google.com/macros/s/test-deployment/exec',
  GOOGLE_APPS_SCRIPT_SECRET: 'test-secret'
};

test('email configuration requires a Google Apps Script URL and relay secret', () => {
  assert.equal(isEmailConfigured({}), false);
  assert.equal(isEmailConfigured({ GOOGLE_APPS_SCRIPT_URL: configuredEnv.GOOGLE_APPS_SCRIPT_URL }), false);
  assert.equal(isEmailConfigured({ GOOGLE_APPS_SCRIPT_SECRET: configuredEnv.GOOGLE_APPS_SCRIPT_SECRET }), false);
  assert.equal(isEmailConfigured(configuredEnv), true);
});

test('sendEmail posts the reset email through the Google Apps Script Web App', async () => {
  let request;
  const result = await sendEmail({
    to: 'professor@example.edu',
    subject: 'Reset code',
    text: 'Your code is 123456'
  }, configuredEnv, async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      text: async () => JSON.stringify({ success: true })
    };
  });

  assert.equal(request.url, configuredEnv.GOOGLE_APPS_SCRIPT_URL);
  assert.equal(request.options.method, 'POST');
  assert.deepEqual(JSON.parse(request.options.body), {
    secret: configuredEnv.GOOGLE_APPS_SCRIPT_SECRET,
    to: 'professor@example.edu',
    subject: 'Reset code',
    text: 'Your code is 123456'
  });
  assert.deepEqual(result, { success: true });
});

test('sendEmail does not hide Google mail relay failures', async () => {
  await assert.rejects(
    sendEmail({
      to: 'professor@example.edu',
      subject: 'Reset code',
      text: 'Your code is 123456'
    }, configuredEnv, async () => ({
      ok: true,
      text: async () => JSON.stringify({ success: false, error: 'Daily email quota exceeded' })
    })),
    /Daily email quota exceeded/
  );
});

test('sendEmail rejects when configuration is missing without making a request', async () => {
  let requested = false;
  await assert.rejects(
    sendEmail({ to: 'professor@example.edu', subject: 'Reset code', text: 'code' }, {}, async () => {
      requested = true;
    }),
    /Email delivery is not configured/
  );
  assert.equal(requested, false);
});

function runMailScript(body, { secret = 'test-secret', sendEmail = () => {} } = {}) {
  const context = {
    PropertiesService: {
      getScriptProperties: () => ({ getProperty: () => secret })
    },
    MailApp: { sendEmail },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: content => ({
        content,
        setMimeType: () => ({ content })
      })
    },
    console: { error() {} }
  };
  runInNewContext(appsScriptSource, context);
  const response = context.doPost({ postData: { contents: JSON.stringify(body) } });
  return JSON.parse(response.content);
}

test('Google Apps Script sends only an authorized valid message', () => {
  const sent = [];
  const message = {
    secret: 'test-secret',
    to: 'professor@example.edu',
    subject: 'Reset code',
    text: 'Your code is 123456'
  };
  assert.deepEqual(runMailScript(message, {
    sendEmail: value => sent.push(value)
  }), { success: true });
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [{
    to: 'professor@example.edu',
    subject: 'Reset code',
    body: 'Your code is 123456',
    name: 'WAMS'
  }]);

  assert.equal(runMailScript({ ...message, secret: 'wrong-secret' }).success, false);
  assert.equal(runMailScript({ ...message, to: 'not-an-email' }).success, false);
});

test('Google Apps Script reports Gmail send failures', () => {
  const result = runMailScript({
    secret: 'test-secret',
    to: 'professor@example.edu',
    subject: 'Reset code',
    text: 'Your code is 123456'
  }, {
    sendEmail: () => { throw new Error('Daily quota exceeded'); }
  });
  assert.deepEqual(result, { success: false, error: 'Daily quota exceeded' });
});
