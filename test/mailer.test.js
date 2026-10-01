const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createMailer, resolveResendKey } = require('../mailer');
const { formatIntakeMessage } = require('../sms');

test('no mailer without a key', () => {
  assert.equal(createMailer({ apiKey: null }), null);
});

test('reads the Resend key from either variable', () => {
  assert.equal(resolveResendKey({ RESEND_API_KEY: 're_a' }), 're_a');
  assert.equal(resolveResendKey({ SENDGRID_API_KEY: 're_b' }), 're_b');
  assert.equal(resolveResendKey({ SENDGRID_API_KEY: 'SG.old' }), null);
});

test('posts to Resend with bearer auth', async () => {
  let call;
  const mailer = createMailer({
    apiKey: 're_x',
    fetchImpl: async (url, opts) => { call = { url, opts }; return { ok: true, json: async () => ({ id: 'e1' }) }; },
  });
  const r = await mailer.send({ to: 'a@b.test', from: 'x@y.test', subject: 'S', html: '<p>h</p>' });
  assert.equal(r.id, 'e1');
  assert.equal(call.url, 'https://api.resend.com/emails');
  assert.equal(call.opts.headers.Authorization, 'Bearer re_x');
  assert.deepEqual(JSON.parse(call.opts.body).to, ['a@b.test']);
});

test('throws a readable error when Resend rejects', async () => {
  const mailer = createMailer({
    apiKey: 're_x',
    fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ message: 'domain not verified' }) }),
  });
  await assert.rejects(mailer.send({ to: 'a', from: 'b', subject: 's', html: '' }), /Resend 403: domain not verified/);
});

test('intake text is marked [TEST] only for test orgs', () => {
  assert.match(formatIntakeMessage('Lucent Test Team'), /^\[TEST\] Thanks/);
  assert.match(formatIntakeMessage('Acme Realty'), /^Thanks/);
});
