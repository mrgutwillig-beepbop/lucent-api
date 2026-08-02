const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../index');

process.env.API_SECRET_KEY = 'test-secret';

// -----------------------------------------------------------------------------
// A minimal Supabase mock covering exactly the chained calls the intake handler
// makes:
//   from('leads').insert(row).select().single()
//   from('lead_events').insert(row)            (awaited directly)
//   from('organizations').select('name').eq('id', x).single()
// -----------------------------------------------------------------------------
function makeSupabaseMock({ org = { name: 'Acme Realty' }, leadInsertError = null } = {}) {
  const captured = { leadInsert: null, leadEventInsert: null, orgQueriedId: null };

  const awaitable = (result) => ({
    select: () => awaitable(result),
    single: () => Promise.resolve(result),
    then: (onF, onR) => Promise.resolve(result).then(onF, onR),
  });

  const supabase = {
    _captured: captured,
    from(table) {
      return {
        insert(row) {
          if (table === 'leads') {
            captured.leadInsert = row;
            return awaitable({
              data: leadInsertError ? null : { id: 'lead-uuid-1', ...row },
              error: leadInsertError,
            });
          }
          if (table === 'lead_events') {
            captured.leadEventInsert = row;
            return awaitable({ data: null, error: null });
          }
          return awaitable({ data: null, error: null });
        },
        select() {
          return {
            eq(_col, val) {
              captured.orgQueriedId = val;
              return { single: () => Promise.resolve({ data: org, error: null }) };
            },
          };
        },
      };
    },
  };

  return supabase;
}

function makeTwilioMock({ throwOnSend = false } = {}) {
  const calls = [];
  return {
    calls,
    messages: {
      create: async (opts) => {
        calls.push(opts);
        if (throwOnSend) throw new Error('Twilio boom');
        return { sid: 'SM_test_123' };
      },
    },
  };
}

// Start the app on an ephemeral port, run `fn(baseUrl)`, then close.
async function withServer(app, fn) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  try {
    const { port } = server.address();
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

function intake(baseUrl, body) {
  return fetch(`${baseUrl}/api/leads/intake`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'test-secret' },
    body: JSON.stringify(body),
  });
}

test('intake with a valid phone sends the SMS with org name and normalized number', async () => {
  const supabase = makeSupabaseMock({ org: { name: 'Acme Realty' } });
  const twilioClient = makeTwilioMock();
  const app = createApp({ supabase, twilioClient, twilioFromNumber: '+15005550006' });

  await withServer(app, async (baseUrl) => {
    const res = await intake(baseUrl, {
      org_id: 'org-1',
      first_name: 'Jane',
      last_name: 'Doe',
      phone: '(415) 555-2671',
    });
    const json = await res.json();

    assert.equal(res.status, 201);
    assert.equal(json.success, true);
    assert.equal(json.sms_sent, true);

    // Org name was looked up for the correct org
    assert.equal(supabase._captured.orgQueriedId, 'org-1');

    // Twilio was called exactly once, with the expected payload
    assert.equal(twilioClient.calls.length, 1);
    assert.deepEqual(twilioClient.calls[0], {
      to: '+14155552671',
      from: '+15005550006',
      body: 'Thanks for your inquiry. An agent from Acme Realty will contact you shortly.',
    });
  });
});

test('intake with email only (no phone) does NOT send an SMS but still succeeds', async () => {
  const supabase = makeSupabaseMock();
  const twilioClient = makeTwilioMock();
  const app = createApp({ supabase, twilioClient, twilioFromNumber: '+15005550006' });

  await withServer(app, async (baseUrl) => {
    const res = await intake(baseUrl, {
      org_id: 'org-1',
      first_name: 'Jane',
      email: 'jane@example.com',
    });
    const json = await res.json();

    assert.equal(res.status, 201);
    assert.equal(json.sms_sent, false);
    assert.equal(twilioClient.calls.length, 0);
  });
});

test('intake with an invalid phone does NOT send an SMS but still succeeds', async () => {
  const supabase = makeSupabaseMock();
  const twilioClient = makeTwilioMock();
  const app = createApp({ supabase, twilioClient, twilioFromNumber: '+15005550006' });

  await withServer(app, async (baseUrl) => {
    const res = await intake(baseUrl, {
      org_id: 'org-1',
      first_name: 'Jane',
      phone: '123', // too short to be valid
      email: 'jane@example.com',
    });
    const json = await res.json();

    assert.equal(res.status, 201);
    assert.equal(json.sms_sent, false);
    assert.equal(twilioClient.calls.length, 0);
  });
});

test('intake still succeeds (201) when the SMS send throws', async () => {
  const supabase = makeSupabaseMock();
  const twilioClient = makeTwilioMock({ throwOnSend: true });
  const app = createApp({ supabase, twilioClient, twilioFromNumber: '+15005550006' });

  await withServer(app, async (baseUrl) => {
    const res = await intake(baseUrl, {
      org_id: 'org-1',
      first_name: 'Jane',
      phone: '+14155552671',
    });
    const json = await res.json();

    assert.equal(res.status, 201);
    assert.equal(json.success, true);
    assert.equal(json.sms_sent, false); // send failed, but intake was not blocked
    assert.equal(twilioClient.calls.length, 1); // it was attempted
  });
});

test('intake rejects unauthenticated requests', async () => {
  const supabase = makeSupabaseMock();
  const app = createApp({ supabase, twilioClient: makeTwilioMock(), twilioFromNumber: '+1' });

  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/leads/intake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ org_id: 'org-1', phone: '+14155552671' }),
    });
    assert.equal(res.status, 401);
  });
});
