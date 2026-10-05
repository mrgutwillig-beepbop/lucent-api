// =====================================================
// Enforcement worker
//
// Runs inside the API process on a timer and does the three jobs that used to
// live in n8n:
//   1. NOTIFY    - text the agent as soon as pg_cron assigns them a lead
//   2. ESCALATE  - when the response window passes with no contact, alert the
//                  manager (SMS + email) and mark the lead escalated
//   3. REASSIGN  - if still no contact after the org's reassign window, move
//                  the lead to the next available agent and tell both agents
//
// All I/O goes through an injected `store` and `notifier`, so the logic can be
// tested without Supabase, Twilio or Resend.
// =====================================================

const { isValidPhone, normalizePhone, testPrefix, isTestOrg } = require('./sms');

// Leads older than this are ignored, so old/test data is never acted on.
const LOOKBACK_HOURS = 24;

function leadName(lead) {
  const name = [lead.first_name, lead.last_name].filter(Boolean).join(' ').trim();
  return name || lead.email || lead.phone || 'New lead';
}

function windowMinutes(lead) {
  if (!lead.sla_deadline || !lead.assigned_at) return null;
  const ms = new Date(lead.sla_deadline) - new Date(lead.assigned_at);
  return Math.max(1, Math.round(ms / 60000));
}

// ---------- message builders ----------

function agentAssignmentMessage(lead, callUrl) {
  const mins = windowMinutes(lead);
  const lines = [
    `LUCENT: ${lead.reassign_count > 0 ? 'Lead reassigned to you' : 'New lead assigned to you'}.`,
    `${leadName(lead)}${lead.phone ? ' ' + lead.phone : ''}`,
  ];
  if (lead.source) lines.push(`Source: ${lead.source}`);
  if (mins) lines.push(`Please respond within ${mins} min.`);
  if (callUrl && lead.phone) lines.push(`Tap to call: ${callUrl}`);
  lines.push('Emailed or texted them? Reply 1');
  return testPrefix(lead.organizations?.name) + lines.join('\n');
}

function managerEscalationMessage(lead) {
  const agent = lead.agents?.name || 'The assigned agent';
  const reassignMins = lead.organizations?.reassign_after_minutes;
  const canReassign = (lead.reassign_count || 0) < (lead.organizations?.max_reassignments ?? 0);
  let msg = `LUCENT ALERT: ${agent} has not responded to ${leadName(lead)}` +
    `${lead.phone ? ' (' + lead.phone + ')' : ''}. Response window has passed.`;
  if (canReassign && reassignMins) {
    msg += ` It will be reassigned in ${reassignMins} min if still not contacted.`;
  }
  return testPrefix(lead.organizations?.name) + msg;
}

function previousAgentMessage(lead) {
  return `${testPrefix(lead.organizations?.name)}LUCENT: ${leadName(lead)} has been reassigned to another agent because no response was recorded.`;
}

// ---------- worker ----------

function createEnforcementWorker({ store, notifier, callLinkFor = null, now = () => new Date(), log = console }) {
  const since = () => new Date(now().getTime() - LOOKBACK_HOURS * 3600 * 1000).toISOString();

  async function sms(to, body) {
    if (!isValidPhone(to)) return { sent: false, reason: 'invalid_phone' };
    try {
      return await notifier.sms(normalizePhone(to), body);
    } catch (e) {
      log.error('Enforcement SMS error:', e.message);
      return { sent: false, reason: 'error' };
    }
  }

  // 1. Text agents about newly assigned leads.
  async function notifyAssignments() {
    const leads = await store.listUnnotifiedAssignments(since());
    let count = 0;
    for (const lead of leads) {
      // Claim first so a lead is never texted twice.
      const claimed = await store.claimNotification(lead.id);
      if (!claimed) continue;
      let callUrl = null;
      try { callUrl = callLinkFor ? await callLinkFor(lead) : null; } catch (e) { log.error('Call link error:', e.message); }
      const r = await sms(lead.agents?.phone, agentAssignmentMessage(lead, callUrl));
      if (r.sent) count++;
    }
    return count;
  }

  // 2. Escalate leads whose response window has passed.
  async function escalateOverdue() {
    const leads = await store.listOverdueAssigned(since(), now().toISOString());
    let count = 0;
    for (const lead of leads) {
      const escalationId = await store.escalate(lead.id);
      if (!escalationId) continue; // already contacted or escalated meanwhile
      count++;
      const org = lead.organizations || {};
      await sms(org.primary_contact_phone, managerEscalationMessage(lead));
      if (org.primary_contact_email) {
        try {
          await notifier.email(org.primary_contact_email, lead);
        } catch (e) {
          log.error('Enforcement email error:', e.message);
        }
      }
    }
    return count;
  }

  // 3. Reassign escalated leads that are still not contacted.
  async function reassignStale() {
    const leads = await store.listEscalatedUncontacted(since());
    const t = now().getTime();
    let count = 0;
    for (const lead of leads) {
      const org = lead.organizations || {};
      const max = org.max_reassignments ?? 0;
      const after = org.reassign_after_minutes ?? 0;
      if ((lead.reassign_count || 0) >= max) continue;
      if (!lead.last_escalation_at) continue;
      if (t < new Date(lead.last_escalation_at).getTime() + after * 60000) continue;

      const result = await store.reassign(lead.id);
      if (!result) continue; // no other agent available, or lead changed
      count++;
      // The new agent is texted by notifyAssignments() on the next pass
      // (reassign_lead clears agent_notified_at). Tell the previous agent now.
      await sms(result.previous_agent_phone, previousAgentMessage(lead));
    }
    return count;
  }

  async function tick() {
    const out = { notified: 0, escalated: 0, reassigned: 0 };
    for (const [key, fn] of [['notified', notifyAssignments], ['escalated', escalateOverdue], ['reassigned', reassignStale]]) {
      try {
        out[key] = await fn();
      } catch (e) {
        log.error(`Enforcement ${key} step failed:`, e.message);
      }
    }
    // Run notify again so a lead reassigned this pass is texted right away.
    if (out.reassigned) {
      try { out.notified += await notifyAssignments(); } catch (e) { log.error(e.message); }
    }
    return out;
  }

  function start(intervalMs = 30000) {
    let running = false;
    const run = async () => {
      if (running) return;
      running = true;
      try {
        const r = await tick();
        if (r.notified || r.escalated || r.reassigned) log.log('Enforcement pass:', JSON.stringify(r));
      } finally {
        running = false;
      }
    };
    run();
    return setInterval(run, intervalMs);
  }

  return { tick, start, notifyAssignments, escalateOverdue, reassignStale };
}

// ---------- Supabase-backed store ----------

const LEAD_FIELDS = `
  id, first_name, last_name, email, phone, source, lead_temperature, status,
  assigned_to, assigned_at, sla_deadline, first_contact_at, escalation_count,
  last_escalation_at, reassign_count,
  agents ( name, phone ),
  organizations ( name, primary_contact_name, primary_contact_email,
                  primary_contact_phone, reassign_after_minutes, max_reassignments )
`;

function createSupabaseStore(supabase) {
  const must = ({ data, error }) => {
    if (error) throw new Error(error.message);
    return data;
  };

  return {
    async listUnnotifiedAssignments(since) {
      return must(await supabase.from('leads').select(LEAD_FIELDS)
        .eq('status', 'assigned').is('agent_notified_at', null)
        .is('first_contact_at', null).gte('assigned_at', since)) || [];
    },
    async claimNotification(id) {
      const data = must(await supabase.from('leads')
        .update({ agent_notified_at: new Date().toISOString() })
        .eq('id', id).is('agent_notified_at', null).select('id'));
      return Array.isArray(data) && data.length > 0;
    },
    async listOverdueAssigned(since, nowIso) {
      return must(await supabase.from('leads').select(LEAD_FIELDS)
        .eq('status', 'assigned').is('first_contact_at', null)
        .lt('sla_deadline', nowIso).gte('assigned_at', since)) || [];
    },
    async escalate(id) {
      return must(await supabase.rpc('enforce_escalate', { p_lead_id: id }));
    },
    async listEscalatedUncontacted(since) {
      return must(await supabase.from('leads').select(LEAD_FIELDS)
        .eq('status', 'escalated').is('first_contact_at', null)
        .gte('assigned_at', since)) || [];
    },
    async reassign(id) {
      const data = must(await supabase.rpc('reassign_lead', { p_lead_id: id }));
      return Array.isArray(data) ? data[0] || null : data;
    },
  };
}

// ---------- notifier ----------

function escalationEmailHtml(lead) {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const row = (k, v) => `<tr><td style="padding:6px 12px 6px 0;font-weight:600;">${k}</td><td style="padding:6px 0;">${esc(v)}</td></tr>`;
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:600px;">
    <h2 style="color:#dc2626;">Lead response window missed</h2>
    <p>${esc(lead.agents?.name || 'The assigned agent')} has not contacted this lead within the response window.</p>
    <table style="border-collapse:collapse;">
      ${row('Lead', leadName(lead))}
      ${row('Phone', lead.phone || 'N/A')}
      ${row('Email', lead.email || 'N/A')}
      ${row('Source', lead.source || 'N/A')}
      ${row('Assigned agent', lead.agents?.name || 'N/A')}
      ${row('Deadline', lead.sla_deadline ? new Date(lead.sla_deadline).toUTCString() : 'N/A')}
    </table>
    <p style="color:#6b7280;font-size:12px;margin-top:24px;">Automated alert from Lucent Partners.</p>
  </div>`;
}

function createNotifier({ twilioClient, fromNumber, mailer, fromEmail }) {
  return {
    async sms(to, body) {
      if (!twilioClient || !fromNumber) return { sent: false, reason: 'twilio_not_configured' };
      const m = await twilioClient.messages.create({ to, from: fromNumber, body });
      return { sent: true, sid: m.sid };
    },
    async email(to, lead) {
      if (!mailer || !fromEmail) return;
      const test = isTestOrg(lead.organizations?.name) ? '[TEST] ' : '';
      await mailer.send({
        to,
        from: fromEmail,
        subject: `${test}Lead not contacted: ${leadName(lead)}`,
        html: escalationEmailHtml(lead),
      });
    },
  };
}

module.exports = {
  createEnforcementWorker,
  createSupabaseStore,
  createNotifier,
  agentAssignmentMessage,
  managerEscalationMessage,
  previousAgentMessage,
  leadName,
};
