// =====================================================
// Tap-to-call
//
// The agent's lead text includes a link. Tapping it opens a page with a
// "Call now" button. Pressing it makes Lucent ring the agent's phone; when
// the agent answers and presses 1, Lucent dials the lead and connects them.
//
// Because the call goes through Lucent, we know exactly when the agent tried
// to reach the lead — no CRM logging, no honour system. The moment the agent
// presses 1 (we start ringing the lead) counts as the response. Calls are
// never recorded; we only keep the time, outcome and duration.
//
// Flow:
//   GET  /c/:code                  page with a Call button (safe for link previews)
//   POST /c/:code                  rings the agent
//   POST /twilio/voice/connect/:code  agent answered -> "press 1"
//   POST /twilio/voice/dial/:code     agent pressed 1 -> mark responded, dial lead
//   POST /twilio/voice/done/:code     call ended -> log outcome and duration
// =====================================================

const crypto = require('crypto');
const express = require('express');

// ---------- link codes ----------
// code = 22-char lead id + 12-char signature over (lead id, current agent id).
// Stateless, and a link stops working once the lead is reassigned.

const ID_LEN = 22;
const SIG_LEN = 12;

function uuidToShort(uuid) {
  return Buffer.from(String(uuid).replace(/-/g, ''), 'hex').toString('base64url');
}

function shortToUuid(short) {
  const hex = Buffer.from(short, 'base64url').toString('hex');
  if (hex.length !== 32) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sign(secret, leadId, agentId) {
  return crypto.createHmac('sha256', secret).update(`${leadId}:${agentId}`).digest('base64url').slice(0, SIG_LEN);
}

function makeCallCode(secret, leadId, agentId) {
  return uuidToShort(leadId) + sign(secret, leadId, agentId);
}

function parseCallCode(code) {
  if (typeof code !== 'string' || code.length !== ID_LEN + SIG_LEN || !/^[A-Za-z0-9_-]+$/.test(code)) return null;
  const leadId = shortToUuid(code.slice(0, ID_LEN));
  return leadId ? { leadId, sig: code.slice(ID_LEN) } : null;
}

function codeMatches(secret, code, leadId, agentId) {
  const parsed = parseCallCode(code);
  if (!parsed || parsed.leadId !== leadId || !agentId) return false;
  const expected = Buffer.from(sign(secret, leadId, agentId));
  const given = Buffer.from(parsed.sig);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

// ---------- pages ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#111827;--muted:#6b7280;--accent:#0f766e;--accent-ink:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#0b0f14;--card:#151b23;--ink:#e5e7eb;--muted:#9ca3af;--accent:#14b8a6;--accent-ink:#04201d}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px}
.card{background:var(--card);border-radius:16px;padding:28px 22px;max-width:380px;width:100%;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.08)}
h1{font-size:22px;margin:0 0 6px}p{color:var(--muted);margin:6px 0}
button{margin-top:20px;width:100%;padding:16px;border:0;border-radius:12px;background:var(--accent);color:var(--accent-ink);font-size:18px;font-weight:600}
.brand{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-bottom:14px}
</style></head><body><div class="card"><div class="brand">Lucent</div>${body}</div></body></html>`;
}

function leadName(lead) {
  return [lead.first_name, lead.last_name].filter(Boolean).join(' ').trim() || 'your lead';
}

const OPEN_STATUSES = new Set(['assigned', 'escalated', 'contacted']);
const LINK_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

// ---------- store (Supabase) ----------

function createCallStore(supabase) {
  return {
    async getLead(leadId) {
      const { data, error } = await supabase.from('leads')
        .select('id, org_id, first_name, last_name, phone, status, assigned_to, assigned_at, first_contact_at, agents ( name, phone ), organizations ( name )')
        .eq('id', leadId).maybeSingle();
      if (error) throw new Error(error.message);
      return data;
    },
    async markContacted(leadId) {
      const { error } = await supabase.rpc('mark_lead_contacted', { p_lead_id: leadId });
      if (error) throw new Error(error.message);
    },
    async logEvent(lead, eventType, eventData) {
      const { error } = await supabase.from('lead_events').insert({
        lead_id: lead.id, org_id: lead.org_id, event_type: eventType, event_data: eventData,
      });
      if (error) throw new Error(error.message);
    },
  };
}

// ---------- router ----------

function createCallBridge({ store, twilioClient, fromNumber, baseUrl, secret, validateTwilio, log = console, now = () => new Date() }) {
  const router = express.Router();
  const form = express.urlencoded({ extended: false });
  const base = String(baseUrl || '').replace(/\/+$/, '');

  // Loads the lead behind a code and checks the link is still valid for the
  // lead's current agent. Returns { lead } or { error: <page html> }.
  async function resolve(code) {
    const parsed = parseCallCode(code);
    if (!parsed) return { error: page('Link not valid', '<h1>Link not valid</h1><p>Please use the link from your latest Lucent text.</p>') };
    const lead = await store.getLead(parsed.leadId);
    if (!lead || !codeMatches(secret, code, lead.id, lead.assigned_to)) {
      return { error: page('Lead reassigned', '<h1>This lead has moved</h1><p>It was reassigned to another agent, so this link no longer works.</p>') };
    }
    if (!OPEN_STATUSES.has(lead.status) || (lead.assigned_at && now() - new Date(lead.assigned_at) > LINK_MAX_AGE_MS)) {
      return { error: page('Link expired', '<h1>Link expired</h1><p>This lead is closed or the link is more than 7 days old.</p>') };
    }
    if (!lead.phone) return { error: page('No phone number', `<h1>No phone number</h1><p>${esc(leadName(lead))} didn't leave a phone number.</p>`) };
    return { lead };
  }

  // Twilio webhooks must carry a valid signature for the exact public URL.
  function twilioOnly(req, res, next) {
    if (!validateTwilio) return next();
    const ok = validateTwilio(req.get('X-Twilio-Signature') || '', base + req.originalUrl, req.body || {});
    if (ok) return next();
    log.error('Rejected Twilio webhook with bad signature:', req.originalUrl.split('/').slice(0, 4).join('/'));
    return res.status(403).send('Forbidden');
  }

  const twiml = (res, xml) => res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response>${xml}</Response>`);
  const xmlEsc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

  // Page with a button. GET never places a call, so message-app link
  // previews can't trigger one by accident.
  router.get('/c/:code', async (req, res) => {
    try {
      const { lead, error } = await resolve(req.params.code);
      if (error) return res.status(410).send(error);
      res.send(page(`Call ${leadName(lead)}`,
        `<h1>Call ${esc(leadName(lead))}</h1>
         <p>Lucent will ring your phone. Answer and press 1 to connect.</p>
         <form method="post"><button type="submit">Call now</button></form>`));
    } catch (e) {
      log.error('Call page error:', e.message);
      res.status(500).send(page('Error', '<h1>Something went wrong</h1><p>Please call the lead directly.</p>'));
    }
  });

  // Ring the agent.
  router.post('/c/:code', async (req, res) => {
    try {
      const { lead, error } = await resolve(req.params.code);
      if (error) return res.status(410).send(error);
      if (!twilioClient || !fromNumber || !lead.agents?.phone) {
        return res.status(503).send(page('Calling unavailable', '<h1>Calling unavailable</h1><p>Please call the lead directly.</p>'));
      }
      const code = req.params.code;
      await twilioClient.calls.create({
        to: lead.agents.phone,
        from: fromNumber,
        url: `${base}/twilio/voice/connect/${code}`,
        timeout: 25,
      });
      await store.logEvent(lead, 'call_requested', { channel: 'tap_to_call' }).catch((e) => log.error('Call log error:', e.message));
      res.send(page('Calling you', `<h1>Calling you now</h1><p>Answer your phone and press 1 to connect with ${esc(leadName(lead))}.</p>`));
    } catch (e) {
      log.error('Call start error:', e.message);
      res.status(500).send(page('Error', '<h1>Could not start the call</h1><p>Please call the lead directly.</p>'));
    }
  });

  // Agent answered: make sure it's a person, not voicemail.
  router.post('/twilio/voice/connect/:code', form, twilioOnly, async (req, res) => {
    const { lead } = await resolve(req.params.code).catch(() => ({}));
    if (!lead) return twiml(res, '<Say>This lead is no longer available. Goodbye.</Say><Hangup/>');
    twiml(res,
      `<Gather numDigits="1" timeout="8" action="${xmlEsc(`${base}/twilio/voice/dial/${req.params.code}`)}">` +
      `<Say>Lucent. Press 1 to call ${xmlEsc(leadName(lead))}.</Say></Gather>` +
      '<Say>No key pressed. Goodbye.</Say><Hangup/>');
  });

  // Agent pressed 1: this is the response. Record it, then dial the lead.
  router.post('/twilio/voice/dial/:code', form, twilioOnly, async (req, res) => {
    const { lead } = await resolve(req.params.code).catch(() => ({}));
    if (!lead) return twiml(res, '<Say>This lead is no longer available. Goodbye.</Say><Hangup/>');
    if (req.body?.Digits !== '1') return twiml(res, '<Say>Goodbye.</Say><Hangup/>');

    try {
      if (!lead.first_contact_at && (lead.status === 'assigned' || lead.status === 'escalated')) {
        await store.markContacted(lead.id);
      }
      await store.logEvent(lead, 'call_started', { channel: 'tap_to_call', call_sid: req.body?.CallSid || null });
    } catch (e) {
      log.error('Call response record error:', e.message); // still connect the call
    }

    twiml(res,
      `<Say>Connecting.</Say><Dial callerId="${xmlEsc(fromNumber)}" timeout="25" action="${xmlEsc(`${base}/twilio/voice/done/${req.params.code}`)}">` +
      `<Number>${xmlEsc(lead.phone)}</Number></Dial>`);
  });

  // Call ended: keep the outcome for reporting.
  router.post('/twilio/voice/done/:code', form, twilioOnly, async (req, res) => {
    try {
      const parsed = parseCallCode(req.params.code);
      const lead = parsed && await store.getLead(parsed.leadId);
      if (lead) {
        await store.logEvent(lead, 'call_ended', {
          channel: 'tap_to_call',
          outcome: req.body?.DialCallStatus || 'unknown', // completed, no-answer, busy, failed
          duration_seconds: Number(req.body?.DialCallDuration) || 0,
        });
      }
    } catch (e) {
      log.error('Call end log error:', e.message);
    }
    twiml(res, '<Hangup/>');
  });

  return router;
}

module.exports = { createCallBridge, createCallStore, makeCallCode, parseCallCode, codeMatches };
