// =====================================================
// CRM connections, one per brokerage (organization) and provider.
//
// Keys are encrypted (secrets.js) and stored in crm_connections. Connecting
// a CRM checks the key against the provider first, so a typo is caught during
// onboarding, not when the first lead arrives.
//
//   follow_up_boss  instant webhooks to /crm/fub/webhook/<webhook_token>
//   boldtrail       polled every minute by boldtrail.js
// =====================================================

const crypto = require('crypto');
const fub = require('./fub');
const { keyHint } = require('./secrets');

const PROVIDERS = {
  follow_up_boss: 'Follow Up Boss',
  boldtrail: 'BoldTrail (kvCORE)',
};

// ---------- store (Supabase) ----------

function createCrmStore(supabase) {
  const must = ({ data, error }) => {
    if (error) throw new Error(error.message);
    return data;
  };
  const FIELDS = 'id, org_id, provider, api_key_encrypted, key_hint, status, last_error, last_checked_at, webhook_token, updated_at';
  return {
    async getByOrg(orgId) {
      return must(await supabase.from('crm_connections').select(FIELDS).eq('org_id', orgId)) || [];
    },
    async getByToken(token) {
      const rows = must(await supabase.from('crm_connections').select(FIELDS).eq('webhook_token', token).limit(1)) || [];
      return rows[0] || null;
    },
    async listActive(provider) {
      return must(await supabase.from('crm_connections').select(FIELDS).eq('provider', provider).eq('status', 'active')) || [];
    },
    async upsert(row) {
      const rows = must(await supabase.from('crm_connections')
        .upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: 'org_id,provider' })
        .select(FIELDS)) || [];
      return rows[0];
    },
    async setStatus(id, status, lastError = null) {
      must(await supabase.from('crm_connections')
        .update({ status, last_error: lastError, last_checked_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', id));
    },
    async remove(orgId, provider) {
      must(await supabase.from('crm_connections').delete().eq('org_id', orgId).eq('provider', provider));
    },
  };
}

// ---------- service ----------

function createCrmService({
  store, box, supabase, publicBaseUrl,
  fubSystem = 'LucentPartners', fubSystemKey = null,
  makeFubClient = fub.createFubClient,
  makeBoldTrailClient = null, // injected from boldtrail.js (avoids a require cycle)
  log = console,
}) {
  const base = String(publicBaseUrl || '').replace(/\/+$/, '');
  const fubPrefix = `${base}${fub.WEBHOOK_PATH}`;
  const fubUrl = (token) => `${fubPrefix}/${token}`;
  const fubClientFor = (apiKey) => makeFubClient({ apiKey, systemName: fubSystem, systemKey: fubSystemKey });

  // Checks a key with the provider. Returns { ok, error }.
  async function validate(provider, apiKey) {
    try {
      if (provider === 'follow_up_boss') {
        if (!fubSystemKey) return { ok: false, error: 'FUB_SYSTEM_KEY is not set on the server' };
        await fubClientFor(apiKey).me();
      } else if (provider === 'boldtrail') {
        if (!makeBoldTrailClient) return { ok: false, error: 'BoldTrail support is not enabled' };
        await makeBoldTrailClient({ token: apiKey }).ping();
      } else {
        return { ok: false, error: 'Unknown CRM' };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // Connects (or replaces) a brokerage's CRM. Returns { ok, error, connection }.
  async function connect(orgId, provider, apiKey) {
    const key = String(apiKey || '').trim();
    if (!PROVIDERS[provider]) return { ok: false, error: 'Unknown CRM' };
    if (key.length < 8) return { ok: false, error: 'That API key looks too short' };

    const check = await validate(provider, key);
    if (!check.ok) return { ok: false, error: `The CRM rejected this key: ${check.error}` };

    const existing = (await store.getByOrg(orgId)).find((c) => c.provider === provider);
    const token = existing?.webhook_token || crypto.randomBytes(18).toString('base64url');
    const connection = await store.upsert({
      org_id: orgId,
      provider,
      api_key_encrypted: box.encrypt(key),
      key_hint: keyHint(key),
      status: 'active',
      last_error: null,
      last_checked_at: new Date().toISOString(),
      webhook_token: token,
    });

    if (provider === 'follow_up_boss') {
      try {
        await fub.ensureWebhooks({ client: fubClientFor(key), url: fubUrl(token), ownPrefix: fubPrefix, log });
      } catch (e) {
        await store.setStatus(connection.id, 'error', `Webhook setup failed: ${e.message}`);
        return { ok: false, error: `Key works, but Follow Up Boss wouldn't accept the notification setup: ${e.message}. The key must belong to the account owner.`, connection };
      }
    }
    return { ok: true, connection };
  }

  async function disconnect(orgId, provider) {
    await store.remove(orgId, provider);
  }

  // Webhook resolver for fub.createFubWebhookHandler.
  // token -> processWebhook for that brokerage, or null.
  const processorCache = new Map(); // connection id -> { updated_at, fn }
  async function fubProcessorForToken(token) {
    if (!token) return null;
    const conn = await store.getByToken(token);
    if (!conn || conn.provider !== 'follow_up_boss' || conn.status === 'disabled') return null;
    const cached = processorCache.get(conn.id);
    if (cached && cached.updated_at === conn.updated_at) return cached.fn;
    const fn = fub.createFubProcessor({
      client: fubClientFor(box.decrypt(conn.api_key_encrypted)),
      store: fub.createFubStore(supabase),
      orgId: conn.org_id,
      log,
    });
    processorCache.set(conn.id, { updated_at: conn.updated_at, fn });
    return fn;
  }

  // Startup: make sure every connected FUB account points at its current URL.
  async function ensureAllFubWebhooks() {
    if (!fubSystemKey) return;
    for (const conn of await store.listActive('follow_up_boss')) {
      try {
        await fub.ensureWebhooks({ client: fubClientFor(box.decrypt(conn.api_key_encrypted)), url: fubUrl(conn.webhook_token), ownPrefix: fubPrefix, log });
      } catch (e) {
        log.error(`FUB webhook check failed for org ${conn.org_id}:`, e.message);
      }
    }
  }

  // Startup: move the original single-account setup (FUB_API_KEY + FUB_ORG_ID
  // Railway variables) into a per-brokerage connection, once.
  async function migrateEnvConnection(env = process.env) {
    if (!env.FUB_API_KEY || !env.FUB_ORG_ID) return false;
    const existing = (await store.getByOrg(env.FUB_ORG_ID)).find((c) => c.provider === 'follow_up_boss');
    if (existing) return false;
    const r = await connect(env.FUB_ORG_ID, 'follow_up_boss', env.FUB_API_KEY);
    log.log(r.ok ? 'FUB: moved the Railway-variable connection to per-brokerage storage' : `FUB migration failed: ${r.error}`);
    return r.ok;
  }

  return { PROVIDERS, validate, connect, disconnect, fubProcessorForToken, ensureAllFubWebhooks, migrateEnvConnection, fubUrl };
}

module.exports = { PROVIDERS, createCrmStore, createCrmService };
