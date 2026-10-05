const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const express = require('express');
const fub = require('../fub');

const NOW = new Date('2026-10-05T19:00:00Z');
const SYSTEM_KEY = 'sys-key';
const quiet = { log() {}, error() {} };

const openLead = {
  id: 'L1', org_id: 'org-1', first_name: 'Maria', last_name: 'Garcia',
  phone: '+14165550101', email: 'maria@example.com', status: 'assigned',
  assigned_at: '2026-10-05T18:58:00Z',
};

function setup({ activity, person = { phones: [{ value: '(416) 555-0101' }], emails: [] }, leads = [openLead] } = {}) {
  const gets = [];
  const contacted = [];
  const events = [];
  const client = {
    get: async (path) => {
      gets.push(path);
      if (path.startsWith('/people/')) return person;
      return activity;
    },
  };
  const store = {
    openLeads: async () => leads,
    markContacted: async (id) => { contacted.push(id); },
    logEvent: async (l, type, data) => { events.push({ type, data }); },
  };
  const processWebhook = fub.createFubProcessor({ client, store, orgId: 'org-1', log: quiet, now: () => NOW });
  return { processWebhook, gets, contacted, events };
}

const outgoingCall = { id: 7, personId: 55, userId: 3, isIncoming: false, outcome: 'Interested', duration: 42, created: '2026-10-05T18:59:30Z' };

test('outgoing FUB call to the lead marks it responded (verified)', async () => {
  const { processWebhook, contacted, events, gets } = setup({ activity: outgoingCall });
  const marked = await processWebhook({ event: 'callsCreated', resourceIds: [7] });
  assert.deepEqual(marked, ['L1']);
  assert.deepEqual(contacted, ['L1']);
  assert.deepEqual(gets, ['/calls/7', '/people/55']);
  assert.deepEqual(events[0], { type: 'contact_detected', data: {
    channel: 'fub_call', verified: true, source: 'follow_up_boss', fub_id: 7,
    fub_user_id: 3, outcome: 'Interested', duration_seconds: 42 } });
});

test('outgoing text counts, matched by phone', async () => {
  const { processWebhook, contacted, events } = setup({
    activity: { personId: 55, isIncoming: false, created: '2026-10-05T18:59:00Z' },
  });
  await processWebhook({ event: 'textMessagesCreated', resourceIds: [1] });
  assert.deepEqual(contacted, ['L1']);
  assert.equal(events[0].data.channel, 'fub_text');
});

// FUB emails: no personId / isIncoming; contact via relatedPeople, direction via addresses.
const emailPerson = { phones: [], emails: [{ value: 'Maria@Example.com' }] };
const sentEmail = (addresses, relatedPeople = [{ id: 55 }]) => ({
  id: 9, userId: 3, created: '2026-10-05T18:59:00Z', status: 'Sent', addresses, relatedPeople,
});

test('email sent TO the lead counts (addresses keyed by role)', async () => {
  const { processWebhook, contacted, events, gets } = setup({
    activity: sentEmail({ from: [{ email: 'agent@brokerage.ca' }], to: [{ email: 'maria@example.com' }] }),
    person: emailPerson,
  });
  await processWebhook({ event: 'emailsCreated', resourceIds: [9] });
  assert.deepEqual(contacted, ['L1']);
  assert.deepEqual(gets, ['/emails/9', '/people/55']);
  assert.equal(events[0].data.channel, 'fub_email');
});

test('email sent TO the lead counts (list of typed addresses, plain ids, display names)', async () => {
  const { processWebhook, contacted } = setup({
    activity: sentEmail(
      [{ type: 'from', email: 'agent@brokerage.ca' }, { type: 'to', email: 'Maria Garcia <MARIA@example.com>' }],
      [55],
    ),
    person: emailPerson,
  });
  await processWebhook({ event: 'emailsCreated', resourceIds: [9] });
  assert.deepEqual(contacted, ['L1']);
});

test('email FROM the lead (the lead writing in) does not count', async () => {
  const { processWebhook, contacted } = setup({
    activity: sentEmail({ from: ['maria@example.com'], to: ['agent@brokerage.ca'] }),
    person: emailPerson,
  });
  await processWebhook({ event: 'emailsCreated', resourceIds: [9] });
  assert.equal(contacted.length, 0);
});

test('email with no related people is ignored', async () => {
  const { processWebhook, contacted, gets } = setup({
    activity: sentEmail({ to: ['maria@example.com'] }, []),
    person: emailPerson,
  });
  await processWebhook({ event: 'emailsCreated', resourceIds: [9] });
  assert.equal(contacted.length, 0);
  assert.deepEqual(gets, ['/emails/9']);
});

test('address parsing helpers', () => {
  assert.deepEqual(fub.relatedPersonIds({ relatedPeople: [{ id: 1 }, 2, { personId: 3 }, { id: 1 }] }), [1, 2, 3]);
  assert.deepEqual(fub.emailRoles({ from: 'A <a@x.com>', to: ['b@x.com'], cc: [{ address: 'c@x.com' }] }),
    { from: ['a@x.com'], to: ['b@x.com', 'c@x.com'] });
});

test('incoming activity (the lead calling or writing in) does not count', async () => {
  const { processWebhook, contacted } = setup({ activity: { ...outgoingCall, isIncoming: true } });
  await processWebhook({ event: 'callsCreated', resourceIds: [7] });
  assert.equal(contacted.length, 0);
});

test('activity with unknown direction does not count', async () => {
  const { processWebhook, contacted } = setup({ activity: { personId: 55, created: '2026-10-05T18:59:00Z' } });
  await processWebhook({ event: 'emailsCreated', resourceIds: [1] });
  assert.equal(contacted.length, 0);
});

test('outreach before the lead was assigned does not count', async () => {
  const { processWebhook, contacted } = setup({ activity: { ...outgoingCall, created: '2026-10-05T18:50:00Z' } });
  await processWebhook({ event: 'callsCreated', resourceIds: [7] });
  assert.equal(contacted.length, 0);
});

test('a FUB contact that matches no open Lucent lead is ignored', async () => {
  const { processWebhook, contacted } = setup({ activity: outgoingCall, person: { phones: [{ value: '+1 905 555 0000' }], emails: [] } });
  await processWebhook({ event: 'callsCreated', resourceIds: [7] });
  assert.equal(contacted.length, 0);
});

test('unrelated webhook events are ignored', async () => {
  const { processWebhook, gets } = setup({ activity: outgoingCall });
  assert.deepEqual(await processWebhook({ event: 'peopleUpdated', resourceIds: [1] }), []);
  assert.equal(gets.length, 0);
});

test('direction detection', () => {
  assert.equal(fub.isOutgoing({ isIncoming: false }), true);
  assert.equal(fub.isOutgoing({ isIncoming: true }), false);
  assert.equal(fub.isOutgoing({ direction: 'Outgoing' }), true);
  assert.equal(fub.isOutgoing({ direction: 'Incoming' }), false);
  assert.equal(fub.isOutgoing({}), false);
});

// ---------- webhook route ----------

function sign(body) {
  return crypto.createHmac('sha256', SYSTEM_KEY).update(Buffer.from(body).toString('base64')).digest('hex');
}

async function postWebhook(handler, body, signature) {
  const app = express();
  app.use(handler);
  const server = app.listen(0);
  try {
    return await fetch(`http://127.0.0.1:${server.address().port}${fub.WEBHOOK_PATH}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'FUB-Signature': signature }, body,
    });
  } finally { server.close(); }
}

test('signed webhook is acknowledged and processed', async () => {
  const received = [];
  const handler = fub.createFubWebhookHandler({ systemKey: SYSTEM_KEY, log: quiet, processWebhook: async (p) => { received.push(p); return []; } });
  const body = JSON.stringify({ event: 'callsCreated', resourceIds: [7] });
  const res = await postWebhook(handler, body, sign(body));
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(received, [{ event: 'callsCreated', resourceIds: [7] }]);
});

test('webhook with a bad signature is rejected', async () => {
  const received = [];
  const handler = fub.createFubWebhookHandler({ systemKey: SYSTEM_KEY, log: quiet, processWebhook: async (p) => { received.push(p); } });
  const res = await postWebhook(handler, JSON.stringify({ event: 'callsCreated' }), 'deadbeef');
  assert.equal(res.status, 401);
  assert.equal(received.length, 0);
});

// ---------- webhook registration ----------

test('only missing webhooks are registered', async () => {
  const url = 'https://lucent.test/crm/fub/webhook';
  const created = [];
  const client = {
    listWebhooks: async () => ({ webhooks: [{ event: 'callsCreated', url, status: 'Active' }] }),
    createWebhook: async (event) => { created.push(event); },
  };
  await fub.ensureWebhooks({ client, url, log: quiet });
  assert.deepEqual(created, ['textMessagesCreated', 'emailsCreated']);
});

test('FUB client sends basic auth with the API key and the system headers', async () => {
  let seen;
  const client = fub.createFubClient({
    apiKey: 'k123', systemName: 'LucentPartners', systemKey: 'sk',
    fetchImpl: async (url, opts) => { seen = { url, opts }; return { ok: true, json: async () => ({ id: 1 }) }; },
  });
  await client.get('/calls/1');
  assert.equal(seen.url, 'https://api.followupboss.com/v1/calls/1');
  assert.equal(seen.opts.headers.Authorization, `Basic ${Buffer.from('k123:').toString('base64')}`);
  assert.equal(seen.opts.headers['X-System'], 'LucentPartners');
  assert.equal(seen.opts.headers['X-System-Key'], 'sk');
});
