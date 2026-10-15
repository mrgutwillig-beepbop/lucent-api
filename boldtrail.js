// =====================================================
// BoldTrail (kvCORE) call detection
//
// BoldTrail has no webhooks and its API exposes calls (not texts/emails).
// Every minute, for each brokerage with an active BoldTrail connection:
//   1. take its open Lucent leads (waiting for a response, last 24h)
//   2. find each lead's BoldTrail contact (by email, else by name + phone)
//   3. read the contact's call log; an outbound call made after the lead was
//      assigned marks it responded (verified, channel boldtrail_call)
//
// BoldTrail call times may not include a time zone, so a call also counts if
// it is NEW since we started watching the lead (its id wasn't there before).
//
// API: https://api.kvcore.com/v2/public  (Authorization: Bearer <token>)
//   GET /contacts?filter[email]=..  /contacts?filter[first_name]=..&filter[last_name]=..
//   GET /contact/{id}               (cell_phone_1, home_phone, work_phone, email, last_call)
//   GET /contact/{id}/action/call   (call log)
// =====================================================

const BT_BASE = 'https://api.kvcore.com/v2/public';
const LOOKBACK_MS = 24 * 3600 * 1000;

const last10 = (phone) => String(phone || '').replace(/\D/g, '').slice(-10);
const normEmail = (e) => String(e || '').trim().toLowerCase();

// ---------- API client ----------

function createBoldTrailClient({ token, fetchImpl = globalThis.fetch }) {
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' };
  async function get(path, query = {}) {
    const qs = new URLSearchParams(query).toString();
    const res = await fetchImpl(`${BT_BASE}${path}${qs ? `?${qs}` : ''}`, { method: 'GET', headers });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`BoldTrail ${path.split('/').slice(0, 3).join('/')} -> ${res.status}: ${json.message || json.error || 'error'}`);
    return json;
  }
  return {
    get,
    ping: () => get('/contacts', { limit: 1 }),
    findContactsByEmail: (email) => get('/contacts', { 'filter[email]': email, limit: 10 }),
    findContactsByName: (first, last) => get('/contacts', { 'filter[first_name]': first, 'filter[last_name]': last, limit: 10 }),
    getContact: (id) => get(`/contact/${id}`),
    getCalls: (id) => get(`/contact/${id}/action/call`),
  };
}

// ---------- parsing (tolerant: response shapes vary) ----------

const listOf = (json) => (Array.isArray(json) ? json
  : Array.isArray(json?.data) ? json.data
  : Array.isArray(json?.data?.data) ? json.data.data
  : []);

const objOf = (json) => (json?.data && !Array.isArray(json.data) ? json.data : json) || {};

function contactPhones(c) {
  return ['cell_phone_1', 'cell_phone_2', 'home_phone', 'work_phone', 'phone']
    .map((k) => last10(c?.[k])).filter((p) => p.length === 10);
}

function callId(call) { return String(call?.id ?? call?.action_id ?? call?.call_id ?? ''); }

function isOutboundCall(call) {
  const dir = String(call?.direction ?? call?.call_direction ?? call?.type ?? '').toLowerCase();
  if (dir.includes('in')) return false; // inbound
  return true; // 'outbound', or BoldTrail's default when not specified
}

// Parses a call time. Returns { at: Date, zoned: boolean } or null.
function callTime(call) {
  const raw = call?.date ?? call?.created_at ?? call?.call_date ?? call?.datetime;
  if (!raw) return null;
  const s = String(raw);
  const zoned = /[zZ]$|[+-]\d\d:?\d\d$/.test(s);
  const at = new Date(zoned ? s : `${s.replace(' ', 'T')}Z`);
  return Number.isNaN(at.getTime()) ? null : { at, zoned };
}

// ---------- detection ----------

function createBoldTrailPoller({
  listConnections, // async () => [{ id, org_id, token }]
  store,           // { openLeads(orgId, sinceIso), markContacted(id), logEvent(lead, type, data) }
  makeClient = createBoldTrailClient,
  onConnectionError = async () => {},
  log = console,
  now = () => new Date(),
}) {
  const contactIds = new Map(); // lead id -> BoldTrail contact id (null = not found)
  const baselines = new Map();  // lead id -> Set of call ids seen when watching began
  let loggedShape = false;

  async function findContact(client, lead) {
    if (contactIds.has(lead.id)) return contactIds.get(lead.id);
    let id = null;
    if (lead.email) {
      const hit = listOf(await client.findContactsByEmail(lead.email))
        .find((c) => normEmail(c.email) === normEmail(lead.email));
      id = hit?.id ?? null;
    }
    if (!id && lead.first_name && lead.phone) {
      for (const c of listOf(await client.findContactsByName(lead.first_name, lead.last_name || '')).slice(0, 5)) {
        const full = objOf(await client.getContact(c.id));
        if (contactPhones(full).includes(last10(lead.phone))) { id = c.id; break; }
      }
    }
    contactIds.set(lead.id, id);
    return id;
  }

  // Returns the qualifying call, or null.
  async function newOutboundCall(client, lead, contactId) {
    const calls = listOf(await client.getCalls(contactId));
    if (!loggedShape && calls.length) {
      loggedShape = true;
      log.log('BoldTrail call fields:', Object.keys(calls[0]).join(','));
    }
    const assignedAt = lead.assigned_at ? new Date(lead.assigned_at) : null;
    const firstLook = !baselines.has(lead.id);
    const baseline = baselines.get(lead.id) || new Set();

    let found = null;
    for (const call of calls) {
      if (!isOutboundCall(call)) continue;
      const t = callTime(call);
      const isNew = !firstLook && !baseline.has(callId(call));
      const afterAssign = t && assignedAt && (t.zoned ? t.at >= assignedAt : false);
      if (isNew || afterAssign) { found = call; break; }
    }
    if (firstLook) baselines.set(lead.id, new Set(calls.map(callId)));
    return found;
  }

  async function pollConnection(conn) {
    const client = makeClient({ token: conn.token });
    const leads = await store.openLeads(conn.org_id, new Date(now() - LOOKBACK_MS).toISOString());
    const marked = [];
    for (const lead of leads) {
      try {
        const contactId = await findContact(client, lead);
        if (!contactId) continue;
        const call = await newOutboundCall(client, lead, contactId);
        if (!call) continue;
        await store.markContacted(lead.id);
        await store.logEvent(lead, 'contact_detected', {
          channel: 'boldtrail_call',
          verified: true,
          source: 'boldtrail',
          boldtrail_contact_id: contactId,
          boldtrail_call_id: callId(call) || null,
          result: call.result ?? null,
        }).catch((e) => log.error('BoldTrail log error:', e.message));
        contactIds.delete(lead.id);
        baselines.delete(lead.id);
        marked.push(lead.id);
        log.log(`BoldTrail call marked lead ${lead.id} responded`);
      } catch (e) {
        if (/-> 401|-> 403/.test(e.message)) throw e; // bad key: stop this connection
        log.error(`BoldTrail check failed for lead ${lead.id}:`, e.message);
      }
    }
    return marked;
  }

  async function tick() {
    const out = [];
    for (const conn of await listConnections()) {
      try {
        out.push(...await pollConnection(conn));
      } catch (e) {
        log.error(`BoldTrail connection ${conn.id} failed:`, e.message);
        await onConnectionError(conn, e).catch(() => {});
      }
    }
    return out;
  }

  function start(intervalMs = 60000) {
    let running = false;
    const run = async () => {
      if (running) return;
      running = true;
      try { await tick(); } catch (e) { log.error('BoldTrail poll error:', e.message); } finally { running = false; }
    };
    run();
    return setInterval(run, intervalMs);
  }

  return { tick, start, pollConnection, _state: { contactIds, baselines } };
}

module.exports = { createBoldTrailClient, createBoldTrailPoller, contactPhones, isOutboundCall, callTime, listOf };
