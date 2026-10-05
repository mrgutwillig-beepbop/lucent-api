// =====================================================
// "Reply 1" confirmations
//
// For agents who reach a lead by email or text (which Lucent can't see), the
// lead text says "Emailed or texted them? Reply 1". When the agent replies,
// Twilio posts the message here; we find the agent's most recent open lead,
// mark it responded, and confirm back by text.
//
// Replies are logged as self-reported (channel: sms_reply), separate from
// tap-to-call, which is verified by the call itself.
//
// Twilio setup: the Lucent number's "A message comes in" webhook must point
// to  POST {PUBLIC_BASE_URL}/twilio/sms
// =====================================================

const express = require('express');
const { normalizePhone, isValidPhone, testPrefix } = require('./sms');

const CONFIRM_WORDS = new Set(['1', 'done', 'yes', 'y', 'contacted']);
const LOOKBACK_MS = 24 * 3600 * 1000;

function leadName(lead) {
  return [lead.first_name, lead.last_name].filter(Boolean).join(' ').trim() || 'your lead';
}

function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return r ? `${m}m ${r}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// ---------- store (Supabase) ----------

function createReplyStore(supabase) {
  const must = ({ data, error }) => {
    if (error) throw new Error(error.message);
    return data;
  };
  return {
    // All agent ids registered with this phone number.
    async agentIdsByPhone(phone) {
      const rows = must(await supabase.from('agents').select('id').eq('phone', phone)) || [];
      return rows.map((r) => r.id);
    },
    // The agent's most recently assigned lead that still needs a response.
    async latestOpenLead(agentIds, sinceIso) {
      if (!agentIds.length) return null;
      const rows = must(await supabase.from('leads')
        .select('id, org_id, first_name, last_name, status, assigned_at, organizations ( name )')
        .in('assigned_to', agentIds)
        .in('status', ['assigned', 'escalated'])
        .is('first_contact_at', null)
        .gte('assigned_at', sinceIso)
        .order('assigned_at', { ascending: false })
        .limit(1)) || [];
      return rows[0] || null;
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

// ---------- router ----------

function createReplyHandler({ store, baseUrl, validateTwilio, log = console, now = () => new Date() }) {
  const router = express.Router();
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const xmlEsc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
  const reply = (res, text) => res.type('text/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?><Response>${text ? `<Message>${xmlEsc(text)}</Message>` : ''}</Response>`);

  router.post('/twilio/sms', express.urlencoded({ extended: false }), async (req, res) => {
    if (validateTwilio && !validateTwilio(req.get('X-Twilio-Signature') || '', base + req.originalUrl, req.body || {})) {
      log.error('Rejected SMS webhook with bad signature');
      return res.status(403).send('Forbidden');
    }

    const from = req.body?.From;
    const body = String(req.body?.Body || '').trim().toLowerCase().replace(/[.!]+$/, '');
    try {
      if (!isValidPhone(from)) return reply(res, null);
      const agentIds = await store.agentIdsByPhone(normalizePhone(from));

      // Not an agent (e.g. a lead replying to the intake text): stay silent.
      if (!agentIds.length) return reply(res, null);

      // Twilio handles STOP/HELP keywords itself; don't answer those.
      if (/^(stop|stopall|unsubscribe|cancel|end|quit|start|unstop|help|info)$/.test(body)) return reply(res, null);

      if (!CONFIRM_WORDS.has(body)) {
        return reply(res, 'LUCENT: Reply 1 once you have emailed or texted your newest lead. To call, use the link in the lead text.');
      }

      const lead = await store.latestOpenLead(agentIds, new Date(now() - LOOKBACK_MS).toISOString());
      if (!lead) return reply(res, 'LUCENT: You have no leads waiting for a response.');

      await store.markContacted(lead.id);
      await store.logEvent(lead, 'contact_confirmed', { channel: 'sms_reply', self_reported: true })
        .catch((e) => log.error('Reply log error:', e.message));

      const took = lead.assigned_at ? ` Response time: ${formatDuration((now() - new Date(lead.assigned_at)) / 1000)}.` : '';
      return reply(res, `${testPrefix(lead.organizations?.name)}LUCENT: Got it. ${leadName(lead)} marked as contacted.${took}`);
    } catch (e) {
      log.error('SMS reply error:', e.message);
      return reply(res, 'LUCENT: Sorry, we could not record that. Please try again in a minute.');
    }
  });

  return router;
}

module.exports = { createReplyHandler, createReplyStore, formatDuration };
