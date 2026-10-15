// =====================================================
// Onboarding admin (/admin)
//
// A small password-protected page for setting up a new brokerage:
//   - create the brokerage (contacts, time zone, response windows)
//   - add its agents (name, email, mobile) and switch them on/off
//   - connect its CRM (key checked live with the CRM, stored encrypted)
//
// Login: HTTP Basic auth, any username, password = ADMIN_PASSWORD.
// The page is disabled when ADMIN_PASSWORD is not set.
// =====================================================

const crypto = require('crypto');
const express = require('express');
const { isValidPhone, normalizePhone } = require('./sms');
const { PROVIDERS } = require('./crm');

const TIMEZONES = [
  'America/Toronto', 'America/Vancouver', 'America/Edmonton', 'America/Winnipeg',
  'America/Regina', 'America/Halifax', 'America/St_Johns', 'America/New_York',
  'America/Chicago', 'America/Denver', 'America/Los_Angeles',
];

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeEqual = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------- data (Supabase) ----------

function createAdminStore(supabase) {
  const must = ({ data, error }) => {
    if (error) throw new Error(error.message);
    return data;
  };
  return {
    async listOrgs() {
      return must(await supabase.from('organizations')
        .select('id, name, status, timezone, primary_contact_name, created_at')
        .order('created_at', { ascending: false })) || [];
    },
    async getOrg(id) {
      const rows = must(await supabase.from('organizations').select('*').eq('id', id).limit(1)) || [];
      return rows[0] || null;
    },
    async createOrg(row) {
      return must(await supabase.from('organizations').insert(row).select('id').single());
    },
    async updateOrg(id, row) {
      must(await supabase.from('organizations').update({ ...row, updated_at: new Date().toISOString() }).eq('id', id));
    },
    async listAgents(orgId) {
      return must(await supabase.from('agents')
        .select('id, name, email, phone, is_active, rotation_order, crm_agent_id')
        .eq('org_id', orgId)
        .order('rotation_order', { ascending: true })) || [];
    },
    async createAgent(row) {
      must(await supabase.from('agents').insert(row));
    },
    async setAgentActive(orgId, agentId, active) {
      must(await supabase.from('agents').update({ is_active: active, updated_at: new Date().toISOString() })
        .eq('id', agentId).eq('org_id', orgId));
    },
  };
}

// ---------- form parsing ----------

const intIn = (v, min, max, fallback) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
};
const timeOf = (v, fallback) => (/^\d{2}:\d{2}$/.test(String(v || '')) ? v : fallback);

// Returns { row, errors } for the brokerage form.
function parseOrgForm(b) {
  const errors = [];
  const name = String(b.name || '').trim();
  if (!name) errors.push('Brokerage name is required.');
  const email = String(b.primary_contact_email || '').trim();
  if (email && !EMAIL.test(email)) errors.push('Manager email looks wrong.');
  const phoneRaw = String(b.primary_contact_phone || '').trim();
  if (phoneRaw && !isValidPhone(phoneRaw)) errors.push('Manager mobile looks wrong.');
  const row = {
    name,
    primary_contact_name: String(b.primary_contact_name || '').trim() || null,
    primary_contact_email: email || null,
    primary_contact_phone: phoneRaw ? normalizePhone(phoneRaw) : null,
    timezone: TIMEZONES.includes(b.timezone) ? b.timezone : 'America/Toronto',
    business_hours_start: timeOf(b.business_hours_start, '09:00'),
    business_hours_end: timeOf(b.business_hours_end, '18:00'),
    sla_hot_minutes: intIn(b.sla_hot_minutes, 1, 1440, 5),
    sla_warm_minutes: intIn(b.sla_warm_minutes, 1, 1440, 15),
    sla_cold_minutes: intIn(b.sla_cold_minutes, 1, 1440, 60),
    reassign_after_minutes: intIn(b.reassign_after_minutes, 1, 1440, 5),
    max_reassignments: intIn(b.max_reassignments, 0, 10, 2),
  };
  if (['active', 'paused', 'cancelled'].includes(b.status)) row.status = b.status;
  return { row, errors };
}

function parseAgentForm(b) {
  const errors = [];
  const name = String(b.name || '').trim();
  const email = String(b.email || '').trim().toLowerCase();
  const phone = String(b.phone || '').trim();
  if (!name) errors.push('Agent name is required.');
  if (!EMAIL.test(email)) errors.push('Agent email looks wrong.');
  if (!isValidPhone(phone)) errors.push('Agent mobile looks wrong.');
  return {
    row: {
      name, email, phone: isValidPhone(phone) ? normalizePhone(phone) : phone,
      crm_agent_id: String(b.crm_agent_id || '').trim() || null,
    },
    errors,
  };
}

// ---------- HTML ----------

const STYLE = `
:root{--bg:#f6f7f9;--card:#fff;--ink:#16181d;--muted:#5d6470;--line:#e2e5ea;--accent:#1f5eff;--ok:#127a3a;--bad:#b42318}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--ink)}
main{max-width:960px;margin:0 auto;padding:24px 16px 64px}a{color:var(--accent)}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:0 0 12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:18px;margin:16px 0}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}
label{display:block;font-size:13px;color:var(--muted)}input,select{width:100%;padding:8px;border:1px solid var(--line);border-radius:6px;font:inherit;margin-top:3px;background:#fff}
button{background:var(--accent);color:#fff;border:0;border-radius:6px;padding:9px 16px;font:inherit;cursor:pointer}
button.ghost{background:none;color:var(--accent);border:1px solid var(--line);padding:5px 10px}
button.danger{background:none;color:var(--bad);border:1px solid var(--line);padding:5px 10px}
.muted{color:var(--muted)}.ok{color:var(--ok)}.bad{color:var(--bad)}
.flash{padding:10px 14px;border-radius:8px;margin:12px 0}.flash.ok{background:#e8f6ee}.flash.bad{background:#fdecea}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.tag{display:inline-block;font-size:12px;padding:1px 8px;border-radius:99px;border:1px solid var(--line)}
@media (max-width:640px){.hide-sm{display:none}}
`;

function page(title, body, flash) {
  const f = flash ? `<div class="flash ${flash.ok ? 'ok' : 'bad'}">${esc(flash.msg)}</div>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)} · Lucent admin</title><style>${STYLE}</style></head>
<body><main><p class="muted"><a href="/admin">Lucent admin</a></p>${f}${body}</main></body></html>`;
}

const field = (label, name, value = '', type = 'text', extra = '') =>
  `<label>${esc(label)}<input type="${type}" name="${name}" value="${esc(value)}" ${extra}></label>`;

function orgFields(o = {}) {
  const tz = o.timezone || 'America/Toronto';
  return `<div class="grid">
${field('Brokerage name *', 'name', o.name, 'text', 'required')}
${field('Manager name (gets escalations)', 'primary_contact_name', o.primary_contact_name)}
${field('Manager email', 'primary_contact_email', o.primary_contact_email, 'email')}
${field('Manager mobile', 'primary_contact_phone', o.primary_contact_phone, 'tel')}
<label>Time zone<select name="timezone">${TIMEZONES.map((z) => `<option ${z === tz ? 'selected' : ''}>${z}</option>`).join('')}</select></label>
${field('Business hours start', 'business_hours_start', String(o.business_hours_start || '09:00').slice(0, 5), 'time')}
${field('Business hours end', 'business_hours_end', String(o.business_hours_end || '18:00').slice(0, 5), 'time')}
${field('Hot lead window (min)', 'sla_hot_minutes', o.sla_hot_minutes ?? 5, 'number', 'min="1"')}
${field('Warm lead window (min)', 'sla_warm_minutes', o.sla_warm_minutes ?? 15, 'number', 'min="1"')}
${field('Cold lead window (min)', 'sla_cold_minutes', o.sla_cold_minutes ?? 60, 'number', 'min="1"')}
${field('Reassign after escalation (min)', 'reassign_after_minutes', o.reassign_after_minutes ?? 5, 'number', 'min="1"')}
${field('Max reassignments', 'max_reassignments', o.max_reassignments ?? 2, 'number', 'min="0" max="10"')}
</div>`;
}

function homePage(orgs, flash) {
  const rows = orgs.map((o) => `<tr><td><a href="/admin/orgs/${o.id}">${esc(o.name)}</a></td>
<td class="hide-sm">${esc(o.primary_contact_name || '')}</td><td>${esc(o.timezone || '')}</td><td><span class="tag">${esc(o.status)}</span></td></tr>`).join('');
  return page('Brokerages', `<h1>Brokerages</h1>
<div class="card">${orgs.length ? `<table><tr><th>Name</th><th class="hide-sm">Manager</th><th>Time zone</th><th>Status</th></tr>${rows}</table>` : '<p class="muted">No brokerages yet.</p>'}</div>
<div class="card"><h2>Add a brokerage</h2><form method="post" action="/admin/orgs">${orgFields()}<p><button>Create brokerage</button></p></form></div>`, flash);
}

function orgPage({ org, agents, connections, fubUrl }, flash) {
  const agentRows = agents.map((a) => `<tr><td>${esc(a.name)}</td><td class="hide-sm">${esc(a.email)}</td><td>${esc(a.phone)}</td>
<td>${a.is_active ? '<span class="ok">Active</span>' : '<span class="muted">Off</span>'}</td>
<td><form method="post" action="/admin/orgs/${org.id}/agents/${a.id}/toggle"><button class="ghost">${a.is_active ? 'Switch off' : 'Switch on'}</button></form></td></tr>`).join('');

  const crmRows = connections.map((c) => `<tr><td>${esc(PROVIDERS[c.provider] || c.provider)}</td><td>${esc(c.key_hint || '')}</td>
<td>${c.status === 'active' ? '<span class="ok">Connected</span>' : `<span class="bad">${esc(c.status)}</span>`}${c.last_error ? `<div class="muted">${esc(c.last_error)}</div>` : ''}</td>
<td><form method="post" action="/admin/orgs/${org.id}/crm/${c.provider}/delete"><button class="danger">Disconnect</button></form></td></tr>`).join('');

  return page(org.name, `<h1>${esc(org.name)}</h1><p class="muted">Brokerage ID (for lead intake): <code>${esc(org.id)}</code></p>
<div class="card"><h2>Agents</h2>
${agents.length ? `<table><tr><th>Name</th><th class="hide-sm">Email</th><th>Mobile</th><th>Status</th><th></th></tr>${agentRows}</table>` : '<p class="muted">No agents yet.</p>'}
<form method="post" action="/admin/orgs/${org.id}/agents" style="margin-top:14px"><div class="grid">
${field('Name *', 'name', '', 'text', 'required')}${field('Email * (same as in their CRM)', 'email', '', 'email', 'required')}
${field('Mobile *', 'phone', '', 'tel', 'required')}${field('CRM user ID (optional)', 'crm_agent_id')}
</div><p><button>Add agent</button></p></form></div>

<div class="card"><h2>CRM connection</h2>
${connections.length ? `<table><tr><th>CRM</th><th>Key</th><th>Status</th><th></th></tr>${crmRows}</table>` : '<p class="muted">No CRM connected. Agents can still respond by tap-to-call or by replying 1.</p>'}
<form method="post" action="/admin/orgs/${org.id}/crm" style="margin-top:14px" autocomplete="off"><div class="grid">
<label>CRM<select name="provider">${Object.entries(PROVIDERS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></label>
${field('API key (from the brokerage owner/admin)', 'api_key', '', 'password', 'required autocomplete="new-password"')}
</div><p><button>Check key and connect</button></p>
<p class="muted">The key is checked with the CRM before it is saved, then stored encrypted. Follow Up Boss notifications go to <code>${esc(fubUrl)}</code> automatically.</p></form></div>

<div class="card"><h2>Brokerage settings</h2><form method="post" action="/admin/orgs/${org.id}">${orgFields(org)}
<label style="max-width:200px;margin-top:12px">Status<select name="status">${['active', 'paused', 'cancelled'].map((s) => `<option ${s === org.status ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
<p><button>Save settings</button></p></form></div>`, flash);
}

// ---------- router ----------

function createAdminRouter({ password, store, crmService, crmStore, log = console }) {
  const router = express.Router();
  if (!password) return router; // disabled

  const flashes = new Map(); // one-time messages after redirects (single instance)
  const setFlash = (res, ok, msg) => {
    const id = crypto.randomBytes(8).toString('hex');
    flashes.set(id, { ok, msg });
    if (flashes.size > 200) flashes.delete(flashes.keys().next().value);
    return id;
  };
  const takeFlash = (req) => {
    const f = flashes.get(req.query.m);
    if (f) flashes.delete(req.query.m);
    return f;
  };
  const back = (res, path, ok, msg) => res.redirect(303, `${path}?m=${setFlash(res, ok, msg)}`);

  router.use('/admin', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Frame-Options', 'DENY');
    const [scheme, encoded] = String(req.headers.authorization || '').split(' ');
    const pass = scheme === 'Basic' && encoded ? Buffer.from(encoded, 'base64').toString().split(':').slice(1).join(':') : null;
    if (pass === null || !safeEqual(pass, password)) {
      res.set('WWW-Authenticate', 'Basic realm="Lucent admin", charset="UTF-8"');
      return res.status(401).send('Login required');
    }
    // Forms only from this page (blocks cross-site form posts).
    if (req.method === 'POST') {
      const origin = req.headers.origin || req.headers.referer || '';
      let host = null;
      try { host = new URL(origin).host; } catch { /* missing */ }
      if (host !== req.headers.host) return res.status(403).send('Forbidden');
    }
    next();
  });
  router.use('/admin', express.urlencoded({ extended: false, limit: '20kb' }));
  router.param('orgId', (req, res, next, id) => (UUID.test(id) ? next() : res.status(404).send('Not found')));
  router.param('agentId', (req, res, next, id) => (UUID.test(id) ? next() : res.status(404).send('Not found')));

  const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
    log.error('Admin error:', e.message);
    res.status(500).send(page('Error', `<h1>Something went wrong</h1><p>${esc(e.message)}</p>`));
  });

  router.get('/admin', wrap(async (req, res) => {
    res.send(homePage(await store.listOrgs(), takeFlash(req)));
  }));

  router.post('/admin/orgs', wrap(async (req, res) => {
    const { row, errors } = parseOrgForm(req.body);
    if (errors.length) return back(res, '/admin', false, errors.join(' '));
    const created = await store.createOrg(row);
    back(res, `/admin/orgs/${created.id}`, true, `${row.name} created. Next: add agents and connect the CRM.`);
  }));

  router.get('/admin/orgs/:orgId', wrap(async (req, res) => {
    const org = await store.getOrg(req.params.orgId);
    if (!org) return res.status(404).send(page('Not found', '<h1>Brokerage not found</h1>'));
    const [agents, connections] = await Promise.all([store.listAgents(org.id), crmStore.getByOrg(org.id)]);
    res.send(orgPage({ org, agents, connections, fubUrl: crmService.fubUrl('…') }, takeFlash(req)));
  }));

  router.post('/admin/orgs/:orgId', wrap(async (req, res) => {
    const path = `/admin/orgs/${req.params.orgId}`;
    const { row, errors } = parseOrgForm(req.body);
    if (errors.length) return back(res, path, false, errors.join(' '));
    await store.updateOrg(req.params.orgId, row);
    back(res, path, true, 'Settings saved.');
  }));

  router.post('/admin/orgs/:orgId/agents', wrap(async (req, res) => {
    const orgId = req.params.orgId;
    const path = `/admin/orgs/${orgId}`;
    const { row, errors } = parseAgentForm(req.body);
    if (errors.length) return back(res, path, false, errors.join(' '));
    const agents = await store.listAgents(orgId);
    if (agents.some((a) => a.email.toLowerCase() === row.email)) return back(res, path, false, 'An agent with that email already exists.');
    const order = agents.reduce((m, a) => Math.max(m, a.rotation_order ?? 0), 0) + 1;
    await store.createAgent({ ...row, org_id: orgId, rotation_order: order, is_active: true, is_available: true });
    back(res, path, true, `${row.name} added.`);
  }));

  router.post('/admin/orgs/:orgId/agents/:agentId/toggle', wrap(async (req, res) => {
    const { orgId, agentId } = req.params;
    const agent = (await store.listAgents(orgId)).find((a) => a.id === agentId);
    if (!agent) return back(res, `/admin/orgs/${orgId}`, false, 'Agent not found.');
    await store.setAgentActive(orgId, agentId, !agent.is_active);
    back(res, `/admin/orgs/${orgId}`, true, `${agent.name} switched ${agent.is_active ? 'off' : 'on'}.`);
  }));

  router.post('/admin/orgs/:orgId/crm', wrap(async (req, res) => {
    const orgId = req.params.orgId;
    const path = `/admin/orgs/${orgId}`;
    if (!(await store.getOrg(orgId))) return res.status(404).send('Not found');
    const r = await crmService.connect(orgId, String(req.body.provider || ''), req.body.api_key);
    back(res, path, r.ok, r.ok ? `${PROVIDERS[req.body.provider]} connected.` : r.error);
  }));

  router.post('/admin/orgs/:orgId/crm/:provider/delete', wrap(async (req, res) => {
    const { orgId, provider } = req.params;
    if (!PROVIDERS[provider]) return res.status(404).send('Not found');
    await crmService.disconnect(orgId, provider);
    back(res, `/admin/orgs/${orgId}`, true, `${PROVIDERS[provider]} disconnected.`);
  }));

  return router;
}

module.exports = { createAdminRouter, createAdminStore, parseOrgForm, parseAgentForm, TIMEZONES };
