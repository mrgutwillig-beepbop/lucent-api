// =====================================================
// Follow Up Boss response detection
//
// When an agent calls, texts or emails a lead from inside Follow Up Boss,
// FUB sends a webhook (callsCreated / textMessagesCreated / emailsCreated).
// We fetch that activity, keep it only if it's OUTGOING, match the FUB contact
// to an open Lucent lead by phone or email, and mark the lead responded
// (logged as verified, channel fub_call / fub_text / fub_email).
//
// Setup (Railway variables):
//   FUB_API_KEY     API key from the account owner (Admin -> API)
//   FUB_SYSTEM_KEY  System Key from the FUB system registration
//   FUB_SYSTEM      registered System ID (default: LucentPartners)
//   FUB_ORG_ID      the Lucent organization this FUB account belongs to
// On startup the API registers its webhooks in FUB if they're missing.
// =====================================================

const crypto = require('crypto');
const express = require('express');

const FUB_BASE = 'https://api.followupboss.com/v1';
const WEBHOOK_PATH = '/crm/fub/webhook';
const EVENTS = {
  callsCreated: { resource: 'calls', channel: 'fub_call' },
  textMessagesCreated: { resource: 'textMessages', channel: 'fub_text' },
  emailsCreated: { resource: 'emails', channel: 'fub_email' },
};
const LOOKBACK_MS = 24 * 3600 * 1000;

// ---------- helpers ----------

const last10 = (phone) => String(phone || '').replace(/\D/g, '').slice(-10);
const normEmail = (e) => String(e || '').trim().toLowerCase();

// FUB signs webhooks: HMAC-SHA256( base64(raw body), system key ), hex.
function verifySignature(rawBody, signature, systemKey) {
  if (!systemKey || !signature) return false;
  const expected = crypto.createHmac('sha256', systemKey)
    .update(Buffer.from(rawBody).toString('base64')).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature).trim().toLowerCase());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Is this activity the agent reaching out (not the lead writing in)?
// FUB uses isIncoming on calls/texts; emails may use isIncoming or a direction.
function isOutgoing(activity) {
  if (!activity) return false;
  if (typeof activity.isIncoming === 'boolean') return !activity.isIncoming;
  if (typeof activity.isInbound === 'boolean') return !activity.isInbound;
  const dir = String(activity.direction || activity.type || '').toLowerCase();
  if (dir.includes('out') || dir === 'sent') return true;
  if (dir.includes('in') || dir === 'received') return false;
  return false; // unknown direction: don't count it
}

// Phone numbers and emails on a FUB person.
function contactPoints(person) {
  const phones = (person?.phones || []).map((p) => last10(p.value ?? p)).filter((p) => p.length === 10);
  const emails = (person?.emails || []).map((e) => normEmail(e.value ?? e)).filter(Boolean);
  return { phones, emails };
}

// ---------- email helpers ----------
// FUB emails have no personId / isIncoming. The contact comes from
// relatedPeople, and direction from the addresses (from / to / cc / bcc).

function relatedPersonIds(email) {
  return relatedPeople(email).map((p) => p.id);
}

// [{ id, sentByPerson }] — FUB marks each related person with sentByPerson
// (true = the contact sent this email, false = it was sent to them).
function relatedPeople(email) {
  const list = Array.isArray(email?.relatedPeople) ? email.relatedPeople : [];
  const out = new Map();
  for (const p of list) {
    const id = typeof p === 'object' && p ? (p.personId ?? p.id) : p;
    if (!id || out.has(id)) continue;
    out.set(id, { id, sentByPerson: typeof p === 'object' && p ? p.sentByPerson : undefined });
  }
  return [...out.values()];
}

// Pulls email addresses out of a value that may be a string, an object
// ({email}, {address}, {value}) or an array of those.
function collectEmails(v) {
  if (!v) return [];
  if (typeof v === 'string') return (v.match(/[^\s<>,;"]+@[^\s<>,;"]+/g) || []).map(normEmail);
  if (Array.isArray(v)) return v.flatMap(collectEmails);
  if (typeof v === 'object') return collectEmails(v.email ?? v.address ?? v.value ?? '');
  return [];
}

// Splits FUB 'addresses' into senders and recipients. Handles an object keyed
// by role ({from, to, cc, bcc}) or a list of {type/role, email} entries.
function emailRoles(addresses) {
  const from = [];
  const to = [];
  if (Array.isArray(addresses)) {
    for (const a of addresses) {
      const role = String(a?.type ?? a?.role ?? a?.kind ?? '').toLowerCase();
      (role === 'from' || role === 'sender' ? from : to).push(...collectEmails(a));
    }
  } else if (addresses && typeof addresses === 'object') {
    for (const [key, val] of Object.entries(addresses)) {
      const role = key.toLowerCase();
      if (role === 'from' || role === 'sender' || role === 'replyto') from.push(...collectEmails(val));
      else to.push(...collectEmails(val));
    }
  }
  return { from, to };
}

function emailSentTo(email, contactEmails) {
  const { from, to } = emailRoles(email?.addresses);
  if (contactEmails.some((e) => from.includes(e))) return false; // the lead wrote in
  return contactEmails.some((e) => to.includes(e));
}

// Structure only (types and keys), never values: safe to log.
function describeShape(email) {
  const shape = (v) => (Array.isArray(v) ? `array(${v.length})[${v.length ? shape(v[0]) : ''}]`
    : v && typeof v === 'object' ? `{${Object.keys(v).join(',')}}` : typeof v);
  const to = email?.addresses?.to;
  return `addresses=${shape(email?.addresses)} to=${shape(to)} relatedPeople=${shape(email?.relatedPeople)}`;
}

// ---------- FUB API client ----------

function createFubClient({ apiKey, systemName, systemKey, fetchImpl = globalThis.fetch }) {
  const headers = {
    Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`,
    'X-System': systemName,
    'X-System-Key': systemKey,
    'Content-Type': 'application/json',
  };
  async function call(method, path, body) {
    const url = path.startsWith('http') ? path : `${FUB_BASE}${path}`;
    const res = await fetchImpl(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`FUB ${method} ${url.replace(FUB_BASE, '')} -> ${res.status}: ${json.errorMessage || json.message || 'error'}`);
    return json;
  }
  return {
    get: (path) => call('GET', path),
    listWebhooks: () => call('GET', '/webhooks?limit=100'),
    createWebhook: (event, url) => call('POST', '/webhooks', { event, url }),
  };
}

// Registers any of our webhooks that aren't already in the FUB account.
async function ensureWebhooks({ client, url, log = console }) {
  const existing = await client.listWebhooks();
  const have = new Set((existing.webhooks || []).filter((w) => w.url === url && w.status !== 'Disabled').map((w) => w.event));
  const created = [];
  for (const event of Object.keys(EVENTS)) {
    if (have.has(event)) continue;
    await client.createWebhook(event, url);
    created.push(event);
  }
  if (created.length) log.log('FUB webhooks registered:', created.join(', '));
  return created;
}

// ---------- store (Supabase) ----------

function createFubStore(supabase) {
  const must = ({ data, error }) => {
    if (error) throw new Error(error.message);
    return data;
  };
  return {
    // Open leads in the org that still need a response.
    async openLeads(orgId, sinceIso) {
      return must(await supabase.from('leads')
        .select('id, org_id, first_name, last_name, phone, email, status, assigned_at')
        .eq('org_id', orgId)
        .in('status', ['assigned', 'escalated'])
        .is('first_contact_at', null)
        .gte('assigned_at', sinceIso)
        .order('assigned_at', { ascending: false })) || [];
    },
    async markContacted(leadId) {
      must(await supabase.rpc('mark_lead_contacted', { p_lead_id: leadId }));
    },
    async logEvent(lead, eventType, eventData) {
      must(await supabase.from('lead_events').insert({
        lead_id: lead.id, org_id: lead.org_id, event_type: eventType, event_data: eventData,
      }));
    },
  };
}

// ---------- processing ----------

function createFubProcessor({ client, store, orgId, log = console, now = () => new Date() }) {
  const seenShapes = new Set();
  // Handles one webhook payload; returns the ids of leads marked responded.
  return async function processWebhook(payload) {
    const spec = EVENTS[payload?.event];
    if (!spec) return [];
    const marked = [];
    for (const id of payload.resourceIds || []) {
      const activity = await client.get(`/${spec.resource}/${id}`);
      if (!seenShapes.has(spec.resource)) {
        // First time we see each kind: log field names and shapes (no content).
        seenShapes.add(spec.resource);
        log.log(`FUB ${spec.resource} fields:`, Object.keys(activity || {}).join(','));
        if (spec.resource === 'emails') log.log('FUB emails shape:', describeShape(activity));
      }
      const isEmail = spec.resource === 'emails';
      // Calls/texts carry direction and the contact directly; emails don't.
      if (!isEmail && !isOutgoing(activity)) continue;
      const people = isEmail ? relatedPeople(activity) : [{ id: activity.personId }].filter((p) => p.id);

      for (const { id: personId, sentByPerson } of people) {
        // Email from the contact (they wrote in) never counts.
        if (isEmail && sentByPerson === true) continue;
        const person = await client.get(`/people/${personId}`);
        const { phones, emails } = contactPoints(person);
        if (!phones.length && !emails.length) continue;
        // Without the sentByPerson flag, fall back to the addresses.
        if (isEmail && sentByPerson !== false && !emailSentTo(activity, emails)) continue;

        const activityAt = activity.created ? new Date(activity.created) : now();
        const leads = await store.openLeads(orgId, new Date(now() - LOOKBACK_MS).toISOString());
        const lead = leads.find((l) =>
          (l.phone && phones.includes(last10(l.phone))) || (l.email && emails.includes(normEmail(l.email))));
        if (!lead || marked.includes(lead.id)) continue;
        // Only count outreach that happened after the lead was assigned.
        if (lead.assigned_at && activityAt < new Date(lead.assigned_at)) continue;

        await store.markContacted(lead.id);
        await store.logEvent(lead, 'contact_detected', {
          channel: spec.channel,
          verified: true,
          source: 'follow_up_boss',
          fub_id: id,
          fub_user_id: activity.userId ?? null,
          outcome: activity.outcome ?? null,
          duration_seconds: activity.duration ?? null,
        }).catch((e) => log.error('FUB log error:', e.message));
        marked.push(lead.id);
        log.log(`FUB ${spec.channel} marked lead ${lead.id} responded`);
      }
    }
    return marked;
  };
}

// ---------- webhook route ----------

function createFubWebhookHandler({ processWebhook, systemKey, log = console }) {
  const router = express.Router();
  router.post(WEBHOOK_PATH, express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
    const raw = req.body instanceof Buffer ? req.body : Buffer.from('');
    if (!verifySignature(raw, req.get('FUB-Signature'), systemKey)) {
      log.error('Rejected FUB webhook with bad signature');
      return res.status(401).send('Unauthorized');
    }
    let payload;
    try { payload = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).send('Bad JSON'); }

    // FUB needs a 2xx within 10 seconds, so acknowledge first, then work.
    res.status(200).send('ok');
    processWebhook(payload).catch((e) => log.error('FUB webhook processing error:', e.message));
  });
  return router;
}

module.exports = {
  WEBHOOK_PATH,
  EVENTS,
  verifySignature,
  isOutgoing,
  contactPoints,
  relatedPersonIds,
  relatedPeople,
  emailRoles,
  emailSentTo,
  createFubClient,
  ensureWebhooks,
  createFubStore,
  createFubProcessor,
  createFubWebhookHandler,
};
