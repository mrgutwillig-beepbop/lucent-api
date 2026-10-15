const { test } = require('node:test');
const assert = require('node:assert/strict');
const { deriveKey, createSecretBox, keyHint } = require('../secrets');
const { createCrmService } = require('../crm');

const box = createSecretBox(deriveKey({ CRM_ENCRYPTION_KEY: 'unit-test-key' }));
const silent = { log() {}, error() {} };

test('secret box round-trips and detects tampering', () => {
  const enc = box.encrypt('fka_secret_123456');
  assert.match(enc, /^v1\./);
  assert.ok(!enc.includes('secret'));
  assert.equal(box.decrypt(enc), 'fka_secret_123456');
  const parts = enc.split('.');
  parts[3] = Buffer.from('tampered').toString('base64url');
  assert.throws(() => box.decrypt(parts.join('.')));
  const other = createSecretBox(deriveKey({ API_SECRET_KEY: 'different' }));
  assert.throws(() => other.decrypt(enc));
});

test('deriveKey needs some key material; keyHint shows only the last 4', () => {
  assert.equal(deriveKey({}), null);
  assert.equal(deriveKey({ API_SECRET_KEY: 'x' }).length, 32);
  assert.equal(keyHint('abcdefghijkl'), '…ijkl');
  assert.equal(keyHint('short'), '…');
});

function memoryStore() {
  const rows = [];
  return {
    rows,
    async getByOrg(orgId) { return rows.filter((r) => r.org_id === orgId); },
    async getByToken(t) { return rows.find((r) => r.webhook_token === t) || null; },
    async listActive(p) { return rows.filter((r) => r.provider === p && r.status === 'active'); },
    async upsert(row) {
      let r = rows.find((x) => x.org_id === row.org_id && x.provider === row.provider);
      if (!r) { r = { id: `c${rows.length + 1}` }; rows.push(r); }
      Object.assign(r, row, { updated_at: new Date().toISOString() });
      return r;
    },
    async setStatus(id, status, err) { Object.assign(rows.find((r) => r.id === id), { status, last_error: err }); },
    async remove(orgId, p) { const i = rows.findIndex((r) => r.org_id === orgId && r.provider === p); if (i >= 0) rows.splice(i, 1); },
  };
}

function fakeFub({ badKey = 'bad-key-0000' } = {}) {
  const hooks = [];
  const make = ({ apiKey }) => ({
    async me() { if (apiKey === badKey) throw new Error('FUB /me -> 401: Unauthorized'); return { id: 1 }; },
    async listWebhooks() { return { webhooks: [...hooks] }; },
    async createWebhook(event, url) { const h = { id: hooks.length + 1, event, url, system: 'LucentPartners' }; hooks.push(h); return h; },
    async deleteWebhook(id) { const i = hooks.findIndex((h) => h.id === id); if (i >= 0) hooks.splice(i, 1); },
  });
  return { make, hooks };
}

function service(extra = {}) {
  const store = memoryStore();
  const fub = fakeFub();
  const svc = createCrmService({
    store, box, supabase: {}, publicBaseUrl: 'https://api.example.com/',
    fubSystemKey: 'sys', makeFubClient: fub.make, log: silent,
    makeBoldTrailClient: ({ token }) => ({ async ping() { if (token === 'bt-bad-token') throw new Error('BoldTrail /contacts -> 401: no'); } }),
    ...extra,
  });
  return { svc, store, fub };
}

test('connect validates the key before saving anything', async () => {
  const { svc, store } = service();
  const r = await svc.connect('org1', 'follow_up_boss', 'bad-key-0000');
  assert.equal(r.ok, false);
  assert.match(r.error, /rejected/);
  assert.equal(store.rows.length, 0);
  assert.equal((await svc.connect('org1', 'nope', 'abcdefghij')).ok, false);
  assert.equal((await svc.connect('org1', 'boldtrail', 'short')).ok, false);
});

test('connect stores the key encrypted and keeps the webhook token on reconnect', async () => {
  const { svc, store } = service();
  const r = await svc.connect('org1', 'follow_up_boss', 'good-key-1111');
  assert.equal(r.ok, true, r.error);
  const row = store.rows[0];
  assert.notEqual(row.api_key_encrypted, 'good-key-1111');
  assert.equal(box.decrypt(row.api_key_encrypted), 'good-key-1111');
  assert.equal(row.key_hint, '…1111');
  const token = row.webhook_token;
  assert.ok(token.length >= 20);
  await svc.connect('org1', 'follow_up_boss', 'good-key-2222');
  assert.equal(store.rows.length, 1);
  assert.equal(store.rows[0].webhook_token, token);
  assert.equal(svc.fubUrl(token), `https://api.example.com/crm/fub/webhook/${token}`);
});

test('BoldTrail connect pings the API', async () => {
  const { svc, store } = service();
  assert.equal((await svc.connect('org2', 'boldtrail', 'bt-bad-token')).ok, false);
  assert.equal((await svc.connect('org2', 'boldtrail', 'bt-good-token')).ok, true);
  assert.equal(store.rows[0].provider, 'boldtrail');
});

test('fubProcessorForToken resolves only active FUB connections', async () => {
  const { svc, store } = service();
  await svc.connect('org1', 'follow_up_boss', 'good-key-1111');
  const token = store.rows[0].webhook_token;
  assert.equal(typeof await svc.fubProcessorForToken(token), 'function');
  assert.equal(await svc.fubProcessorForToken('unknown'), null);
  assert.equal(await svc.fubProcessorForToken(''), null);
  store.rows[0].status = 'disabled';
  assert.equal(await svc.fubProcessorForToken(token), null);
});

test('migrateEnvConnection moves the Railway variables once', async () => {
  const { svc, store } = service();
  const env = { FUB_API_KEY: 'good-key-9999', FUB_ORG_ID: 'org-env' };
  assert.equal(await svc.migrateEnvConnection(env), true);
  assert.equal(store.rows.length, 1);
  assert.equal(store.rows[0].org_id, 'org-env');
  assert.equal(await svc.migrateEnvConnection(env), false);
  assert.equal(await svc.migrateEnvConnection({}), false);
});

test('disconnect removes the connection', async () => {
  const { svc, store } = service();
  await svc.connect('org1', 'boldtrail', 'bt-good-token');
  await svc.disconnect('org1', 'boldtrail');
  assert.equal(store.rows.length, 0);
});

test('connecting FUB registers token webhooks and removes our old URL', async () => {
  const { svc, store, fub } = service();
  fub.hooks.push({ id: 99, event: 'callsCreated', url: 'https://api.example.com/crm/fub/webhook' });
  fub.hooks.push({ id: 98, event: 'callsCreated', url: 'https://someone-else.com/hook' });
  await svc.connect('org1', 'follow_up_boss', 'good-key-1111');
  const url = svc.fubUrl(store.rows[0].webhook_token);
  assert.deepEqual(fub.hooks.filter((h) => h.url === url).map((h) => h.event).sort(), ['callsCreated', 'emailsCreated', 'textMessagesCreated']);
  assert.ok(!fub.hooks.some((h) => h.id === 99));
  assert.ok(fub.hooks.some((h) => h.id === 98));
});
