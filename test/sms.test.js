const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  isValidPhone,
  normalizePhone,
  formatIntakeMessage,
  sendIntakeSms,
} = require('../sms');

test('isValidPhone accepts 10-15 digit numbers in various formats', () => {
  assert.equal(isValidPhone('+14155552671'), true);
  assert.equal(isValidPhone('(415) 555-2671'), true);
  assert.equal(isValidPhone('415-555-2671'), true);
  assert.equal(isValidPhone('4155552671'), true);
});

test('isValidPhone rejects missing / short / non-string input', () => {
  assert.equal(isValidPhone(''), false);
  assert.equal(isValidPhone(null), false);
  assert.equal(isValidPhone(undefined), false);
  assert.equal(isValidPhone('123'), false);       // too few digits
  assert.equal(isValidPhone('abcdefghij'), false); // no digits
  assert.equal(isValidPhone(4155552671), false);   // not a string
  assert.equal(isValidPhone('1234567890123456'), false); // 16 digits, too long
});

test('normalizePhone produces E.164', () => {
  assert.equal(normalizePhone('4155552671'), '+14155552671'); // 10-digit -> +1
  assert.equal(normalizePhone('(415) 555-2671'), '+14155552671');
  assert.equal(normalizePhone('+44 20 7946 0958'), '+442079460958'); // preserve +
  assert.equal(normalizePhone('14155552671'), '+14155552671'); // 11-digit bare
});

test('formatIntakeMessage embeds org name', () => {
  assert.equal(
    formatIntakeMessage('Acme Realty'),
    'Thanks for your inquiry. An agent from Acme Realty will contact you shortly.'
  );
});

test('formatIntakeMessage falls back when org name missing', () => {
  assert.equal(
    formatIntakeMessage(''),
    'Thanks for your inquiry. An agent from our team will contact you shortly.'
  );
  assert.equal(
    formatIntakeMessage(undefined),
    'Thanks for your inquiry. An agent from our team will contact you shortly.'
  );
});

test('sendIntakeSms sends with correct to/from/body for a valid phone', async () => {
  const calls = [];
  const twilioClient = {
    messages: {
      create: async (opts) => {
        calls.push(opts);
        return { sid: 'SM_test_123' };
      },
    },
  };

  const result = await sendIntakeSms({
    twilioClient,
    fromNumber: '+15005550006',
    phone: '(415) 555-2671',
    orgName: 'Acme Realty',
  });

  assert.deepEqual(result, { sent: true, sid: 'SM_test_123' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].to, '+14155552671');
  assert.equal(calls[0].from, '+15005550006');
  assert.equal(
    calls[0].body,
    'Thanks for your inquiry. An agent from Acme Realty will contact you shortly.'
  );
});

test('sendIntakeSms does NOT send when phone is invalid', async () => {
  let called = false;
  const twilioClient = { messages: { create: async () => { called = true; return { sid: 'x' }; } } };

  const result = await sendIntakeSms({
    twilioClient,
    fromNumber: '+15005550006',
    phone: '123', // invalid
    orgName: 'Acme Realty',
  });

  assert.equal(called, false);
  assert.deepEqual(result, { sent: false, reason: 'invalid_phone' });
});

test('sendIntakeSms does NOT send when Twilio is not configured', async () => {
  const result = await sendIntakeSms({
    twilioClient: null,
    fromNumber: null,
    phone: '+14155552671',
    orgName: 'Acme Realty',
  });
  assert.deepEqual(result, { sent: false, reason: 'twilio_not_configured' });
});
