// =====================================================
// Manager dashboard (/dashboard)
//
// Each brokerage's managers sign in with a one-time link sent to their email
// (no passwords). A manager only ever sees their own brokerage.
//   GET  /dashboard/login        email form
//   POST /dashboard/login        sends the link (same reply whether or not the
//                                email is registered)
//   GET  /dashboard/auth?t=..    "Sign in" button (email scanners can't use up
//   POST /dashboard/auth         the link by opening it; the POST does)
//   GET  /dashboard              the dashboard page
//   GET  /dashboard/data         numbers for ?range=today|7d|30d
//   GET  /dashboard/leads/:id    one lead's history
//   POST /dashboard/logout
//
// Sessions: a signed cookie (30 days), re-checked against dashboard_users on
// every request, so removing a manager on the admin page signs them out.
// =====================================================

const crypto = require('crypto');
const express = require('express');
const { computeDashboard, leadTimeline, rangeBounds } = require('./dashboard-metrics');

const COOKIE = 'lucent_dash';
const SESSION_DAYS = 30;
const LINK_MINUTES = 30;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function deriveSessionKey(env = process.env) {
  const material = env.DASHBOARD_SESSION_SECRET || (env.API_SECRET_KEY ? `${env.API_SECRET_KEY}:dashboard-sessions` : null);
  return material ? crypto.createHash('sha256').update(material).digest() : null;
}

// ---------- data (Supabase) ----------

function createDashboardStore(supabase) {
  const must = ({ data, error }) => {
    if (error) throw new Error(error.message);
    return data;
  };
  // Supabase returns at most 1000 rows per request; page through.
  async function all(build, max = 20000) {
    const out = [];
    for (let from = 0; from < max; from += 1000) {
      const page = must(await build().range(from, from + 999)) || [];
      out.push(...page);
      if (page.length < 1000) break;
    }
    return out;
  }
  const LEAD_FIELDS = 'id, org_id, first_name, last_name, email, phone, source, lead_temperature, status, assigned_to, assigned_at, sla_deadline, first_contact_at, response_time_seconds, time_to_first_contact_seconds, escalation_count, reassign_count, created_at';

  return {
    // users and login links
    async usersByEmail(email) {
      return must(await supabase.from('dashboard_users').select('id, org_id, email, name').ilike('email', email)) || [];
    },
    async getUser(id) {
      const rows = must(await supabase.from('dashboard_users').select('id, org_id, email, name').eq('id', id).limit(1)) || [];
      return rows[0] || null;
    },
    async listUsers(orgId) {
      return must(await supabase.from('dashboard_users').select('id, email, name, last_login_at, created_at').eq('org_id', orgId).order('created_at')) || [];
    },
    async addUser(orgId, email, name) {
      must(await supabase.from('dashboard_users').upsert({ org_id: orgId, email, name }, { onConflict: 'org_id,email' }));
    },
    async removeUser(orgId, id) {
      must(await supabase.from('dashboard_users').delete().eq('id', id).eq('org_id', orgId));
    },
    async createToken(hash, userId, expiresAt) {
      must(await supabase.from('dashboard_login_tokens').insert({ token_hash: hash, user_id: userId, expires_at: expiresAt }));
    },
    // Marks the link used and returns its user id, or null (one UPDATE, so a link works once).
    async consumeToken(hash) {
      const rows = must(await supabase.from('dashboard_login_tokens')
        .update({ used_at: new Date().toISOString() })
        .eq('token_hash', hash).is('used_at', null).gt('expires_at', new Date().toISOString())
        .select('user_id')) || [];
      return rows[0]?.user_id || null;
    },
    async peekToken(hash) {
      const rows = must(await supabase.from('dashboard_login_tokens').select('user_id, used_at, expires_at').eq('token_hash', hash).limit(1)) || [];
      const t = rows[0];
      return t && !t.used_at && new Date(t.expires_at) > new Date() ? t.user_id : null;
    },
    async touchLogin(userId) {
      must(await supabase.from('dashboard_users').update({ last_login_at: new Date().toISOString() }).eq('id', userId));
    },

    // dashboard data
    async getOrg(orgId) {
      const rows = must(await supabase.from('organizations')
        .select('id, name, timezone, sla_hot_minutes, sla_warm_minutes, sla_cold_minutes').eq('id', orgId).limit(1)) || [];
      return rows[0] || null;
    },
    async agents(orgId) {
      return must(await supabase.from('agents').select('id, name, is_active').eq('org_id', orgId)) || [];
    },
    async leadsSince(orgId, sinceIso) {
      return all(() => supabase.from('leads').select(LEAD_FIELDS).eq('org_id', orgId).gte('created_at', sinceIso).order('created_at', { ascending: false }));
    },
    async openLeads(orgId) {
      return all(() => supabase.from('leads').select(LEAD_FIELDS).eq('org_id', orgId)
        .in('status', ['assigned', 'escalated']).is('first_contact_at', null).order('sla_deadline', { ascending: true }), 2000);
    },
    async eventsSince(orgId, sinceIso) {
      return all(() => supabase.from('lead_events').select('lead_id, event_type, event_data, created_at')
        .eq('org_id', orgId).gte('created_at', sinceIso).neq('event_type', 'call_link').order('created_at', { ascending: true }), 60000);
    },
    async escalationsSince(orgId, sinceIso) {
      return all(() => supabase.from('escalations').select('lead_id, agent_id, escalated_at')
        .eq('org_id', orgId).gte('escalated_at', sinceIso).order('escalated_at', { ascending: true }));
    },
    async lead(orgId, id) {
      const rows = must(await supabase.from('leads').select(LEAD_FIELDS).eq('org_id', orgId).eq('id', id).limit(1)) || [];
      return rows[0] || null;
    },
    async leadEvents(orgId, leadId) {
      return must(await supabase.from('lead_events').select('lead_id, event_type, event_data, created_at')
        .eq('org_id', orgId).eq('lead_id', leadId).order('created_at', { ascending: true })) || [];
    },
  };
}

// ---------- data for one brokerage ----------

function createDashboardData(store, { now = () => new Date() } = {}) {
  async function summary(orgId, rangeKey) {
    const org = await store.getOrg(orgId);
    if (!org) return null;
    const at = now();
    const range = rangeBounds(rangeKey, at, org.timezone || 'America/Toronto');
    const since = range.start.toISOString();
    const [agents, leads, events, escalations, openLeads] = await Promise.all([
      store.agents(orgId), store.leadsSince(orgId, since), store.eventsSince(orgId, since),
      store.escalationsSince(orgId, since), store.openLeads(orgId),
    ]);
    return computeDashboard({ org, agents, leads, events, escalations, openLeads, rangeKey: range.key, now: at });
  }
  async function lead(orgId, leadId) {
    if (!UUID.test(leadId)) return null;
    const l = await store.lead(orgId, leadId);
    if (!l) return null;
    const [events, agents] = await Promise.all([store.leadEvents(orgId, leadId), store.agents(orgId)]);
    return leadTimeline({ lead: l, events, agents });
  }
  return { summary, lead };
}

// ---------- sessions ----------

function createSessions(key, { now = () => Date.now() } = {}) {
  const mac = (s) => crypto.createHmac('sha256', key).update(s).digest('base64url');
  return {
    make(user) {
      const body = Buffer.from(JSON.stringify({ u: user.id, o: user.org_id, exp: now() + SESSION_DAYS * 864e5 })).toString('base64url');
      return `${body}.${mac(body)}`;
    },
    read(value) {
      const [body, sig] = String(value || '').split('.');
      if (!body || !sig) return null;
      const want = mac(body);
      if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
      try {
        const s = JSON.parse(Buffer.from(body, 'base64url').toString());
        return s.exp > now() ? s : null;
      } catch { return null; }
    },
  };
}

const readCookie = (req, name) => {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
};

// ---------- pages ----------

const BASE_STYLE = `
:root{--page:#f6f6f4;--surface:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--muted:#6f6d68;--line:#e1e0d9;--axis:#c3c2b7;--ring:rgba(11,11,11,.10);
--accent:#2a78d6;--good:#0ca30c;--good-ink:#006300;--serious:#ec835a;--critical:#d03b3b;--critical-ink:#b42318;--wait:#b9b7ae;--wash:rgba(42,120,214,.08)}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--page:#0d0d0d;--surface:#1a1a19;--ink:#f0efec;--ink2:#c3c2b7;--muted:#9a988f;--line:#2c2c2a;--axis:#383835;--ring:rgba(255,255,255,.10);
--accent:#3987e5;--good-ink:#0ca30c;--critical-ink:#e66767;--wait:#5a5954;--wash:rgba(57,135,229,.14)}}
:root[data-theme="dark"]{--page:#0d0d0d;--surface:#1a1a19;--ink:#f0efec;--ink2:#c3c2b7;--muted:#9a988f;--line:#2c2c2a;--axis:#383835;--ring:rgba(255,255,255,.10);
--accent:#3987e5;--good-ink:#0ca30c;--critical-ink:#e66767;--wait:#5a5954;--wash:rgba(57,135,229,.14)}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--page);color:var(--ink);font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--accent)}button,input,select{font:inherit}
`;

function shell(title, body, extraHead = '') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title><style>${BASE_STYLE}</style>${extraHead}</head><body>${body}</body></html>`;
}

function authPage(title, inner) {
  return shell(title, `<main style="max-width:420px;margin:12vh auto;padding:0 16px">
<div style="font-weight:600;letter-spacing:.02em;margin-bottom:18px">Lucent</div>
<div style="background:var(--surface);border:1px solid var(--ring);border-radius:12px;padding:24px">${inner}</div></main>
<style>label{display:block;color:var(--ink2);font-size:14px;margin-bottom:6px}
input{width:100%;padding:10px 12px;border:1px solid var(--axis);border-radius:8px;background:var(--surface);color:var(--ink)}
button{margin-top:14px;width:100%;padding:11px;border:0;border-radius:8px;background:var(--accent);color:#fff;cursor:pointer;font-weight:600}
h1{font-size:20px;margin:0 0 8px}p{color:var(--ink2);margin:0 0 14px}</style>`);
}

const loginPage = (msg = '') => authPage('Sign in · Lucent', `<h1>Lead response dashboard</h1>
<p>Enter your work email and we'll send you a sign-in link.</p>${msg ? `<p style="color:var(--ink)">${esc(msg)}</p>` : ''}
<form method="post" action="/dashboard/login"><label for="email">Email</label>
<input id="email" name="email" type="email" autocomplete="email" required autofocus><button>Email me a sign-in link</button></form>`);

const sentPage = () => authPage('Check your email · Lucent', `<h1>Check your email</h1>
<p>If that address has dashboard access, a sign-in link is on its way. It works once and expires in ${LINK_MINUTES} minutes.</p>
<p><a href="/dashboard/login">Use a different email</a></p>`);

const confirmPage = (token) => authPage('Sign in · Lucent', `<h1>Sign in to your dashboard</h1>
<form method="post" action="/dashboard/auth"><input type="hidden" name="t" value="${esc(token)}"><button>Sign in</button></form>`);

const expiredPage = () => authPage('Link expired · Lucent', `<h1>This link has expired</h1>
<p>Sign-in links work once and expire after ${LINK_MINUTES} minutes.</p><p><a href="/dashboard/login">Send a new link</a></p>`);

function loginEmail(link, user) {
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:480px;color:#0b0b0b">
<p>Hi${user.name ? ` ${esc(user.name.split(' ')[0])}` : ''},</p>
<p>Use this button to open your Lucent lead response dashboard. It works once and expires in ${LINK_MINUTES} minutes.</p>
<p><a href="${esc(link)}" style="display:inline-block;background:#2a78d6;color:#fff;text-decoration:none;padding:11px 18px;border-radius:8px;font-weight:600">Open dashboard</a></p>
<p style="color:#52514e;font-size:13px">If you didn't ask for this, you can ignore this email.</p></div>`;
}

// The dashboard itself: a page that loads its numbers from `apiBase`.
function dashboardPage({ title, apiBase, canSignOut, banner = '' }) {
  return shell(`${title} · Lucent`, `${banner}<div id="app" data-api="${esc(apiBase)}">
<header class="top"><div class="brand">Lucent</div><div class="org" id="orgName">${esc(title)}</div>
${canSignOut ? '<form method="post" action="/dashboard/logout"><button class="link">Sign out</button></form>' : ''}</header>
<main>
<div class="filters" role="group" aria-label="Period">
<button data-range="today">Today</button><button data-range="7d">Last 7 days</button><button data-range="30d">Last 30 days</button>
<span class="updated" id="updated" aria-live="polite"></span></div>
<section class="hero card"><div><div class="hero-label">Answered within the response window</div>
<div class="hero-value" id="heroValue">–</div><div class="hero-sub" id="heroSub"></div></div>
<div class="tiles" id="tiles"></div></section>
<section class="card"><div class="card-head"><h2>Waiting for a response now</h2><span class="count" id="openCount"></span></div>
<div id="open"></div></section>
<section class="card" id="dailyCard"><div class="card-head"><h2>Leads by day</h2><button class="link" id="dailyToggle">Show as table</button></div>
<div class="legend" id="dailyLegend"></div><div id="daily" class="chart"></div></section>
<div class="two">
<section class="card"><div class="card-head"><h2>How leads were answered</h2></div><div id="channels"></div>
<p class="note">Verified = detected by Lucent or the CRM. "Replied 1" is the agent's own report.</p></section>
<section class="card"><div class="card-head"><h2>Agents</h2></div><div id="agents" class="scroll"></div></section>
</div>
<section class="card"><div class="card-head"><h2>All leads in this period</h2><span class="count" id="leadCount"></span></div>
<p class="note">Select a lead to see everything that happened to it.</p><div id="leads" class="scroll"></div></section>
</main><div id="tip" class="tip" role="tooltip" hidden></div></div>
<style>${DASH_STYLE}</style><script>${DASH_SCRIPT}</script>`);
}

const DASH_STYLE = `
.top{display:flex;align-items:center;gap:14px;padding:14px 20px;border-bottom:1px solid var(--line);background:var(--surface)}
.brand{font-weight:700;letter-spacing:.02em}.org{color:var(--ink2);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
main{max-width:1180px;margin:0 auto;padding:18px 16px 60px}
.filters{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:14px}
.filters button{border:1px solid var(--axis);background:var(--surface);color:var(--ink);border-radius:99px;padding:6px 14px;cursor:pointer}
.filters button[aria-pressed="true"]{background:var(--ink);color:var(--surface);border-color:var(--ink)}
.updated{color:var(--muted);font-size:13px;margin-left:auto}
.card{background:var(--surface);border:1px solid var(--ring);border-radius:12px;padding:18px;margin-bottom:14px}
.card h2{font-size:15px;margin:0;font-weight:600}.card-head{display:flex;align-items:baseline;gap:10px;margin-bottom:12px}
.count{color:var(--muted);font-size:13px}.card-head .link{margin-left:auto}
.link{background:none;border:0;color:var(--accent);cursor:pointer;padding:0;font-size:14px}
.hero{display:grid;grid-template-columns:minmax(220px,1fr) minmax(0,2fr);gap:24px;align-items:center}
.hero-label{color:var(--ink2);font-size:14px}.hero-value{font-size:56px;font-weight:600;line-height:1.05;margin:6px 0}
.hero-sub{color:var(--ink2);font-size:14px}
.tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
.tile{border:1px solid var(--line);border-radius:10px;padding:10px 12px}.tile .l{color:var(--ink2);font-size:13px}
.tile .v{font-size:22px;font-weight:600;margin-top:2px}.tile .s{color:var(--muted);font-size:12px}
.two{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.6fr);gap:14px}.card,.two>*,.hero>*{min-width:0}.two .card{margin-bottom:14px}
table{width:100%;border-collapse:collapse;font-size:14px}th{font-weight:500;color:var(--muted);font-size:12px;text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:8px;border-bottom:1px solid var(--line);vertical-align:top}td.n,th.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
tr:last-child td{border-bottom:0}.scroll{overflow-x:auto}
.sub{color:var(--muted);font-size:12px}
.badge{display:inline-flex;align-items:center;gap:6px;white-space:nowrap;font-size:13px}
.dot{width:8px;height:8px;border-radius:50%;flex:none}
.empty{color:var(--muted);padding:6px 0}
.note{color:var(--muted);font-size:12px;margin:10px 0 0}
.legend{display:flex;flex-wrap:wrap;gap:14px;font-size:13px;color:var(--ink2);margin-bottom:8px}
.legend span{display:inline-flex;align-items:center;gap:6px}.legend i{width:10px;height:10px;border-radius:2px;display:inline-block}
.chart svg{display:block;width:100%;height:auto;overflow:visible}
.chart .grid{stroke:var(--line);stroke-width:1}.chart .axis{stroke:var(--axis);stroke-width:1}
.chart text{fill:var(--muted);font-size:11px;font-variant-numeric:tabular-nums}
.chart .col:hover rect,.chart .col:focus rect{opacity:.8}.chart .col{outline:none;cursor:default}
.bars{display:grid;gap:10px}.bar-row .top-line{display:flex;justify-content:space-between;font-size:14px;gap:8px}
.bar-track{height:10px;margin-top:4px}.bar-fill{height:10px;background:var(--accent);border-radius:0 4px 4px 0;min-width:2px}
.lead-row{cursor:pointer}.lead-row:hover td,.lead-row:focus td{background:var(--wash)}.lead-row:focus{outline:2px solid var(--accent);outline-offset:-2px}
.timeline td{background:var(--page)}.timeline ol{list-style:none;margin:0;padding:4px 0 4px 4px}
.timeline li{display:grid;grid-template-columns:86px 1fr;gap:10px;padding:3px 0;font-size:13px}.timeline time{color:var(--muted);font-variant-numeric:tabular-nums}
.tip{position:fixed;z-index:10;pointer-events:none;background:var(--surface);color:var(--ink);border:1px solid var(--ring);box-shadow:0 4px 14px rgba(0,0,0,.12);border-radius:8px;padding:8px 10px;font-size:13px;min-width:150px}
.tip .h{color:var(--ink2);margin-bottom:4px}.tip .r{display:flex;align-items:center;gap:8px;justify-content:space-between}.tip .k{display:inline-block;width:10px;height:2px}
.tip b{font-weight:600;font-variant-numeric:tabular-nums}
.more{margin-top:10px}.loading main{opacity:.55;transition:opacity .2s}
@media (max-width:860px){.hero,.two{grid-template-columns:minmax(0,1fr)}.scroll table{min-width:560px}.updated{margin-left:0;width:100%}.tiles{grid-template-columns:repeat(2,1fr)}.hero-value{font-size:48px}}
`;

// Client script (no build step). All text is inserted with textContent.
const DASH_SCRIPT = String.raw`
(function(){
var app=document.getElementById('app'),API=app.dataset.api,TZ='America/Toronto',range='7d',data=null,timer=null;
try{var saved=localStorage.getItem('lucent-range');if(saved)range=saved;}catch(e){}
var OUT={on_time:{label:'Answered on time',color:'var(--good)'},late:{label:'Answered late',color:'var(--serious)'},not_answered:{label:'Not answered',color:'var(--critical)'},waiting:{label:'Still in window',color:'var(--wait)'}};
var ORDER=['on_time','late','not_answered','waiting'];
function el(tag,attrs,kids){var n=document.createElement(tag);if(attrs)for(var k in attrs){if(k==='text')n.textContent=attrs[k];else if(k==='class')n.className=attrs[k];else if(k.slice(0,2)==='on')n.addEventListener(k.slice(2),attrs[k]);else n.setAttribute(k,attrs[k]);}
(kids||[]).forEach(function(c){if(c!=null)n.appendChild(typeof c==='string'?document.createTextNode(c):c);});return n;}
function clear(n){while(n.firstChild)n.removeChild(n.firstChild);return n;}
function dur(s){if(s==null)return '–';s=Math.abs(Math.round(s));if(s<60)return s+' sec';var m=Math.round(s/60);if(m<60)return m+' min';var h=Math.floor(m/60),r=m%60;if(h<48)return h+' h'+(r?' '+r+' min':'');return Math.round(h/24)+' days';}
function fmtTime(iso){return new Intl.DateTimeFormat('en-CA',{timeZone:TZ,hour:'numeric',minute:'2-digit'}).format(new Date(iso));}
function fmtDay(iso){return new Intl.DateTimeFormat('en-CA',{timeZone:TZ,month:'short',day:'numeric'}).format(new Date(iso));}
function fmtWhen(iso){return fmtDay(iso)+', '+fmtTime(iso);}
function dayLabel(d){var p=d.split('-');return new Intl.DateTimeFormat('en-CA',{timeZone:'UTC',month:'short',day:'numeric'}).format(new Date(Date.UTC(+p[0],+p[1]-1,+p[2])));}
function pct(v){return v==null?'–':v+'%';}
function badge(key){var o=OUT[key];return el('span',{class:'badge'},[el('span',{class:'dot',style:'background:'+o.color}),o.label]);}
function cap(s){return s?s.charAt(0).toUpperCase()+s.slice(1):'';}

var tip=document.getElementById('tip');
function showTip(evt,head,rows){clear(tip);tip.appendChild(el('div',{class:'h',text:head}));rows.forEach(function(r){tip.appendChild(el('div',{class:'r'},[el('span',{},[el('span',{class:'k',style:'background:'+r.color}),' '+r.label]),el('b',{text:String(r.value)})]));});
tip.hidden=false;var b=evt.target.getBoundingClientRect?evt.target.getBoundingClientRect():{left:0,top:0};var x=evt.clientX!=null&&evt.clientX?evt.clientX:b.left+b.width/2,y=evt.clientY!=null&&evt.clientY?evt.clientY:b.top;
var w=tip.offsetWidth,h=tip.offsetHeight;tip.style.left=Math.min(window.innerWidth-w-8,Math.max(8,x+12))+'px';tip.style.top=Math.max(8,y-h-12)+'px';}
function hideTip(){tip.hidden=true;}

function setRange(r){range=r;shown=25;try{localStorage.setItem('lucent-range',r);}catch(e){}document.querySelectorAll('[data-range]').forEach(function(b){b.setAttribute('aria-pressed',String(b.dataset.range===r));});load();}
document.querySelectorAll('[data-range]').forEach(function(b){b.addEventListener('click',function(){setRange(b.dataset.range);});});

function load(){document.body.classList.add('loading');
fetch(API+'/data?range='+encodeURIComponent(range),{credentials:'same-origin',headers:{Accept:'application/json'}}).then(function(r){if(r.status===401){location.href='/dashboard/login';throw new Error('signed out');}if(!r.ok)throw new Error('HTTP '+r.status);return r.json();})
.then(function(d){data=d;TZ=d.org.timezone||TZ;render();}).catch(function(e){document.getElementById('updated').textContent='Could not refresh ('+e.message+'). Retrying…';})
.finally(function(){document.body.classList.remove('loading');});}

function render(){var d=data,k=d.kpis;
document.getElementById('orgName').textContent=d.org.name;
document.getElementById('updated').textContent='Updated '+fmtTime(d.generatedAt)+' · refreshes every 30 seconds';
document.getElementById('heroValue').textContent=pct(k.onTimePct);
var decided=k.onTime+k.late+k.notAnswered,w=d.org.windows;
document.getElementById('heroSub').textContent=(decided?k.onTime+' of '+decided+' leads':'No leads with a decided outcome yet')+' · windows: hot '+(w.hot||5)+' min, warm '+(w.warm||15)+' min, cold '+(w.cold||60)+' min';
var tiles=clear(document.getElementById('tiles'));
[['Leads in',String(k.leads),k.waiting?k.waiting+' still in window':''],
 ['Avg agent response',dur(k.avgResponseSec),'from reaching the agent'],
 ['Avg time to first contact',dur(k.avgFirstContactSec),'from the lead arriving'],
 ['Not answered',String(k.notAnswered),k.late?k.late+' more answered late':''],
 ['Escalated to manager',String(k.escalatedLeads),'leads'],
 ['Moved to another agent',String(k.reassignments),'reassignments']].forEach(function(t){tiles.appendChild(el('div',{class:'tile'},[el('div',{class:'l',text:t[0]}),el('div',{class:'v',text:t[1]}),el('div',{class:'s',text:t[2]})]));});
renderOpen();renderDaily();renderChannels();renderAgents();renderLeads();}

function renderOpen(){var box=clear(document.getElementById('open')),rows=data.open;document.getElementById('openCount').textContent=rows.length?rows.length+' open':'';
if(!rows.length){box.appendChild(el('div',{class:'empty',text:'Nothing waiting. Every lead has been answered.'}));return;}
var tb=el('tbody');rows.forEach(function(l){var cd=el('td',{class:'n','data-deadline':l.deadline||''});tb.appendChild(el('tr',{},[
el('td',{},[l.name,el('div',{class:'sub',text:[cap(l.temperature),l.source].filter(Boolean).join(' · ')})]),
el('td',{},[l.agent||'Unassigned',l.reassigns?el('div',{class:'sub',text:'moved '+l.reassigns+'×'}):null]),
el('td',{},[l.status==='escalated'?el('span',{class:'badge'},[el('span',{class:'dot',style:'background:var(--critical)'}),'Escalated']):el('span',{class:'badge'},[el('span',{class:'dot',style:'background:var(--wait)'}),'With agent'])]),cd]));});
box.appendChild(el('div',{class:'scroll'},[el('table',{},[el('thead',{},[el('tr',{},[el('th',{text:'Lead'}),el('th',{text:'Agent'}),el('th',{text:'Status'}),el('th',{class:'n',text:'Time left'})])]),tb])]));tick();}
function tick(){document.querySelectorAll('[data-deadline]').forEach(function(td){var dl=td.dataset.deadline;if(!dl){td.textContent='–';return;}var s=Math.round((new Date(dl)-Date.now())/1000);
clear(td);if(s>=0){var m=Math.floor(s/60),r=s%60;td.appendChild(document.createTextNode(m+':'+String(r).padStart(2,'0')));}else{td.appendChild(el('span',{class:'badge',style:'color:var(--critical-ink);font-weight:600'},['▲ ',dur(-s)+' over']));}});}
setInterval(tick,1000);

var dailyTable=false;document.getElementById('dailyToggle').addEventListener('click',function(){dailyTable=!dailyTable;this.textContent=dailyTable?'Show as chart':'Show as table';renderDaily();});
function renderDaily(){var card=document.getElementById('dailyCard'),days=data.daily;card.hidden=days.length<2;if(card.hidden)return;
var leg=clear(document.getElementById('dailyLegend'));ORDER.forEach(function(k){leg.appendChild(el('span',{},[el('i',{style:'background:'+OUT[k].color}),OUT[k].label]));});
var box=clear(document.getElementById('daily'));
if(dailyTable){var tb=el('tbody');days.slice().reverse().forEach(function(d){tb.appendChild(el('tr',{},[el('td',{text:dayLabel(d.date)})].concat(ORDER.map(function(k){return el('td',{class:'n',text:String(d[k])});}))));});
box.appendChild(el('div',{class:'scroll'},[el('table',{},[el('thead',{},[el('tr',{},[el('th',{text:'Day'})].concat(ORDER.map(function(k){return el('th',{class:'n',text:OUT[k].label});})))]),tb])]));return;}
var W=Math.max(box.clientWidth||700,280),H=200,L=30,B=22,T=8,plotW=W-L-4,plotH=H-B-T;
var max=Math.max(1,Math.max.apply(null,days.map(function(d){return ORDER.reduce(function(a,k){return a+d[k];},0);})));
var step=max<=4?1:max<=10?2:max<=25?5:max<=50?10:Math.ceil(max/50)*10;var top=Math.ceil(max/step)*step;
var NS='http://www.w3.org/2000/svg';function s(tag,a){var n=document.createElementNS(NS,tag);for(var k in a)n.setAttribute(k,a[k]);return n;}
var svg=s('svg',{viewBox:'0 0 '+W+' '+H,role:'img','aria-label':'Leads per day by outcome'});
for(var v=0;v<=top;v+=step){var y=T+plotH-(v/top)*plotH;svg.appendChild(s('line',{x1:L,x2:W,y1:y,y2:y,class:v===0?'axis':'grid'}));var tx=s('text',{x:L-6,y:y+4,'text-anchor':'end'});tx.textContent=String(v);svg.appendChild(tx);}
var band=plotW/days.length,bw=Math.min(24,band*0.62),every=Math.ceil(days.length/(W<480?6:12));
days.forEach(function(d,i){var x=L+band*i+(band-bw)/2,y0=T+plotH,g=s('g',{class:'col',tabindex:'0'});
var segs=ORDER.filter(function(k){return d[k]>0;});segs.forEach(function(k,j){var h=(d[k]/top)*plotH,gap=j>0?2:0;var hh=Math.max(0,h-gap);y0-=h;
var last=j===segs.length-1,r=last?Math.min(4,hh/2,bw/2):0;
var p=last?'M'+x+','+(y0+gap+hh)+'V'+(y0+gap+r)+'Q'+x+','+(y0+gap)+' '+(x+r)+','+(y0+gap)+'H'+(x+bw-r)+'Q'+(x+bw)+','+(y0+gap)+' '+(x+bw)+','+(y0+gap+r)+'V'+(y0+gap+hh)+'Z'
:'M'+x+','+(y0+gap+hh)+'V'+(y0+gap)+'H'+(x+bw)+'V'+(y0+gap+hh)+'Z';
g.appendChild(s('path',{d:p,fill:OUT[k].color}));});
var hit=s('rect',{x:L+band*i,y:T,width:band,height:plotH,fill:'transparent'});g.insertBefore(hit,g.firstChild);
var total=ORDER.reduce(function(a,k){return a+d[k];},0);
function show(e){showTip(e,dayLabel(d.date)+' · '+total+' lead'+(total===1?'':'s'),ORDER.map(function(k){return{label:OUT[k].label,value:d[k],color:OUT[k].color};}));}
g.addEventListener('pointermove',show);g.addEventListener('pointerleave',hideTip);g.addEventListener('focus',show);g.addEventListener('blur',hideTip);
g.setAttribute('aria-label',dayLabel(d.date)+': '+ORDER.map(function(k){return d[k]+' '+OUT[k].label.toLowerCase();}).join(', '));svg.appendChild(g);
if(i%every===0||i===days.length-1){var t=s('text',{x:L+band*i+band/2,y:H-6,'text-anchor':'middle'});t.textContent=dayLabel(d.date);svg.appendChild(t);}});
box.appendChild(svg);}

function renderChannels(){var box=clear(document.getElementById('channels')),rows=data.channels;
if(!rows.length){box.appendChild(el('div',{class:'empty',text:'No answered leads in this period.'}));return;}
var max=Math.max.apply(null,rows.map(function(r){return r.count;})),total=rows.reduce(function(a,r){return a+r.count;},0),list=el('div',{class:'bars'});
rows.forEach(function(r){list.appendChild(el('div',{class:'bar-row'},[el('div',{class:'top-line'},[el('span',{},[r.label,el('span',{class:'sub',text:r.verified?'  verified':''})]),el('span',{class:'n'},[el('b',{text:String(r.count)}),el('span',{class:'sub',text:' · '+Math.round(r.count/total*100)+'%'})])]),
el('div',{class:'bar-track'},[el('div',{class:'bar-fill',style:'width:'+Math.max(1,r.count/max*100)+'%'})])]));});box.appendChild(list);}

var CH_SHORT={tap_to_call:'tap-to-call',fub_call:'FUB call',fub_text:'FUB text',fub_email:'FUB email',boldtrail_call:'BoldTrail call',sms_reply:'replied 1',unknown:'not recorded'};
function renderAgents(){var box=clear(document.getElementById('agents')),rows=data.agents;
if(!rows.length){box.appendChild(el('div',{class:'empty',text:'No agents yet.'}));return;}
var tb=el('tbody');rows.forEach(function(a){var how=Object.keys(a.channels).sort(function(x,y){return a.channels[y]-a.channels[x];}).map(function(k){return a.channels[k]+' '+CH_SHORT[k];}).join(', ');
tb.appendChild(el('tr',{},[el('td',{},[a.name,!a.active?el('div',{class:'sub',text:'switched off'}):how?el('div',{class:'sub',text:how}):null]),
el('td',{class:'n',text:String(a.received)}),el('td',{class:'n',text:String(a.answered)}),el('td',{class:'n',text:pct(a.onTimePct)}),el('td',{class:'n',text:dur(a.avgResponseSec)}),
el('td',{class:'n',style:a.missed?'color:var(--critical-ink);font-weight:600':'',text:String(a.missed)}),el('td',{class:'n',text:String(a.movedAway)})]));});
box.appendChild(el('table',{},[el('thead',{},[el('tr',{},[el('th',{text:'Agent'}),el('th',{class:'n',text:'Leads'}),el('th',{class:'n',text:'Answered'}),el('th',{class:'n',text:'On time'}),el('th',{class:'n',text:'Avg response'}),el('th',{class:'n',text:'Missed'}),el('th',{class:'n',text:'Moved away'})])]),tb]));}

var openLead=null,shown=25;
function renderLeads(){var box=clear(document.getElementById('leads')),all=data.recent,rows=all.slice(0,shown);document.getElementById('leadCount').textContent=data.kpis.leads+' lead'+(data.kpis.leads===1?'':'s')+(data.kpis.leads>rows.length?' · newest '+rows.length+' shown':'');
if(!rows.length){box.appendChild(el('div',{class:'empty',text:'No leads in this period.'}));return;}
var tb=el('tbody');rows.forEach(function(l){var tr=el('tr',{class:'lead-row',tabindex:'0','aria-expanded':'false'},[
el('td',{class:'n',style:'text-align:left',text:fmtWhen(l.createdAt)}),el('td',{},[l.name,el('div',{class:'sub',text:[cap(l.temperature),l.source].filter(Boolean).join(' · ')})]),
el('td',{},[l.agent||'–',l.reassigns?el('div',{class:'sub',text:'moved '+l.reassigns+'×'}):null]),el('td',{},[badge(l.outcome)]),
el('td',{class:'n',text:dur(l.firstContactSec)}),el('td',{text:l.channelLabel||'–'})]);
function toggle(){var nx=tr.nextSibling;if(nx&&nx.classList&&nx.classList.contains('timeline')){nx.remove();tr.setAttribute('aria-expanded','false');openLead=null;return;}
var cell=el('td',{colspan:'6'},[el('div',{class:'sub',text:'Loading…'})]),row=el('tr',{class:'timeline'},[cell]);tr.after(row);tr.setAttribute('aria-expanded','true');openLead=l.id;
fetch(API+'/leads/'+encodeURIComponent(l.id),{credentials:'same-origin'}).then(function(r){if(!r.ok)throw new Error();return r.json();}).then(function(t){clear(cell);var ol=el('ol');
t.events.forEach(function(e){ol.appendChild(el('li',{},[el('time',{text:fmtTime(e.at)}),el('span',{text:e.text})]));});if(!t.events.length)ol.appendChild(el('li',{},[el('span',{class:'sub',text:'No history recorded.'})]));cell.appendChild(ol);})
.catch(function(){clear(cell).appendChild(el('div',{class:'sub',text:'Could not load this lead.'}));});}
tr.addEventListener('click',toggle);tr.addEventListener('keydown',function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();toggle();}});tb.appendChild(tr);
if(openLead===l.id)setTimeout(toggle,0);});
box.appendChild(el('table',{},[el('thead',{},[el('tr',{},[el('th',{text:'Arrived'}),el('th',{text:'Lead'}),el('th',{text:'Agent'}),el('th',{text:'Outcome'}),el('th',{class:'n',text:'First contact'}),el('th',{text:'How'})])]),tb]));
if(all.length>rows.length)box.appendChild(el('button',{class:'link more',text:'Show '+Math.min(25,all.length-rows.length)+' more',onclick:function(){shown+=25;renderLeads();}}));}

var rz;window.addEventListener('resize',function(){clearTimeout(rz);rz=setTimeout(function(){if(data&&!dailyTable)renderDaily();},150);});
setRange(['today','7d','30d'].indexOf(range)>=0?range:'7d');
timer=setInterval(function(){if(!document.hidden)load();},30000);
document.addEventListener('visibilitychange',function(){if(!document.hidden)load();});
})();
`;

// ---------- router ----------

function createDashboardRouter({ store, data, mailer = null, fromEmail = null, sessionKey, linkBaseUrl, log = console, now = () => Date.now() }) {
  const router = express.Router();
  if (!sessionKey) return router;
  const sessions = createSessions(sessionKey, { now });
  const base = String(linkBaseUrl || '').replace(/\/+$/, '');
  const form = express.urlencoded({ extended: false, limit: '4kb' });
  const secure = base.startsWith('https://');

  // Light limit on link requests: 5 per email and 20 per address each 15 minutes.
  const hits = new Map();
  const limited = (key, max) => {
    const t = now();
    const list = (hits.get(key) || []).filter((x) => t - x < 15 * 60 * 1000);
    list.push(t);
    hits.set(key, list);
    if (hits.size > 5000) hits.delete(hits.keys().next().value);
    return list.length > max;
  };
  const sameOrigin = (req) => {
    const origin = req.headers.origin || req.headers.referer || '';
    try { return new URL(origin).host === req.headers.host; } catch { return false; }
  };
  const cookie = (res, value, maxAgeSec) => res.append('Set-Cookie',
    `${COOKIE}=${encodeURIComponent(value)}; Path=/dashboard; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`);

  router.use('/dashboard', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Frame-Options', 'DENY');
    res.set('Referrer-Policy', 'no-referrer');
    if (req.method === 'POST' && !sameOrigin(req)) return res.status(403).send('Forbidden');
    next();
  });

  // Who is signed in (null if nobody, or if their access was removed).
  async function currentUser(req) {
    const s = sessions.read(readCookie(req, COOKIE));
    if (!s) return null;
    const user = await store.getUser(s.u);
    return user && user.org_id === s.o ? user : null;
  }
  const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
    log.error('Dashboard error:', e.message);
    res.status(500).send('Something went wrong. Please try again.');
  });

  router.get('/dashboard/login', (req, res) => res.send(loginPage()));

  router.post('/dashboard/login', form, wrap(async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!EMAIL.test(email)) return res.status(400).send(loginPage('Please enter a valid email address.'));
    if (limited(`e:${email}`, 5) || limited(`ip:${req.ip}`, 20)) return res.send(sentPage());
    const users = await store.usersByEmail(email);
    for (const user of users) {
      const token = crypto.randomBytes(32).toString('base64url');
      await store.createToken(sha256(token), user.id, new Date(now() + LINK_MINUTES * 60000).toISOString());
      const link = `${base}/dashboard/auth?t=${token}`;
      if (mailer) {
        await mailer.send({ to: user.email, from: fromEmail, subject: 'Your Lucent dashboard sign-in link', html: loginEmail(link, user) })
          .catch((e) => log.error('Dashboard link email failed:', e.message));
      }
    }
    res.send(sentPage());
  }));

  router.get('/dashboard/auth', wrap(async (req, res) => {
    const token = String(req.query.t || '');
    if (!token || !(await store.peekToken(sha256(token)))) return res.status(410).send(expiredPage());
    res.send(confirmPage(token));
  }));

  router.post('/dashboard/auth', form, wrap(async (req, res) => {
    const userId = await store.consumeToken(sha256(String(req.body?.t || '')));
    const user = userId && await store.getUser(userId);
    if (!user) return res.status(410).send(expiredPage());
    await store.touchLogin(user.id).catch(() => {});
    cookie(res, sessions.make(user), SESSION_DAYS * 86400);
    res.redirect(303, '/dashboard');
  }));

  router.post('/dashboard/logout', (req, res) => {
    cookie(res, '', 0);
    res.redirect(303, '/dashboard/login');
  });

  router.get('/dashboard', wrap(async (req, res) => {
    const user = await currentUser(req);
    if (!user) return res.redirect(303, '/dashboard/login');
    const org = await store.getOrg(user.org_id);
    res.send(dashboardPage({ title: org?.name || 'Dashboard', apiBase: '/dashboard', canSignOut: true }));
  }));

  router.get('/dashboard/data', wrap(async (req, res) => {
    const user = await currentUser(req);
    if (!user) return res.status(401).json({ error: 'Sign in required' });
    const out = await data.summary(user.org_id, String(req.query.range || '7d'));
    if (!out) return res.status(404).json({ error: 'Not found' });
    res.json(out);
  }));

  router.get('/dashboard/leads/:id', wrap(async (req, res) => {
    const user = await currentUser(req);
    if (!user) return res.status(401).json({ error: 'Sign in required' });
    const out = await data.lead(user.org_id, req.params.id);
    if (!out) return res.status(404).json({ error: 'Not found' });
    res.json(out);
  }));

  return router;
}

module.exports = {
  createDashboardRouter, createDashboardStore, createDashboardData, createSessions,
  deriveSessionKey, dashboardPage, readCookie,
};
