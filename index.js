require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { createMailer, resolveResendKey } = require('./mailer');
const { createCallBridge, createCallStore, createCallLink } = require('./callbridge');
const { createReplyHandler, createReplyStore } = require('./replies');
const twilio = require('twilio');
const { isValidPhone, sendIntakeSms } = require('./sms');

// =====================================================
// APP FACTORY
// Dependencies are injected so the routes can be exercised in tests
// with mock Supabase / Twilio clients (see test/intake.test.js).
// =====================================================

function createApp({ supabase, twilioClient = null, twilioFromNumber = null, mailer = null, fromEmail = null, callBridge = null, replyHandler = null } = {}) {
  const app = express();

  // Agents' "Reply 1" texts (Twilio inbound SMS webhook).
  if (replyHandler) app.use(replyHandler);

  // Tap-to-call pages and Twilio voice webhooks (no API key; secured by
  // signed links and Twilio request signatures).
  if (callBridge) app.use(callBridge);

  // Middleware
  app.use(cors());
  app.use(express.json());

  // Simple API key authentication
  const authenticateRequest = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];

    if (!apiKey || apiKey !== process.env.API_SECRET_KEY) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    next();
  };

  // =====================================================
  // ROUTES
  // =====================================================

  // Health check
  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      email_provider: 'Resend',
      sms_provider: twilioClient ? 'Twilio' : 'disabled'
    });
  });

  // =====================================================
  // POST /api/leads/intake
  // =====================================================

  app.post('/api/leads/intake', authenticateRequest, async (req, res) => {
    try {
      const {
        org_id,
        first_name,
        last_name,
        email,
        phone,
        source,
        lead_temperature = 'warm',
        crm_contact_id
      } = req.body;

      if (!org_id) {
        return res.status(400).json({ error: 'org_id is required' });
      }

      if (!email && !phone) {
        return res.status(400).json({ error: 'Either email or phone is required' });
      }

      const { data: lead, error } = await supabase
        .from('leads')
        .insert({
          org_id,
          first_name,
          last_name,
          email,
          phone,
          source: source || 'unknown',
          lead_temperature,
          crm_contact_id,
          status: 'pending_assignment',
          raw_payload: req.body
        })
        .select()
        .single();

      if (error) {
        console.error('Error creating lead:', error);
        return res.status(500).json({ error: 'Failed to create lead', details: error.message });
      }

      await supabase.from('lead_events').insert({
        lead_id: lead.id,
        org_id: lead.org_id,
        event_type: 'created',
        event_data: { source: lead.source }
      });

      // -------------------------------------------------
      // Automatic intake confirmation SMS (best-effort).
      // Only sent when the lead has a valid phone number. A failure here
      // must never fail the intake request.
      // -------------------------------------------------
      let smsResult = { sent: false, reason: 'invalid_phone' };
      if (isValidPhone(lead.phone)) {
        try {
          // Pull the org name for the message body.
          const { data: org, error: orgError } = await supabase
            .from('organizations')
            .select('name')
            .eq('id', lead.org_id)
            .single();

          if (orgError) {
            console.error('Intake SMS: failed to load org name:', orgError.message);
          }

          smsResult = await sendIntakeSms({
            twilioClient,
            fromNumber: twilioFromNumber,
            phone: lead.phone,
            orgName: org?.name
          });

          if (smsResult.sent) {
            console.log(`Intake SMS sent for lead ${lead.id} (sid: ${smsResult.sid})`);
          } else {
            console.log(`Intake SMS not sent for lead ${lead.id}: ${smsResult.reason}`);
          }
        } catch (smsError) {
          console.error('Intake SMS error:', smsError.message);
          smsResult = { sent: false, reason: 'error' };
          // Do not fail the intake if the SMS fails.
        }
      }

      res.status(201).json({
        success: true,
        lead_id: lead.id,
        status: 'pending_assignment',
        sms_sent: smsResult.sent
      });

    } catch (error) {
      console.error('Intake error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // =====================================================
  // POST /api/leads/:id/assign
  // =====================================================

  app.post('/api/leads/:id/assign', authenticateRequest, async (req, res) => {
    try {
      const { id: leadId } = req.params;

      const { data, error } = await supabase
        .rpc('assign_lead_to_next_agent', { p_lead_id: leadId });

      if (error) {
        console.error('Assignment error:', error);
        return res.status(500).json({ error: 'Failed to assign lead', details: error.message });
      }

      if (!data || data.length === 0) {
        return res.status(404).json({ error: 'Lead not found or no available agents' });
      }

      const assignment = data[0];

      res.json({
        success: true,
        lead_id: leadId,
        assigned_to: {
          agent_id: assignment.assigned_agent_id,
          agent_name: assignment.assigned_agent_name,
          agent_phone: assignment.assigned_agent_phone
        },
        sla_deadline: assignment.sla_deadline
      });

    } catch (error) {
      console.error('Assign error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // =====================================================
  // POST /api/leads/:id/contacted
  // =====================================================

  app.post('/api/leads/:id/contacted', authenticateRequest, async (req, res) => {
    try {
      const { id: leadId } = req.params;

      const { data, error } = await supabase
        .rpc('mark_lead_contacted', { p_lead_id: leadId });

      if (error) {
        console.error('Contact mark error:', error);
        return res.status(500).json({ error: 'Failed to mark as contacted', details: error.message });
      }

      res.json({
        success: true,
        lead_id: leadId,
        status: 'contacted',
        contacted_at: new Date().toISOString()
      });

    } catch (error) {
      console.error('Contacted error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // =====================================================
  // GET /api/organizations/:org_id/overdue-leads
  // =====================================================

  app.get('/api/organizations/:org_id/overdue-leads', authenticateRequest, async (req, res) => {
    try {
      const { org_id } = req.params;

      const { data, error } = await supabase
        .rpc('get_overdue_leads', { p_org_id: org_id });

      if (error) {
        console.error('Overdue leads error:', error);
        return res.status(500).json({ error: 'Failed to get overdue leads', details: error.message });
      }

      res.json({
        success: true,
        org_id,
        overdue_count: data.length,
        leads: data
      });

    } catch (error) {
      console.error('Overdue error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // =====================================================
  // POST /api/leads/:id/escalate
  // =====================================================

  app.post('/api/leads/:id/escalate', authenticateRequest, async (req, res) => {
    try {
      const { id: leadId } = req.params;
      const { tier = 1, send_email = true } = req.body;

      // Escalate in database
      const { data: escalationId, error } = await supabase
        .rpc('escalate_lead', {
          p_lead_id: leadId,
          p_tier: tier
        });

      if (error) {
        console.error('Escalation error:', error);
        return res.status(500).json({ error: 'Failed to escalate lead', details: error.message });
      }

      // Get lead and org details for email
      const { data: leadData } = await supabase
        .from('leads')
        .select(`
          *,
          agents (name, phone),
          organizations (name, primary_contact_email)
        `)
        .eq('id', leadId)
        .single();

      // Send email notification if requested
      if (send_email && mailer && leadData && leadData.organizations.primary_contact_email) {
        try {
          const minutesOverdue = Math.floor((new Date() - new Date(leadData.sla_deadline)) / 60000);

          const msg = {
            to: leadData.organizations.primary_contact_email,
            from: fromEmail,
            subject: `⚠️ SLA BREACH - ${leadData.first_name} ${leadData.last_name}`,
            html: `
              <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px;">
                <h2 style="color: #dc2626; margin-bottom: 20px;">⚠️ SLA Breach Alert</h2>

                <div style="background: #fef2f2; border-left: 4px solid #dc2626; padding: 16px; margin-bottom: 20px;">
                  <p style="margin: 0; font-weight: 600; color: #991b1b;">
                    Lead has exceeded response window by ${minutesOverdue} minutes
                  </p>
                </div>

                <h3 style="color: #1e293b; margin-bottom: 12px;">Lead Details:</h3>
                <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
                  <tr style="border-bottom: 1px solid #e2e8f0;">
                    <td style="padding: 8px 0; font-weight: 600;">Name:</td>
                    <td style="padding: 8px 0;">${leadData.first_name} ${leadData.last_name}</td>
                  </tr>
                  <tr style="border-bottom: 1px solid #e2e8f0;">
                    <td style="padding: 8px 0; font-weight: 600;">Phone:</td>
                    <td style="padding: 8px 0;">${leadData.phone || 'N/A'}</td>
                  </tr>
                  <tr style="border-bottom: 1px solid #e2e8f0;">
                    <td style="padding: 8px 0; font-weight: 600;">Email:</td>
                    <td style="padding: 8px 0;">${leadData.email || 'N/A'}</td>
                  </tr>
                  <tr style="border-bottom: 1px solid #e2e8f0;">
                    <td style="padding: 8px 0; font-weight: 600;">Assigned Agent:</td>
                    <td style="padding: 8px 0;">${leadData.agents?.name || 'Unassigned'}</td>
                  </tr>
                  <tr style="border-bottom: 1px solid #e2e8f0;">
                    <td style="padding: 8px 0; font-weight: 600;">Temperature:</td>
                    <td style="padding: 8px 0; text-transform: uppercase; color: ${leadData.lead_temperature === 'hot' ? '#dc2626' : '#d97706'};">
                      ${leadData.lead_temperature}
                    </td>
                  </tr>
                  <tr>
                    <td style="padding: 8px 0; font-weight: 600;">Source:</td>
                    <td style="padding: 8px 0;">${leadData.source}</td>
                  </tr>
                </table>

                <p style="color: #64748b; font-size: 14px; margin-top: 30px; padding-top: 20px; border-top: 1px solid #e2e8f0;">
                  This is an automated alert from Lucent Partners enforcement system.
                </p>
              </div>
            `
          };

          await mailer.send(msg);
          console.log('Escalation email sent for lead:', leadId);
        } catch (emailError) {
          console.error('Email error:', emailError.message);
          // Don't fail the entire escalation if email fails
        }
      }

      res.json({
        success: true,
        lead_id: leadId,
        escalation_id: escalationId,
        tier,
        escalated_at: new Date().toISOString(),
        email_sent: send_email
      });

    } catch (error) {
      console.error('Escalate error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // =====================================================
  // GET /api/organizations/:org_id/stats
  // =====================================================

  app.get('/api/organizations/:org_id/stats', authenticateRequest, async (req, res) => {
    try {
      const { org_id } = req.params;

      const { data: leads, error: leadsError } = await supabase
        .from('leads')
        .select('status')
        .eq('org_id', org_id);

      if (leadsError) throw leadsError;

      const stats = {
        total_leads: leads.length,
        by_status: {
          pending_assignment: leads.filter(l => l.status === 'pending_assignment').length,
          assigned: leads.filter(l => l.status === 'assigned').length,
          contacted: leads.filter(l => l.status === 'contacted').length,
          escalated: leads.filter(l => l.status === 'escalated').length,
          closed: leads.filter(l => l.status === 'closed').length
        }
      };

      const { data: recentLeads, error: responseError } = await supabase
        .from('leads')
        .select('response_time_seconds')
        .eq('org_id', org_id)
        .eq('status', 'contacted')
        .gte('created_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
        .not('response_time_seconds', 'is', null);

      if (!responseError && recentLeads.length > 0) {
        const avgSeconds = recentLeads.reduce((sum, l) => sum + l.response_time_seconds, 0) / recentLeads.length;
        stats.avg_response_time_minutes = Math.round(avgSeconds / 60);
      }

      res.json({
        success: true,
        org_id,
        stats
      });

    } catch (error) {
      console.error('Stats error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return app;
}

// =====================================================
// BOOTSTRAP (only when run directly, not when imported by tests)
// =====================================================

if (require.main === module) {
  // Initialize Supabase client
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  // Configure email (Resend). ALERT_FROM_EMAIL must be on a domain verified
  // in Resend; onboarding@resend.dev works for testing to the account owner only.
  const mailer = createMailer({ apiKey: resolveResendKey() });
  const fromEmail = process.env.ALERT_FROM_EMAIL || 'Lucent Alerts <onboarding@resend.dev>';
  if (!mailer) console.warn('⚠️  Email not configured (RESEND_API_KEY missing) — alert emails disabled');

  // Configure Twilio (guarded so the API still boots without SMS creds)
  let twilioClient = null;
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  } else {
    console.warn('⚠️  Twilio not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN missing) — intake SMS disabled');
  }

  // Tap-to-call. Links are signed with CALL_LINK_SECRET (falls back to API_SECRET_KEY).
  const publicBaseUrl = process.env.PUBLIC_BASE_URL || 'https://lucent-api-production.up.railway.app';
  const callSecret = process.env.CALL_LINK_SECRET || process.env.API_SECRET_KEY;
  const callBridge = callSecret && process.env.TAP_TO_CALL_ENABLED !== 'false'
    ? createCallBridge({
        store: createCallStore(supabase),
        twilioClient,
        fromNumber: process.env.TWILIO_PHONE_NUMBER,
        baseUrl: publicBaseUrl,
        secret: callSecret,
        validateTwilio: process.env.TWILIO_AUTH_TOKEN
          ? (sig, url, params) => twilio.validateRequest(process.env.TWILIO_AUTH_TOKEN, sig, url, params)
          : null,
      })
    : null;
  const twilioValidator = process.env.TWILIO_AUTH_TOKEN
    ? (sig, url, params) => twilio.validateRequest(process.env.TWILIO_AUTH_TOKEN, sig, url, params)
    : null;
  const replyHandler = createReplyHandler({
    store: createReplyStore(supabase),
    baseUrl: publicBaseUrl,
    validateTwilio: twilioValidator,
  });

  // Links texted to agents can use a shorter domain (e.g. https://go.lucent-partners.com)
  // pointed at this service; Twilio webhooks keep using PUBLIC_BASE_URL.
  const linkBaseUrl = process.env.LINK_BASE_URL || publicBaseUrl;
  const callLinkStore = createCallStore(supabase);
  const callLinkFor = callBridge
    ? (lead) => createCallLink({ store: callLinkStore, linkBase: linkBaseUrl, secret: callSecret, lead })
    : null;

  const app = createApp({
    supabase,
    twilioClient,
    twilioFromNumber: process.env.TWILIO_PHONE_NUMBER,
    mailer,
    fromEmail,
    callBridge,
    replyHandler
  });

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`✅ Lucent API running on port ${PORT}`);
    console.log(`📊 Health check: http://localhost:${PORT}/health`);
    console.log(`📧 Email provider: ${mailer ? 'Resend' : 'disabled'}`);
    console.log(`📱 SMS provider: ${twilioClient ? 'Twilio' : 'disabled'}`);
    console.log(`📞 Tap-to-call: ${callBridge ? 'enabled' : 'disabled'}`);
  });

  // Enforcement worker: agent texts, manager escalation, reassignment.
  // Disable with ENFORCEMENT_ENABLED=false.
  if (process.env.ENFORCEMENT_ENABLED !== 'false') {
    const { createEnforcementWorker, createSupabaseStore, createNotifier } = require('./enforcement');
    const worker = createEnforcementWorker({
      store: createSupabaseStore(supabase),
      callLinkFor,
      notifier: createNotifier({
        twilioClient,
        fromNumber: process.env.TWILIO_PHONE_NUMBER,
        mailer,
        fromEmail,
      }),
    });
    worker.start(Number(process.env.ENFORCEMENT_INTERVAL_MS) || 30000);
    console.log('🛡️  Enforcement worker running');
  }
}

module.exports = { createApp };
