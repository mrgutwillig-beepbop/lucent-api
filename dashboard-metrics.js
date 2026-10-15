// =====================================================
// Dashboard numbers for one brokerage (pure functions, no database).
//
// Input: the brokerage, its agents, the leads that arrived in the period,
// their events, the period's escalations, and the currently open leads.
// Output: everything the manager dashboard shows.
//
// Definitions
//   answered        the lead has a first contact
//   on time         first contact by the lead's FIRST deadline (the window
//                   that started when it first reached an agent)
//   agent on time   answered within their own window, out of every window
//                   that ended with them (answered or missed)
//   not answered    no contact and the deadline has passed (or lead closed)
//   waiting         no contact yet, still inside its window
//   how answered    the response event nearest the first contact
// =====================================================

const RANGES = { today: 1, '7d': 7, '30d': 30 };

const CHANNELS = {
  tap_to_call: 'Tap to call',
  fub_call: 'Follow Up Boss call',
  fub_text: 'Follow Up Boss text',
  fub_email: 'Follow Up Boss email',
  boldtrail_call: 'BoldTrail call',
  sms_reply: 'Replied 1 (self-reported)',
  unknown: 'Not recorded',
};
const RESPONSE_EVENTS = new Set(['call_started', 'contact_detected', 'contact_confirmed']);

// ---------- time zones ----------

function tzParts(date, tz) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}

const tzOffsetMs = (date, tz) => {
  const p = tzParts(date, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(date.getTime() / 1000) * 1000;
};

// The instant of local midnight, `daysBack` days before `now`'s local date.
function localMidnight(now, tz, daysBack = 0) {
  const p = tzParts(now, tz);
  const guess = Date.UTC(p.y, p.m - 1, p.d - daysBack);
  let t = guess - tzOffsetMs(new Date(guess), tz);
  t = guess - tzOffsetMs(new Date(t), tz); // settle across DST changes
  return new Date(t);
}

const localDay = (date, tz) => {
  const p = tzParts(date, tz);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
};

function rangeBounds(key, now, tz) {
  const days = RANGES[key] || RANGES['7d'];
  return { key: RANGES[key] ? key : '7d', days, start: localMidnight(now, tz, days - 1), end: now };
}

// ---------- helpers ----------

const ms = (v) => (v ? new Date(v).getTime() : null);
const avg = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
const pct = (n, d) => (d ? Math.round((n / d) * 100) : null);
const leadName = (l) => [l.first_name, l.last_name].filter(Boolean).join(' ') || l.email || l.phone || 'Unnamed lead';

function groupBy(xs, key) {
  const m = new Map();
  for (const x of xs) {
    const k = x[key];
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

// Channel of the response event nearest the lead's first contact.
function responseChannel(lead, events) {
  const at = ms(lead.first_contact_at);
  let best = null;
  for (const e of events) {
    if (!RESPONSE_EVENTS.has(e.event_type)) continue;
    const ch = e.event_data?.channel;
    if (!ch) continue;
    const gap = Math.abs(ms(e.created_at) - at);
    if (!best || gap < best.gap) best = { ch, gap };
  }
  return best && best.gap <= 10 * 60 * 1000 && CHANNELS[best.ch] ? best.ch : 'unknown';
}

// The deadline of the lead's first window (its first assignment).
function firstDeadline(lead, events) {
  const first = events
    .filter((e) => e.event_type === 'assigned' && e.event_data?.sla_deadline)
    .sort((a, b) => ms(a.created_at) - ms(b.created_at))[0];
  return ms(first?.event_data?.sla_deadline) ?? ms(lead.sla_deadline);
}

function classify(lead, events, nowMs) {
  const contactMs = ms(lead.first_contact_at);
  const deadlineMs = firstDeadline(lead, events);
  if (contactMs) {
    const onTime = deadlineMs ? contactMs <= deadlineMs : null;
    return { outcome: onTime === false ? 'late' : 'on_time', onTime, channel: responseChannel(lead, events), deadlineMs };
  }
  const pastDue = deadlineMs ? deadlineMs < nowMs : false;
  const done = ['closed', 'contacted'].includes(lead.status);
  return { outcome: pastDue || done ? 'not_answered' : 'waiting', onTime: pastDue || done ? false : null, channel: null, deadlineMs };
}

// ---------- main ----------

function computeDashboard({ org, agents = [], leads = [], events = [], escalations = [], openLeads = [], rangeKey = '7d', now = new Date() }) {
  const tz = org.timezone || 'America/Toronto';
  const range = rangeBounds(rangeKey, now, tz);
  const nowMs = now.getTime();
  const startMs = range.start.getTime();
  const agentName = new Map(agents.map((a) => [a.id, a.name]));
  const eventsByLead = groupBy(events, 'lead_id');

  const rows = leads
    .filter((l) => ms(l.created_at) >= startMs)
    .map((l) => ({ lead: l, evs: eventsByLead.get(l.id) || [], ...classify(l, eventsByLead.get(l.id) || [], nowMs) }));

  // Headline numbers
  const answered = rows.filter((r) => r.lead.first_contact_at);
  const decided = rows.filter((r) => r.outcome !== 'waiting');
  const onTime = rows.filter((r) => r.outcome === 'on_time');
  const periodEvents = events.filter((e) => ms(e.created_at) >= startMs);
  const reassigned = periodEvents.filter((e) => e.event_type === 'reassigned');
  const periodEsc = escalations.filter((e) => ms(e.escalated_at) >= startMs);
  const kpis = {
    leads: rows.length,
    answered: answered.length,
    onTime: onTime.length,
    late: rows.filter((r) => r.outcome === 'late').length,
    notAnswered: rows.filter((r) => r.outcome === 'not_answered').length,
    waiting: rows.filter((r) => r.outcome === 'waiting').length,
    onTimePct: pct(onTime.length, decided.length),
    avgResponseSec: avg(answered.map((r) => r.lead.response_time_seconds).filter((v) => typeof v === 'number')),
    avgFirstContactSec: avg(answered.map((r) => r.lead.time_to_first_contact_seconds).filter((v) => typeof v === 'number')),
    escalatedLeads: new Set(periodEsc.map((e) => e.lead_id)).size,
    reassignments: reassigned.length,
  };

  // Per day (local dates), oldest first
  const days = [];
  for (let i = range.days - 1; i >= 0; i -= 1) days.push(localDay(localMidnight(now, tz, i), tz));
  const daily = days.map((date) => ({ date, on_time: 0, late: 0, not_answered: 0, waiting: 0 }));
  const dayIndex = new Map(days.map((d, i) => [d, i]));
  for (const r of rows) {
    const i = dayIndex.get(localDay(new Date(r.lead.created_at), tz));
    if (i !== undefined) daily[i][r.outcome] += 1;
  }

  // How leads were answered
  const channelCounts = new Map();
  for (const r of answered) channelCounts.set(r.channel, (channelCounts.get(r.channel) || 0) + 1);
  const channels = [...channelCounts.entries()]
    .map(([key, count]) => ({ key, label: CHANNELS[key], count, verified: key !== 'sms_reply' && key !== 'unknown' }))
    .sort((a, b) => b.count - a.count);

  // Agents
  const stat = new Map();
  const S = (id) => {
    if (!id) return null;
    if (!stat.has(id)) stat.set(id, { id, received: 0, answered: 0, onTime: 0, responses: [], missed: new Set(), answeredIds: new Set(), movedAway: 0, channels: {} });
    return stat.get(id);
  };
  for (const a of agents) S(a.id);
  for (const e of periodEvents) {
    if (e.event_type === 'assigned') { const s = S(e.event_data?.agent_id); if (s) s.received += 1; }
    if (e.event_type === 'reassigned') {
      const to = S(e.event_data?.to_agent_id); if (to) to.received += 1;
      const from = S(e.event_data?.from_agent_id); if (from) from.movedAway += 1;
    }
  }
  for (const e of periodEsc) { const s = S(e.agent_id); if (s) s.missed.add(e.lead_id); }
  for (const r of answered) {
    const s = S(r.lead.assigned_to);
    if (!s) continue;
    s.answered += 1;
    s.answeredIds.add(r.lead.id);
    if (ms(r.lead.first_contact_at) <= (ms(r.lead.sla_deadline) ?? Infinity) && !s.missed.has(r.lead.id)) s.onTime += 1;
    if (typeof r.lead.response_time_seconds === 'number') s.responses.push(r.lead.response_time_seconds);
    s.channels[r.channel] = (s.channels[r.channel] || 0) + 1;
  }
  const activeIds = new Set(agents.filter((a) => a.is_active).map((a) => a.id));
  const agentRows = [...stat.values()]
    .filter((s) => activeIds.has(s.id) || s.received || s.answered)
    .map((s) => ({
      id: s.id,
      name: agentName.get(s.id) || 'Former agent',
      active: activeIds.has(s.id),
      received: s.received,
      answered: s.answered,
      // On time out of every window that ended with this agent: answered or missed.
      onTimePct: pct(s.onTime, new Set([...s.answeredIds, ...s.missed]).size),
      avgResponseSec: avg(s.responses),
      missed: s.missed.size,
      movedAway: s.movedAway,
      channels: s.channels,
    }))
    .sort((a, b) => b.received - a.received || a.name.localeCompare(b.name));

  // Open leads right now, most urgent first
  const open = openLeads
    .filter((l) => !l.first_contact_at && ['assigned', 'escalated'].includes(l.status))
    .map((l) => ({
      id: l.id,
      name: leadName(l),
      temperature: l.lead_temperature,
      source: l.source,
      agent: agentName.get(l.assigned_to) || null,
      status: l.status,
      createdAt: l.created_at,
      deadline: l.sla_deadline,
      secondsLeft: l.sla_deadline ? Math.round((ms(l.sla_deadline) - nowMs) / 1000) : null,
      escalations: l.escalation_count || 0,
      reassigns: l.reassign_count || 0,
    }))
    .sort((a, b) => (a.secondsLeft ?? 1e12) - (b.secondsLeft ?? 1e12));

  // Lead list, newest first
  const recent = rows
    .sort((a, b) => ms(b.lead.created_at) - ms(a.lead.created_at))
    .slice(0, 200)
    .map((r) => ({
      id: r.lead.id,
      name: leadName(r.lead),
      source: r.lead.source,
      temperature: r.lead.lead_temperature,
      createdAt: r.lead.created_at,
      agent: agentName.get(r.lead.assigned_to) || null,
      outcome: r.outcome,
      channel: r.channel,
      channelLabel: r.channel ? CHANNELS[r.channel] : null,
      firstContactSec: r.lead.time_to_first_contact_seconds ?? null,
      reassigns: r.lead.reassign_count || 0,
    }));

  return {
    org: { name: org.name, timezone: tz, windows: { hot: org.sla_hot_minutes, warm: org.sla_warm_minutes, cold: org.sla_cold_minutes } },
    range: { key: range.key, days: range.days, start: range.start.toISOString(), end: now.toISOString() },
    generatedAt: now.toISOString(),
    kpis, daily, channels, agents: agentRows, open, recent,
  };
}

// One lead's history, for the timeline view.
function leadTimeline({ lead, events, agents }) {
  const name = new Map(agents.map((a) => [a.id, a.name]));
  const label = (e) => {
    const d = e.event_data || {};
    switch (e.event_type) {
      case 'created': return `Lead arrived${d.source ? ` from ${d.source}` : ''}`;
      case 'assigned': return `Assigned to ${d.agent_name || name.get(d.agent_id) || 'an agent'}`;
      case 'call_link': return null;
      case 'call_requested': return 'Agent tapped the call link';
      case 'call_started': return 'Agent pressed 1; calling the lead';
      case 'call_ended': return `Call ended (${String(d.outcome || 'unknown').replace('-', ' ')}${d.duration_seconds ? `, ${d.duration_seconds}s` : ''})`;
      case 'contact_detected': return `${CHANNELS[d.channel] || 'Contact'} detected${d.verified ? ' (verified in CRM)' : ''}`;
      case 'contact_confirmed': return 'Agent replied 1 (self-reported)';
      case 'contacted': return 'Marked answered';
      case 'escalated': return `Missed window; manager alerted${d.minutes_overdue != null ? ` (${d.minutes_overdue} min over)` : ''}`;
      case 'reassigned': return `Moved from ${name.get(d.from_agent_id) || 'previous agent'} to ${d.to_agent_name || name.get(d.to_agent_id) || 'next agent'}`;
      default: return e.event_type.replace(/_/g, ' ');
    }
  };
  return {
    id: lead.id,
    name: leadName(lead),
    source: lead.source,
    temperature: lead.lead_temperature,
    status: lead.status,
    agent: name.get(lead.assigned_to) || null,
    firstContactSec: lead.time_to_first_contact_seconds ?? null,
    events: events
      .slice()
      .sort((a, b) => ms(a.created_at) - ms(b.created_at))
      .map((e) => ({ at: e.created_at, type: e.event_type, text: label(e) }))
      .filter((e) => e.text),
  };
}

module.exports = { computeDashboard, leadTimeline, rangeBounds, localMidnight, localDay, responseChannel, CHANNELS, RANGES };
