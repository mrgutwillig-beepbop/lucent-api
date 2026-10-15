const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { createAdminRouter, parseOrgForm, parseAgentForm } = require('../admin');

const ORG = '11111111-1111-4111-8111-111111111111';
const AGENT = '22222222-2222-4222-8222-222222222222';
const silent = { log() {}, error() {} };

function fakes() {
  const orgs = [{ id: ORG, name: 'Maple Realty', status: 'active', timezone: 'America/Toronto' }];
  const agents = [{ id: AGENT, org_id: ORG, name: 'Sam', email: 'sam@maple.ca', phone: '+14165550101', is_active: true, rotation_order: 3 }];
  const conns = [];
  const store = {
    orgs, agents,
    async listOrgs() { return orgs; },
    async getOrg(id) { return orgs.find((o) => o.id === id) || null; },
    async createOrg(row) { const o = { id: '33333333-3333-4333-8333-333333333333', status: 'active', ...row }; orgs.push(o); return { id: o.id }; },
    async updateOrg(id, row) { Object.assign(orgs.find((o) => o.id === id), row); },
    async listAgents(orgId) { return agents.filter((a) => a.org_id === orgId); },
    async createAgent(row) { agents.push({ id: 'new', ...row }); },
    async setAgentActive(orgId, id, v) { agents.find((a) => a.id === id && a.org_id === orgId).is_active = v; },
  };
  const connectCalls = [];
  const crmService = {
    fubUrl: (t) => `https://x/crm/fub/webhook/${t}`,
    async connect(orgId, provider, key) {
      connectCalls.push({ orgId, provider, key });
      if (key === 'wrong-key-123') return { ok: false, error: 'The CRM rejected this key: 401' };
      conns.push({ org_id: orgId, provider, key_hint: `…${key.slice(-4)}`, status: 'active' });
      return { ok: true };
    },
    async disconnect(orgId, provider) { const i = conns.findIndex((c) => c.org_id === orgId && c.provider === provider); if (i >= 0) conns.splice(i, 1); },
  };
  const crmStore = { async getByOrg(orgId) { return conns.filter((c) => c.org_id === orgId); } };
  return { store, crmService, crmStore, connectCalls, conns };
}

async function withServer(password, f, fn) {
  const app = express();
  app.use(createAdminRouter({ password, store: f.store, crmService: f.crmService, crmStore: f.crmStore, log: silent }));
  app.use((req, res) => res.status(404).send('none'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = `Basic ${Buffer.from(`admin:${password}`).toString('base64')}`;
  const req = async (method, path, form, headers = {}) => {
    const res = await fetch(base + path, {
      method,
      redirect: 'manual',
      headers: { authorization: auth, origin: base, ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...headers },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    return { status: res.status, location: res.headers.get('location'), text: await res.text() };
  };
  try { await fn({ req, base }); } finally { server.close(); }
}

test('form parsing applies defaults and rejects bad input', () => {
  const { row, errors } = parseOrgForm({ name: ' Maple ', primary_contact_phone: '416 555 0100', sla_hot_minutes: 'abc', timezone: 'Mars/Base' });
  assert.deepEqual(errors, []);
  assert.equal(row.name, 'Maple');
  assert.equal(row.primary_contact_phone, '+14165550100');
  assert.equal(row.sla_hot_minutes, 5);
  assert.equal(row.timezone, 'America/Toronto');
  assert.ok(parseOrgForm({ name: '' }).errors.length);
  assert.ok(parseOrgForm({ name: 'x', primary_contact_email: 'nope' }).errors.length);
  const a = parseAgentForm({ name: 'Al', email: 'AL@X.CA', phone: '(647) 555-0102' });
  assert.deepEqual(a.errors, []);
  assert.equal(a.row.email, 'al@x.ca');
  assert.equal(a.row.phone, '+16475550102');
  assert.equal(parseAgentForm({ name: 'Al', email: 'x', phone: '1' }).errors.length, 2);
});

test('admin is off without a password and requires it when set', async () => {
  await withServer('', fakes(), async ({ req }) => {
    assert.equal((await req('GET', '/admin')).status, 404);
  });
  await withServer('s3cret-pass', fakes(), async ({ req }) => {
    assert.equal((await req('GET', '/admin', null, { authorization: '' })).status, 401);
    const wrong = `Basic ${Buffer.from('admin:nope').toString('base64')}`;
    assert.equal((await req('GET', '/admin', null, { authorization: wrong })).status, 401);
    const ok = await req('GET', '/admin');
    assert.equal(ok.status, 200);
    assert.match(ok.text, /Maple Realty/);
  });
});

test('cross-site form posts are blocked', async () => {
  const f = fakes();
  await withServer('s3cret-pass', f, async ({ req }) => {
    const r = await req('POST', '/admin/orgs', { name: 'Evil' }, { origin: 'https://evil.example' });
    assert.equal(r.status, 403);
    assert.equal(f.store.orgs.length, 1);
  });
});

test('creates a brokerage and adds agents at the end of the rotation', async () => {
  const f = fakes();
  await withServer('s3cret-pass', f, async ({ req }) => {
    const r = await req('POST', '/admin/orgs', { name: 'Oak Homes', timezone: 'America/Vancouver' });
    assert.equal(r.status, 303);
    assert.match(r.location, /^\/admin\/orgs\/33333333-/);
    assert.equal(f.store.orgs[1].timezone, 'America/Vancouver');

    const a = await req('POST', `/admin/orgs/${ORG}/agents`, { name: 'Lee', email: 'lee@maple.ca', phone: '6475550199' });
    assert.equal(a.status, 303);
    const lee = f.store.agents.find((x) => x.name === 'Lee');
    assert.equal(lee.rotation_order, 4);
    assert.equal(lee.phone, '+16475550199');
    assert.equal(lee.org_id, ORG);

    await req('POST', `/admin/orgs/${ORG}/agents`, { name: 'Dup', email: 'SAM@maple.ca', phone: '6475550100' });
    assert.ok(!f.store.agents.some((x) => x.name === 'Dup'));

    const page = await req('GET', a.location);
    assert.match(page.text, /Lee added/);
    assert.match(page.text, /lee@maple\.ca/);
  });
});

test('toggles an agent and escapes stored text', async () => {
  const f = fakes();
  f.store.agents[0].name = '<script>x</script>';
  await withServer('s3cret-pass', f, async ({ req }) => {
    await req('POST', `/admin/orgs/${ORG}/agents/${AGENT}/toggle`, {});
    assert.equal(f.store.agents[0].is_active, false);
    const page = await req('GET', `/admin/orgs/${ORG}`);
    assert.ok(!page.text.includes('<script>x</script>'));
    assert.match(page.text, /&lt;script&gt;/);
  });
});

test('connects a CRM, shows only the key hint, and reports rejected keys', async () => {
  const f = fakes();
  await withServer('s3cret-pass', f, async ({ req }) => {
    const bad = await req('POST', `/admin/orgs/${ORG}/crm`, { provider: 'boldtrail', api_key: 'wrong-key-123' });
    const badPage = await req('GET', bad.location);
    assert.match(badPage.text, /rejected this key/);
    assert.equal(f.conns.length, 0);

    const good = await req('POST', `/admin/orgs/${ORG}/crm`, { provider: 'follow_up_boss', api_key: 'fka_live_key_7788' });
    const page = await req('GET', good.location);
    assert.match(page.text, /Follow Up Boss connected/);
    assert.match(page.text, /…7788/);
    assert.ok(!page.text.includes('fka_live_key_7788'));

    await req('POST', `/admin/orgs/${ORG}/crm/follow_up_boss/delete`, {});
    assert.equal(f.conns.length, 0);
    assert.equal((await req('POST', `/admin/orgs/${ORG}/crm/nope/delete`, {})).status, 404);
  });
});

test('unknown or malformed brokerage ids return 404', async () => {
  await withServer('s3cret-pass', fakes(), async ({ req }) => {
    assert.equal((await req('GET', '/admin/orgs/not-a-uuid')).status, 404);
    assert.equal((await req('GET', '/admin/orgs/44444444-4444-4444-8444-444444444444')).status, 404);
  });
});
