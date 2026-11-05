import test from 'node:test';
import assert from 'node:assert/strict';
import { isEmailConfigured, sendEmail } from '../server/email.js';

const configuredEnv = {
  RESEND_API_KEY: 're_test_key',
  RESEND_FROM: 'WAMS <no-reply@example.com>'
};

test('email configuration requires both Resend credentials and a sender', () => {
  assert.equal(isEmailConfigured({}), false);
  assert.equal(isEmailConfigured({ RESEND_API_KEY: 're_test_key' }), false);
  assert.equal(isEmailConfigured({ RESEND_FROM: 'WAMS <no-reply@example.com>' }), false);
  assert.equal(isEmailConfigured(configuredEnv), true);
});

test('sendEmail posts the reset email through the Resend HTTPS API', async () => {
  let request;
  const result = await sendEmail({
    to: 'professor@example.edu',
    subject: 'Reset code',
    text: 'Your code is 123456'
  }, configuredEnv, async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      json: async () => ({ id: 'email-id' })
    };
  });

  assert.equal(request.url, 'https://api.resend.com/emails');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers.Authorization, 'Bearer re_test_key');
  assert.deepEqual(JSON.parse(request.options.body), {
    from: configuredEnv.RESEND_FROM,
    to: 'professor@example.edu',
    subject: 'Reset code',
    text: 'Your code is 123456'
  });
  assert.deepEqual(result, { id: 'email-id' });
});

test('sendEmail does not hide provider rejection', async () => {
  await assert.rejects(
    sendEmail({
      to: 'professor@example.edu',
      subject: 'Reset code',
      text: 'Your code is 123456'
    }, configuredEnv, async () => ({
      ok: false,
      status: 403,
      text: async () => JSON.stringify({ message: 'Sender domain is not verified' })
    })),
    /Sender domain is not verified/
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
