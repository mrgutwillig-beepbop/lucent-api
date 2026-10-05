const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createCallBridge, makeCallCode, parseCallCode, codeMatches } = require('../callbridge');
const { agentAssignmentMessage } = require('../enforcement');

const SECRET = 'call-secret';
const BASE = 'https://lucent.test';
const LEAD_ID = '021ebb05-65e8-44cf-a0df-4c934fcaf58f';
const AGENT_1 = '11111111-2222-3333-4444-555555555555';
const AGENT_2 = '99999999-2222-3333-4444-555555555555';
const NOW = new Date('2026-10-03T15:00:00Z');

function lead(overrides = {}) {
  return {
    id: LEAD_ID, org_id: 'org-1', first_name: 'Maria', last_name: 'Garcia', phone: '+14165550101',
    status: 'assigned', assigned_to: AGENT_1, assigned_at: '2026-10-03T14:58:00Z', first_contact_at: null,
    agents: { name: 'Sarah', phone: '+14165550111' }, organizations: { name: 'Acme' },
    ...overrides,
  };
}

function setup({ current = lead(), validate = () => true } = {}) {
  const calls = [];
  const events = [];
  const contacted = [];
  const store = {
    getLead: async (id) => (id === current.id ? current : null),
    markContacted: async (id) => { contacted.push(id); },
    logEvent: async (l, type, data) => { events.push({ type, data }); },
  };
  const twilioClient = { calls: { create: async (opts) => { calls.push(opts); return { sid: 'CA1' }; } } };
  const app = express();
  app.use(createCallBridge({
    store, twilioClient, fromNumber: '+12898143720', baseUrl: BASE, secret: SECRET,
    validateTwilio: validate, now: () => NOW, log: { error() {} },
  }));
  return { app, calls, events, contacted };
}

async function withServer(app, fn) {
  const server = app.listen(0);
  try { await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}

const post = (url, form = {}) => fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': 'sig' },
  body: new URLSearchParams(form).toString(),
});

const code = makeCallCode(SECRET, LEAD_ID, AGENT_1);

test('call codes are short, round-trip, and tied to the current agent', () => {
  assert.equal(code.length, 34);
  assert.equal(parseCallCode(code).leadId, LEAD_ID);
  assert.ok(codeMatches(SECRET, code, LEAD_ID, AGENT_1));
  assert.ok(!codeMatches(SECRET, code, LEAD_ID, AGENT_2));
  assert.ok(!codeMatches('other-secret', code, LEAD_ID, AGENT_1));
  assert.equal(parseCallCode('bad'), null);
});

test('opening the link shows a button and does not place a call', async () => {
  const { app, calls } = setup();
  await withServer(app, async (url) => {
    const res = await fetch(`${url}/c/${code}`);
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(html, /Call Maria Garcia/);
    assert.match(html, /<form method="post">/);
    assert.equal(calls.length, 0);
  });
});

test('pressing Call now rings the agent from the Lucent number', async () => {
  const { app, calls, events } = setup();
  await withServer(app, async (url) => {
    const res = await post(`${url}/c/${code}`);
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].to, '+14165550111');
    assert.equal(calls[0].from, '+12898143720');
    assert.equal(calls[0].url, `${BASE}/twilio/voice/connect/${code}`);
    assert.deepEqual(events.map((e) => e.type), ['call_requested']);
  });
});

test('a link stops working once the lead is reassigned', async () => {
  const { app, calls } = setup({ current: lead({ assigned_to: AGENT_2 }) });
  await withServer(app, async (url) => {
    const res = await post(`${url}/c/${code}`);
    assert.equal(res.status, 410);
    assert.match(await res.text(), /reassigned/);
    assert.equal(calls.length, 0);
  });
});

test('closed or old leads cannot be called', async () => {
  for (const current of [lead({ status: 'closed' }), lead({ assigned_at: '2026-09-20T00:00:00Z' })]) {
    const { app, calls } = setup({ current });
    await withServer(app, async (url) => {
      assert.equal((await post(`${url}/c/${code}`)).status, 410);
      assert.equal(calls.length, 0);
    });
  }
});

test('agent answering hears a press-1 prompt (voicemail cannot connect)', async () => {
  const { app } = setup();
  await withServer(app, async (url) => {
    const xml = await (await post(`${url}/twilio/voice/connect/${code}`)).text();
    assert.match(xml, /<Gather numDigits="1"/);
    assert.match(xml, /Press 1 to call Maria Garcia/);
    assert.match(xml, new RegExp(`/twilio/voice/dial/${code}`));
  });
});

test('pressing 1 marks the lead responded and dials the lead', async () => {
  const { app, contacted, events } = setup();
  await withServer(app, async (url) => {
    const xml = await (await post(`${url}/twilio/voice/dial/${code}`, { Digits: '1', CallSid: 'CA1' })).text();
    assert.deepEqual(contacted, [LEAD_ID]);
    assert.match(xml, /<Dial callerId="\+12898143720"/);
    assert.match(xml, /<Number>\+14165550101<\/Number>/);
    assert.deepEqual(events.map((e) => e.type), ['call_started']);
  });
});

test('calling back an already-contacted lead connects without re-marking', async () => {
  const { app, contacted } = setup({ current: lead({ status: 'contacted', first_contact_at: '2026-10-03T14:59:00Z' }) });
  await withServer(app, async (url) => {
    const xml = await (await post(`${url}/twilio/voice/dial/${code}`, { Digits: '1' })).text();
    assert.equal(contacted.length, 0);
    assert.match(xml, /<Dial/);
  });
});

test('any key other than 1 hangs up without marking', async () => {
  const { app, contacted } = setup();
  await withServer(app, async (url) => {
    const xml = await (await post(`${url}/twilio/voice/dial/${code}`, { Digits: '2' })).text();
    assert.match(xml, /<Hangup\/>/);
    assert.equal(contacted.length, 0);
  });
});

test('call outcome and duration are logged when the call ends', async () => {
  const { app, events } = setup();
  await withServer(app, async (url) => {
    await post(`${url}/twilio/voice/done/${code}`, { DialCallStatus: 'completed', DialCallDuration: '42' });
    assert.deepEqual(events, [{ type: 'call_ended', data: { channel: 'tap_to_call', outcome: 'completed', duration_seconds: 42 } }]);
  });
});

test('Twilio webhooks with a bad signature are rejected', async () => {
  const { app, contacted } = setup({ validate: () => false });
  await withServer(app, async (url) => {
    const res = await post(`${url}/twilio/voice/dial/${code}`, { Digits: '1' });
    assert.equal(res.status, 403);
    assert.equal(contacted.length, 0);
  });
});

test('agent lead text includes the tap-to-call link', () => {
  const msg = agentAssignmentMessage({ ...lead(), sla_deadline: '2026-10-03T15:03:00Z', reassign_count: 0 }, `${BASE}/c/${code}`);
  assert.match(msg, new RegExp(`Tap to call: ${BASE}/c/${code}`));
  assert.doesNotMatch(agentAssignmentMessage({ ...lead(), phone: null }, `${BASE}/c/${code}`), /Tap to call/);
});

test('agent hears why the call did not connect', async () => {
  const { app } = setup();
  await withServer(app, async (url) => {
    const failed = await (await post(`${url}/twilio/voice/done/${code}`, { DialCallStatus: 'failed' })).text();
    assert.match(failed, /could not be connected/);
    const ok = await (await post(`${url}/twilio/voice/done/${code}`, { DialCallStatus: 'completed', DialCallDuration: '5' })).text();
    assert.doesNotMatch(ok, /<Say>/);
  });
});
