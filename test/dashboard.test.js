const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const { computeDashboard, leadTimeline, localMidnight, rangeBounds } = require('../dashboard-metrics');
const { createDashboardRouter, createSessions, readCookie } = require('../dashboard');

const ORG = { id: 'org1', name: 'Maple Realty', timezone: 'America/Toronto', sla_hot_minutes: 5, sla_warm_minutes: 15, sla_cold_minutes: 60 };
const NOW = new Date('2026-10-15T18:00:00Z'); // 2 pm in Toronto
const at = (min) => new Date(NOW.getTime() + min * 60000).toISOString();
const silent = { log() {}, error() {} };

const agents = [
  { id: 'a1', name: 'Sam', is_active: true },
  { id: 'a2', name: 'Lee', is_active: true },
  { id: 'a3', name: 'Off Agent', is_active: false },
];

function scenario() {
  const leads = [
    // answered on time by Sam with tap-to-call
    { id: 'L1', first_name: 'Ann', status: 'contacted', assigned_to: 'a1', created_at: at(-120), sla_deadline: at(-115), first_contact_at: at(-118), response_time_seconds: 120, time_to_first_contact_seconds: 120, lead_temperature: 'hot' },
    // missed by Sam, moved to Lee, Lee answered by FUB call (late vs first window, on time for Lee)
    { id: 'L2', first_name: 'Bob', status: 'contacted', assigned_to: 'a2', created_at: at(-100), sla_deadline: at(-80), first_contact_at: at(-82), response_time_seconds: 180, time_to_first_contact_seconds: 1080, reassign_count: 1, lead_temperature: 'warm' },
    // never answered, past deadline, escalated
    { id: 'L3', first_name: 'Cy', status: 'escalated', assigned_to: 'a2', created_at: at(-60), sla_deadline: at(-45), first_contact_at: null, escalation_count: 1, lead_temperature: 'warm' },
    // still inside the window
    { id: 'L4', first_name: 'Di', status: 'assigned', assigned_to: 'a1', created_at: at(-2), sla_deadline: at(3), first_contact_at: null, lead_temperature: 'hot' },
    // from 3 days ago, answered by Reply 1
    { id: 'L5', first_name: 'Ed', status: 'contacted', assigned_to: 'a1', created_at: at(-3 * 1440), sla_deadline: at(-3 * 1440 + 15), first_contact_at: at(-3 * 1440 + 10), response_time_seconds: 600, time_to_first_contact_seconds: 600 },
    // from 10 days ago (outside 7d)
    { id: 'L6', first_name: 'Fay', status: 'contacted', assigned_to: 'a1', created_at: at(-10 * 1440), sla_deadline: at(-10 * 1440 + 5), first_contact_at: at(-10 * 1440 + 1), response_time_seconds: 60, time_to_first_contact_seconds: 60 },
  ];
  const events = [
    { lead_id: 'L1', event_type: 'assigned', created_at: at(-120), event_data: { agent_id: 'a1', sla_deadline: at(-115) } },
    { lead_id: 'L1', event_type: 'call_started', created_at: at(-118), event_data: { channel: 'tap_to_call' } },
    { lead_id: 'L2', event_type: 'assigned', created_at: at(-100), event_data: { agent_id: 'a1', sla_deadline: at(-85) } },
    { lead_id: 'L2', event_type: 'escalated', created_at: at(-85), event_data: { minutes_overdue: 0 } },
    { lead_id: 'L2', event_type: 'reassigned', created_at: at(-83), event_data: { from_agent_id: 'a1', to_agent_id: 'a2', to_agent_name: 'Lee' } },
    { lead_id: 'L2', event_type: 'contact_detected', created_at: at(-82), event_data: { channel: 'fub_call', verified: true } },
    { lead_id: 'L3', event_type: 'assigned', created_at: at(-60), event_data: { agent_id: 'a2', sla_deadline: at(-45) } },
    { lead_id: 'L4', event_type: 'assigned', created_at: at(-2), event_data: { agent_id: 'a1', sla_deadline: at(3) } },
    { lead_id: 'L5', event_type: 'assigned', created_at: at(-3 * 1440), event_data: { agent_id: 'a1', sla_deadline: at(-3 * 1440 + 15) } },
    { lead_id: 'L5', event_type: 'contact_confirmed', created_at: at(-3 * 1440 + 10), event_data: { channel: 'sms_reply' } },
  ];
  const escalations = [
    { lead_id: 'L2', agent_id: 'a1', escalated_at: at(-85) },
    { lead_id: 'L3', agent_id: 'a2', escalated_at: at(-45) },
  ];
  const openLeads = leads.filter((l) => !l.first_contact_at);
  return { org: ORG, agents, leads, events, escalations, openLeads, now: NOW };
}

test('time zone helpers use the brokerage day, including DST', () => {
  assert.equal(localMidnight(NOW, 'America/Toronto').toISOString(), '2026-10-15T04:00:00.000Z');
  assert.equal(localMidnight(new Date('2026-11-02T18:00:00Z'), 'America/Toronto', 1).toISOString(), '2026-11-01T04:00:00.000Z');
  assert.equal(localMidnight(new Date('2026-11-02T18:00:00Z'), 'America/Toronto', 0).toISOString(), '2026-11-02T05:00:00.000Z');
  assert.equal(rangeBounds('bogus', NOW, 'America/Toronto').key, '7d');
});

test('headline numbers for the last 7 days', () => {
  const d = computeDashboard({ ...scenario(), rangeKey: '7d' });
  const k = d.kpis;
  assert.equal(k.leads, 5); // L6 is older
  assert.equal(k.answered, 3);
  assert.equal(k.onTime, 2); // L1, L5
  assert.equal(k.late, 1); // L2 missed its first window
  assert.equal(k.notAnswered, 1); // L3
  assert.equal(k.waiting, 1); // L4
  assert.equal(k.onTimePct, 50); // 2 of 4 decided
  assert.equal(k.avgResponseSec, 300);
  assert.equal(k.avgFirstContactSec, 600);
  assert.equal(k.escalatedLeads, 2);
  assert.equal(k.reassignments, 1);
  assert.equal(d.daily.length, 7);
  const today = d.daily[6];
  assert.equal(today.date, '2026-10-15');
  assert.deepEqual([today.on_time, today.late, today.not_answered, today.waiting], [1, 1, 1, 1]);
  assert.equal(d.daily[3].on_time, 1); // L5, 3 days ago
});

test('how leads were answered, per agent, open and lead lists', () => {
  const d = computeDashboard({ ...scenario(), rangeKey: '7d' });
  assert.deepEqual(d.channels.map((c) => [c.key, c.count, c.verified]).sort(),
    [['fub_call', 1, true], ['sms_reply', 1, false], ['tap_to_call', 1, true]]);

  const sam = d.agents.find((a) => a.name === 'Sam');
  assert.equal(sam.received, 4); // L1, L2, L4, L5
  assert.equal(sam.answered, 2);
  assert.equal(sam.onTimePct, 67); // 2 on time of 3 windows (missed L2)
  assert.equal(sam.missed, 1);
  assert.equal(sam.movedAway, 1);
  const lee = d.agents.find((a) => a.name === 'Lee');
  assert.equal(lee.received, 2); // L3 + reassigned L2
  assert.equal(lee.answered, 1);
  assert.equal(lee.onTimePct, 50); // L2 on time in Lee's own window, L3 missed
  assert.deepEqual(lee.channels, { fub_call: 1 });
  assert.ok(!d.agents.some((a) => a.name === 'Off Agent')); // switched off, no activity

  assert.deepEqual(d.open.map((l) => l.id), ['L3', 'L4']); // most overdue first
  assert.ok(d.open[0].secondsLeft < 0);
  assert.equal(d.open[1].agent, 'Sam');
  assert.deepEqual(d.recent.map((l) => l.id), ['L4', 'L3', 'L2', 'L1', 'L5']);
  assert.equal(d.recent.find((l) => l.id === 'L2').channelLabel, 'Follow Up Boss call');
});

test('today only counts leads since local midnight', () => {
  const d = computeDashboard({ ...scenario(), rangeKey: 'today' });
  assert.equal(d.kpis.leads, 4);
  assert.equal(d.daily.length, 1);
});

test('lead timeline reads as plain steps', () => {
  const s = scenario();
  const t = leadTimeline({ lead: s.leads[1], events: s.events.filter((e) => e.lead_id === 'L2'), agents });
  assert.deepEqual(t.events.map((e) => e.text), [
    'Assigned to Sam',
    'Missed window; manager alerted (0 min over)',
    'Moved from Sam to Lee',
    'Follow Up Boss call detected (verified in CRM)',
  ]);
});

test('sessions are signed and expire', () => {
  let t = 1000;
  const s = createSessions(crypto.randomBytes(32), { now: () => t });
  const v = s.make({ id: 'u1', org_id: 'org1' });
  assert.deepEqual({ u: s.read(v).u, o: s.read(v).o }, { u: 'u1', o: 'org1' });
  assert.equal(s.read(`${v.split('.')[0]}.forged`), null);
  const other = createSessions(crypto.randomBytes(32), { now: () => t });
  assert.equal(other.read(v), null);
  t += 31 * 864e5;
  assert.equal(s.read(v), null);
  assert.equal(readCookie({ headers: { cookie: 'a=1; lucent_dash=xyz' } }, 'lucent_dash'), 'xyz');
});

// ---------- login flow over HTTP ----------

function fakeStore() {
  const users = [
    { id: 'u1', org_id: 'org1', email: 'boss@maple.ca', name: 'Pat Boss' },
    { id: 'u2', org_id: 'org2', email: 'other@oak.ca', name: 'Other' },
  ];
  const tokens = new Map();
  return {
    users, tokens,
    async usersByEmail(e) { return users.filter((u) => u.email === e); },
    async getUser(id) { return users.find((u) => u.id === id) || null; },
    async createToken(hash, userId, exp) { tokens.set(hash, { userId, exp, used: false }); },
    async peekToken(hash) { const t = tokens.get(hash); return t && !t.used && new Date(t.exp) > new Date() ? t.userId : null; },
    async consumeToken(hash) { const t = tokens.get(hash); if (!t || t.used || new Date(t.exp) <= new Date()) return null; t.used = true; return t.userId; },
    async touchLogin() {},
    async getOrg(id) { return { id, name: id === 'org1' ? 'Maple Realty' : 'Oak Homes' }; },
  };
}

async function withServer(fn) {
  const store = fakeStore();
  const sent = [];
  const data = {
    async summary(orgId, range) { return { orgId, range }; },
    async lead(orgId, id) { return id === 'L1' && orgId === 'org1' ? { id } : null; },
  };
  const app = express();
  app.use(createDashboardRouter({
    store, data, mailer: { async send(m) { sent.push(m); } }, fromEmail: 'alerts@x',
    sessionKey: crypto.randomBytes(32), linkBaseUrl: 'https://call.example.com', log: silent,
  }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = async (method, path, { form, cookie, origin = base, headers: extra = {} } = {}) => {
    const res = await fetch(base + path, {
      method, redirect: 'manual',
      headers: { origin, ...(cookie ? { cookie } : {}), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...extra },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    return { status: res.status, location: res.headers.get('location'), setCookie: res.headers.get('set-cookie'), text: await res.text() };
  };
  try { await fn({ req, sent, store }); } finally { server.close(); }
}

test('sign-in link flow: email, confirm, one use, then dashboard data for own brokerage only', async () => {
  await withServer(async ({ req, sent }) => {
    assert.equal((await req('GET', '/dashboard')).location, '/dashboard/login');
    assert.equal((await req('GET', '/dashboard/data')).status, 401);

    const unknown = await req('POST', '/dashboard/login', { form: { email: 'nobody@x.ca' } });
    assert.match(unknown.text, /Check your email/);
    assert.equal(sent.length, 0);

    const r = await req('POST', '/dashboard/login', { form: { email: 'Boss@Maple.ca' } });
    assert.match(r.text, /Check your email/);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'boss@maple.ca');
    const link = sent[0].html.match(/href="([^"]+)"/)[1];
    assert.match(link, /^https:\/\/call\.example\.com\/dashboard\/auth\?t=/);
    const token = new URL(link).searchParams.get('t');

    // Opening the link (or an email scanner opening it) does not sign in or use it up.
    const confirm = await req('GET', `/dashboard/auth?t=${token}`);
    assert.match(confirm.text, /Sign in to your dashboard/);
    assert.equal(confirm.setCookie, null);

    const signIn = await req('POST', '/dashboard/auth', { form: { t: token } });
    assert.equal(signIn.status, 303);
    assert.match(signIn.setCookie, /lucent_dash=.+HttpOnly; SameSite=Lax; Max-Age=2592000; Secure/);
    const cookie = signIn.setCookie.split(';')[0];

    assert.equal((await req('POST', '/dashboard/auth', { form: { t: token } })).status, 410); // used once
    assert.match((await req('GET', `/dashboard/auth?t=${token}`)).text, /expired/);

    const page = await req('GET', '/dashboard', { cookie });
    assert.equal(page.status, 200);
    assert.match(page.text, /Maple Realty/);
    const d = await req('GET', '/dashboard/data?range=30d', { cookie });
    assert.deepEqual(JSON.parse(d.text), { orgId: 'org1', range: '30d' });
    assert.equal((await req('GET', '/dashboard/leads/L1', { cookie })).status, 200);
    assert.equal((await req('GET', '/dashboard/leads/L9', { cookie })).status, 404);

    const out = await req('POST', '/dashboard/logout', { cookie });
    assert.match(out.setCookie, /Max-Age=0/);
  });
});

test('removed managers lose access; cross-site posts and bad tokens are refused', async () => {
  await withServer(async ({ req, sent, store }) => {
    await req('POST', '/dashboard/login', { form: { email: 'boss@maple.ca' } });
    const token = new URL(sent[0].html.match(/href="([^"]+)"/)[1]).searchParams.get('t');
    const cookie = (await req('POST', '/dashboard/auth', { form: { t: token } })).setCookie.split(';')[0];
    store.users.splice(0, 1); // access removed on the admin page
    assert.equal((await req('GET', '/dashboard/data', { cookie })).status, 401);

    assert.equal((await req('POST', '/dashboard/login', { form: { email: 'boss@maple.ca' }, origin: 'https://evil.example' })).status, 403);
    assert.equal((await req('POST', '/dashboard/auth', { form: { t: 'made-up' } })).status, 410);
    assert.equal((await req('POST', '/dashboard/login', { form: { email: 'not-an-email' } })).status, 400);
  });
});

test('link requests are rate limited per email', async () => {
  await withServer(async ({ req, sent }) => {
    for (let i = 0; i < 7; i += 1) await req('POST', '/dashboard/login', { form: { email: 'boss@maple.ca' } });
    assert.equal(sent.length, 5);
  });
});

test('browser form posts are accepted by Sec-Fetch-Site and refused cross-site', async () => {
  await withServer(async ({ req, sent }) => {
    const ok = await req('POST', '/dashboard/login', { form: { email: 'boss@maple.ca' }, origin: 'null', headers: { 'sec-fetch-site': 'same-origin' } });
    assert.equal(ok.status, 200);
    assert.equal(sent.length, 1);
    const bad = await req('POST', '/dashboard/login', { form: { email: 'boss@maple.ca' }, headers: { 'sec-fetch-site': 'cross-site' } });
    assert.equal(bad.status, 403);
  });
});
