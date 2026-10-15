const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createBoldTrailPoller, createBoldTrailClient, isOutboundCall, callTime, contactPhones, listOf } = require('../boldtrail');

const silent = { log() {}, error() {} };
const ASSIGNED = '2026-10-15T14:00:00Z';

function fakeStore(leads) {
  const marked = [];
  const events = [];
  return {
    marked, events,
    async openLeads() { return leads.filter((l) => !marked.includes(l.id)); },
    async markContacted(id) { marked.push(id); },
    async logEvent(lead, type, data) { events.push({ lead: lead.id, type, data }); },
  };
}

// A fake BoldTrail account. calls[contactId] can be changed between ticks.
function fakeBoldTrail({ contacts, calls, failWith = null }) {
  const seen = [];
  const make = ({ token }) => ({
    async findContactsByEmail(email) { if (failWith) throw new Error(failWith); seen.push(['email', token]); return { data: contacts.filter((c) => c.email === email) }; },
    async findContactsByName(first, last) { return { data: contacts.filter((c) => c.first_name === first && c.last_name === last) }; },
    async getContact(id) { return { data: contacts.find((c) => c.id === id) }; },
    async getCalls(id) { return { data: calls[id] || [] }; },
  });
  return { make, seen };
}

const lead = (over = {}) => ({ id: 'L1', org_id: 'org1', first_name: 'Jane', last_name: 'Doe', email: 'jane@x.com', phone: '+14165550100', assigned_at: ASSIGNED, ...over });

test('parsing helpers are tolerant of response shapes', () => {
  assert.equal(isOutboundCall({ direction: 'outbound' }), true);
  assert.equal(isOutboundCall({ direction: 'Inbound' }), false);
  assert.equal(isOutboundCall({}), true);
  assert.deepEqual(callTime({ date: '2026-10-15T14:05:00Z' }), { at: new Date('2026-10-15T14:05:00Z'), zoned: true });
  assert.equal(callTime({ date: '2026-10-15 14:05:00' }).zoned, false);
  assert.equal(callTime({}), null);
  assert.deepEqual(contactPhones({ cell_phone_1: '(416) 555-0100', home_phone: '' }), ['4165550100']);
  assert.deepEqual(listOf({ data: { data: [1] } }), [1]);
  assert.deepEqual(listOf(null), []);
});

test('an outbound call with a time after assignment marks the lead responded', async () => {
  const store = fakeStore([lead()]);
  const bt = fakeBoldTrail({
    contacts: [{ id: 7, email: 'jane@x.com' }],
    calls: { 7: [{ id: 'c1', direction: 'outbound', date: '2026-10-15T14:03:00Z', result: 'answered' }] },
  });
  const p = createBoldTrailPoller({ listConnections: async () => [{ id: 'conn1', org_id: 'org1', token: 't' }], store, makeClient: bt.make, log: silent });
  assert.deepEqual(await p.tick(), ['L1']);
  assert.deepEqual(store.marked, ['L1']);
  assert.equal(store.events[0].type, 'contact_detected');
  assert.equal(store.events[0].data.channel, 'boldtrail_call');
  assert.equal(store.events[0].data.verified, true);
  assert.equal(store.events[0].data.boldtrail_call_id, 'c1');
});

test('old calls and inbound calls do not count', async () => {
  const store = fakeStore([lead()]);
  const bt = fakeBoldTrail({
    contacts: [{ id: 7, email: 'jane@x.com' }],
    calls: { 7: [
      { id: 'old', direction: 'outbound', date: '2026-10-14T10:00:00Z' },
      { id: 'in', direction: 'inbound', date: '2026-10-15T14:10:00Z' },
    ] },
  });
  const p = createBoldTrailPoller({ listConnections: async () => [{ id: 'conn1', org_id: 'org1', token: 't' }], store, makeClient: bt.make, log: silent });
  assert.deepEqual(await p.tick(), []);
  assert.deepEqual(store.marked, []);
});

test('a call without a time zone counts only when it is new since watching began', async () => {
  const store = fakeStore([lead()]);
  const calls = { 7: [{ id: 'old', direction: 'outbound', date: '2026-10-15 13:00:00' }] };
  const bt = fakeBoldTrail({ contacts: [{ id: 7, email: 'jane@x.com' }], calls });
  const p = createBoldTrailPoller({ listConnections: async () => [{ id: 'conn1', org_id: 'org1', token: 't' }], store, makeClient: bt.make, log: silent });
  assert.deepEqual(await p.tick(), []); // first look: just records what's there
  assert.deepEqual(await p.tick(), []); // nothing new
  calls[7].unshift({ id: 'new', direction: 'outbound', date: '2026-10-15 10:04:00' });
  assert.deepEqual(await p.tick(), ['L1']);
});

test('finds the contact by name + phone when the lead has no email match', async () => {
  const store = fakeStore([lead({ email: null })]);
  const bt = fakeBoldTrail({
    contacts: [
      { id: 1, first_name: 'Jane', last_name: 'Doe', cell_phone_1: '6475559999' },
      { id: 2, first_name: 'Jane', last_name: 'Doe', cell_phone_1: '416-555-0100' },
    ],
    calls: { 2: [{ id: 'c', direction: 'outbound', date: '2026-10-15T14:01:00Z' }] },
  });
  const p = createBoldTrailPoller({ listConnections: async () => [{ id: 'conn1', org_id: 'org1', token: 't' }], store, makeClient: bt.make, log: silent });
  assert.deepEqual(await p.tick(), ['L1']);
  assert.equal(store.events[0].data.boldtrail_contact_id, 2);
});

test('a rejected key flags the connection and other brokerages keep working', async () => {
  const errors = [];
  const store = fakeStore([lead()]);
  const good = fakeBoldTrail({ contacts: [{ id: 7, email: 'jane@x.com' }], calls: { 7: [{ id: 'c', direction: 'outbound', date: '2026-10-15T14:01:00Z' }] } });
  const bad = fakeBoldTrail({ contacts: [], calls: {}, failWith: 'BoldTrail /contacts -> 401: Unauthenticated' });
  const p = createBoldTrailPoller({
    listConnections: async () => [{ id: 'bad', org_id: 'org1', token: 'bad' }, { id: 'good', org_id: 'org1', token: 'good' }],
    store,
    makeClient: ({ token }) => (token === 'bad' ? bad : good).make({ token }),
    onConnectionError: async (conn, e) => errors.push([conn.id, e.message]),
    log: silent,
  });
  assert.deepEqual(await p.tick(), ['L1']);
  assert.equal(errors.length, 1);
  assert.equal(errors[0][0], 'bad');
});

test('client sends the bearer token and reports API errors', async () => {
  const calls = [];
  let allow = false;
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: allow, status: allow ? 200 : 401, json: async () => (allow ? { data: [] } : { message: 'Unauthenticated' }) };
  };
  const c = createBoldTrailClient({ token: 'abc', fetchImpl });
  await assert.rejects(c.ping(), /-> 401: Unauthenticated/);
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer abc');
  assert.match(calls[0].url, /^https:\/\/api\.kvcore\.com\/v2\/public\/contacts\?limit=1$/);
  allow = true;
  await c.findContactsByEmail('a@b.com');
  assert.match(decodeURIComponent(calls[1].url), /filter\[email\]=a@b\.com/);
});
