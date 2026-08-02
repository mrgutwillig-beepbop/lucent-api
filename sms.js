// =====================================================
// Twilio SMS helpers for lead intake notifications
//
// Kept as small, injectable, side-effect-light functions so the
// intake behavior can be unit tested without hitting the network.
// =====================================================

// A phone is "valid" if it contains 10–15 digits (E.164 allows up to 15).
// Formatting characters (spaces, dashes, parens, leading +) are ignored.
function isValidPhone(phone) {
  if (!phone || typeof phone !== 'string') return false;
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 15;
}

// Normalize a loosely-formatted phone into E.164 for Twilio.
// - Numbers already in "+..." form are preserved (digits only after the +).
// - Bare 10-digit numbers are assumed North American and get a +1 prefix.
// - Anything else is prefixed with "+" on its raw digits.
// NOTE: the +1 default assumes US/Canada leads. Adjust if the org serves
// another default region.
function normalizePhone(phone) {
  const trimmed = String(phone).trim();
  if (trimmed.startsWith('+')) {
    return '+' + trimmed.slice(1).replace(/\D/g, '');
  }
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  return '+' + digits;
}

// Build the intake confirmation message. Falls back to a generic phrase
// if the org name is missing so we never send "... from undefined ...".
function formatIntakeMessage(orgName) {
  const name = orgName && String(orgName).trim() ? String(orgName).trim() : 'our team';
  return `Thanks for your inquiry. An agent from ${name} will contact you shortly.`;
}

// Send the intake SMS. Best-effort by contract: returns a result object and
// only throws if the underlying Twilio call throws (callers catch that so
// intake is never blocked by a messaging failure).
//
// Returns { sent: boolean, reason?: string, sid?: string }.
async function sendIntakeSms({ twilioClient, fromNumber, phone, orgName }) {
  if (!isValidPhone(phone)) {
    return { sent: false, reason: 'invalid_phone' };
  }
  if (!twilioClient || !fromNumber) {
    return { sent: false, reason: 'twilio_not_configured' };
  }

  const message = await twilioClient.messages.create({
    to: normalizePhone(phone),
    from: fromNumber,
    body: formatIntakeMessage(orgName),
  });

  return { sent: true, sid: message.sid };
}

module.exports = {
  isValidPhone,
  normalizePhone,
  formatIntakeMessage,
  sendIntakeSms,
};
