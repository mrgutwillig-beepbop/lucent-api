const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createReplyHandler, formatDuration } = require('../replies');
const { agentAssignmentMessage } = require('../enforcement');

const NOW = new Date('2026-10-05T16:05:00Z');
const AGENT_PHONE = '+14377478855';

function setup({ agentIds = ['a1'], lead = null, validate = () => true, fail = false } = {}) {
  const contacted = [];
  const events = [];
  const queries = [];
  const store = {
    agentIdsByPhone: async (phone) => { queries.push(phone); return phone === AGENT_PHONE ? agentIds : []; },
    latestOpenLead: async () => lead,
    markContacted: async (id) => { if (fail) throw new Error('db down'); contacted.push(id); },
    logEvent: async (l, type, data) => { events.push({ type, data }); },
  };
  const app = express();
  app.use(createReplyHandler({ store, baseUrl: 'https://lucent.test', validateTwilio: validate, now: () => NOW, log: { error() {} } }));
  return { app, contacted, events, queries };
}

async function sms(app, form) {
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/twilio/sms`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': 's' },
      body: new URLSearchParams(form).toString(),
    });
    return { status: res.status, xml: await res.text() };
  } finally { server.close(); }
}

const openLead = {
  id: 'L1', org_id: 'o1', first_name: 'Maria', last_name: 'Garcia', status: 'assigned',
  assigned_at: '2026-10-05T16:02:46Z', organizations: { name: 'Acme Realty' },
};

test('agent replying 1 marks their newest open lead contacted and confirms', async () => {
  const { app, contacted, events } = setup({ lead: openLead });
  const { xml } = await sms(app, { From: AGENT_PHONE, Body: ' 1 ' });
  assert.deepEqual(contacted, ['L1']);
  assert.deepEqual(events, [{ type: 'contact_confirmed', data: { channel: 'sms_reply', self_reported: true } }]);
  assert.match(xml, /Got it\. Maria Garcia marked as contacted\. Response time: 2m 14s\./);
});

test('"Done" and "yes" also count', async () => {
  for (const Body of ['Done', 'YES!', 'contacted.']) {
    const { app, contacted } = setup({ lead: openLead });
    await sms(app, { From: AGENT_PHONE, Body });
    assert.deepEqual(contacted, ['L1'], Body);
  }
});

test('test teams get the [TEST] label on the confirmation', async () => {
  const { app } = setup({ lead: { ...openLead, organizations: { name: 'Lucent Test Team' } } });
  const { xml } = await sms(app, { From: AGENT_PHONE, Body: '1' });
  assert.match(xml, /\[TEST\] LUCENT: Got it/);
});

test('agent with no open lead is told so', async () => {
  const { app, contacted } = setup({ lead: null });
  const { xml } = await sms(app, { From: AGENT_PHONE, Body: '1' });
  assert.equal(contacted.length, 0);
  assert.match(xml, /no leads waiting/);
});

test('other words from an agent get a short how-to, nothing is marked', async () => {
  const { app, contacted } = setup({ lead: openLead });
  const { xml } = await sms(app, { From: AGENT_PHONE, Body: 'who is this?' });
  assert.equal(contacted.length, 0);
  assert.match(xml, /Reply 1 once you have emailed or texted/);
});

test('messages from non-agents (e.g. leads) get no reply', async () => {
  const { app, contacted } = setup({ lead: openLead });
  const { xml } = await sms(app, { From: '+14165550101', Body: '1' });
  assert.equal(contacted.length, 0);
  assert.doesNotMatch(xml, /<Message>/);
});

test('STOP and HELP are left to Twilio', async () => {
  const { app } = setup({ lead: openLead });
  for (const Body of ['STOP', 'help']) {
    const { xml } = await sms(app, { From: AGENT_PHONE, Body });
    assert.doesNotMatch(xml, /<Message>/);
  }
});

test('unsigned webhook requests are rejected', async () => {
  const { app, contacted } = setup({ lead: openLead, validate: () => false });
  const { status } = await sms(app, { From: AGENT_PHONE, Body: '1' });
  assert.equal(status, 403);
  assert.equal(contacted.length, 0);
});

test('a database error is reported to the agent, not swallowed', async () => {
  const { app } = setup({ lead: openLead, fail: true });
  const { xml } = await sms(app, { From: AGENT_PHONE, Body: '1' });
  assert.match(xml, /could not record that/);
});

test('phone numbers are normalized before lookup', async () => {
  const { app, queries } = setup({ lead: openLead });
  await sms(app, { From: '+1 (437) 747-8855', Body: '1' });
  assert.equal(queries[0], AGENT_PHONE);
});

test('durations read naturally', () => {
  assert.equal(formatDuration(42), '42s');
  assert.equal(formatDuration(134), '2m 14s');
  assert.equal(formatDuration(120), '2m');
  assert.equal(formatDuration(3720), '1h 2m');
});

test('lead text tells agents they can reply 1', () => {
  const msg = agentAssignmentMessage({ ...openLead, phone: '+14165550101', reassign_count: 0 }, 'https://lucent.test/c/x');
  assert.match(msg, /Tap to call: https:\/\/lucent\.test\/c\/x\nEmailed or texted them\? Reply 1$/);
});
