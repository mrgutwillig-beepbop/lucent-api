const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  createEnforcementWorker,
  agentAssignmentMessage,
  managerEscalationMessage,
} = require('../enforcement');

const NOW = new Date('2026-10-01T15:00:00Z');
const quietLog = { log() {}, error() {} };

function lead(overrides = {}) {
  return {
    id: 'L1',
    first_name: 'Maria',
    last_name: 'Garcia',
    phone: '+14165550101',
    source: 'zillow',
    assigned_at: '2026-10-01T14:50:00Z',
    sla_deadline: '2026-10-01T14:55:00Z',
    reassign_count: 0,
    last_escalation_at: null,
    agents: { name: 'Sarah', phone: '+14165550111' },
    organizations: {
      name: 'Acme',
      primary_contact_email: 'boss@acme.test',
      primary_contact_phone: '+14165550199',
      reassign_after_minutes: 5,
      max_reassignments: 2,
    },
    ...overrides,
  };
}

function setup({ unnotified = [], overdue = [], escalated = [], claim = true, escalateId = 'E1', reassignResult = null } = {}) {
  const sms = [];
  const emails = [];
  const calls = { claim: [], escalate: [], reassign: [] };
  const store = {
    listUnnotifiedAssignments: async () => unnotified,
    claimNotification: async (id) => { calls.claim.push(id); return claim; },
    listOverdueAssigned: async () => overdue,
    escalate: async (id) => { calls.escalate.push(id); return escalateId; },
    listEscalatedUncontacted: async () => escalated,
    reassign: async (id) => { calls.reassign.push(id); return reassignResult; },
  };
  const notifier = {
    sms: async (to, body) => { sms.push({ to, body }); return { sent: true }; },
    email: async (to, l) => { emails.push({ to, id: l.id }); },
  };
  const worker = createEnforcementWorker({ store, notifier, now: () => NOW, log: quietLog });
  return { worker, sms, emails, calls };
}

test('texts the assigned agent once the lead is claimed', async () => {
  const { worker, sms } = setup({ unnotified: [lead()] });
  assert.equal(await worker.notifyAssignments(), 1);
  assert.equal(sms.length, 1);
  assert.equal(sms[0].to, '+14165550111');
  assert.match(sms[0].body, /New lead assigned to you/);
  assert.match(sms[0].body, /Maria Garcia/);
  assert.match(sms[0].body, /within 5 min/);
});

test('does not text when another pass already claimed the lead', async () => {
  const { worker, sms } = setup({ unnotified: [lead()], claim: false });
  assert.equal(await worker.notifyAssignments(), 0);
  assert.equal(sms.length, 0);
});

test('skips agents with no valid phone without failing', async () => {
  const { worker, sms } = setup({ unnotified: [lead({ agents: { name: 'X', phone: null } })] });
  assert.equal(await worker.notifyAssignments(), 0);
  assert.equal(sms.length, 0);
});

test('escalation texts and emails the manager', async () => {
  const { worker, sms, emails, calls } = setup({ overdue: [lead()] });
  assert.equal(await worker.escalateOverdue(), 1);
  assert.deepEqual(calls.escalate, ['L1']);
  assert.equal(sms[0].to, '+14165550199');
  assert.match(sms[0].body, /Sarah has not responded/);
  assert.match(sms[0].body, /reassigned in 5 min/);
  assert.deepEqual(emails, [{ to: 'boss@acme.test', id: 'L1' }]);
});

test('no manager alert when the lead was contacted meanwhile', async () => {
  const { worker, sms, emails } = setup({ overdue: [lead()], escalateId: null });
  assert.equal(await worker.escalateOverdue(), 0);
  assert.equal(sms.length, 0);
  assert.equal(emails.length, 0);
});

test('reassigns after the org window and tells the previous agent', async () => {
  const escalatedLead = lead({ status: 'escalated', last_escalation_at: '2026-10-01T14:54:00Z' });
  const { worker, sms, calls } = setup({
    escalated: [escalatedLead],
    reassignResult: { new_agent_name: 'Tom', previous_agent_phone: '+14165550111' },
  });
  assert.equal(await worker.reassignStale(), 1);
  assert.deepEqual(calls.reassign, ['L1']);
  assert.equal(sms[0].to, '+14165550111');
  assert.match(sms[0].body, /reassigned to another agent/);
});

test('does not reassign before the window has passed', async () => {
  const escalatedLead = lead({ status: 'escalated', last_escalation_at: '2026-10-01T14:58:00Z' });
  const { worker, calls } = setup({ escalated: [escalatedLead] });
  assert.equal(await worker.reassignStale(), 0);
  assert.equal(calls.reassign.length, 0);
});

test('stops reassigning once the org maximum is reached', async () => {
  const escalatedLead = lead({ status: 'escalated', last_escalation_at: '2026-10-01T14:00:00Z', reassign_count: 2 });
  const { worker, calls } = setup({ escalated: [escalatedLead] });
  assert.equal(await worker.reassignStale(), 0);
  assert.equal(calls.reassign.length, 0);
});

test('one failing step does not stop the others', async () => {
  const { worker } = setup({ overdue: [lead()] });
  const w = worker;
  const r = await w.tick();
  assert.equal(r.escalated, 1);
});

test('message wording', () => {
  assert.match(agentAssignmentMessage(lead({ reassign_count: 1 })), /Lead reassigned to you/);
  assert.doesNotMatch(
    managerEscalationMessage(lead({ reassign_count: 2 })),
    /reassigned in/
  );
});
