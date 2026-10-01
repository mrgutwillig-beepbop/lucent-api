// =====================================================
// Email sending via Resend (https://resend.com)
//
// Uses Resend's HTTP API directly, so no extra dependency is needed.
// The key is read from RESEND_API_KEY, or from SENDGRID_API_KEY when that
// variable holds a Resend key (starts with "re_"), so either setup works.
// =====================================================

const RESEND_URL = 'https://api.resend.com/emails';

function resolveResendKey(env = process.env) {
  if (env.RESEND_API_KEY) return env.RESEND_API_KEY;
  if (env.SENDGRID_API_KEY && env.SENDGRID_API_KEY.startsWith('re_')) return env.SENDGRID_API_KEY;
  return null;
}

// Returns an object with send({ to, from, subject, html }), or null when no key is set.
function createMailer({ apiKey, fetchImpl = globalThis.fetch } = {}) {
  if (!apiKey) return null;
  return {
    async send({ to, from, subject, html }) {
      const res = await fetchImpl(RESEND_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ to: Array.isArray(to) ? to : [to], from, subject, html }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(`Resend ${res.status}: ${body.message || body.name || 'send failed'}`);
      }
      return { id: body.id };
    },
  };
}

module.exports = { createMailer, resolveResendKey };
