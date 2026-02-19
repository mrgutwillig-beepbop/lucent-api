require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY // Use service key for admin access
);

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
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// =====================================================
// POST /api/leads/intake
// Receives webhook from CRM, creates lead in Supabase
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
    
    // Validate required fields
    if (!org_id) {
      return res.status(400).json({ error: 'org_id is required' });
    }
    
    if (!email && !phone) {
      return res.status(400).json({ error: 'Either email or phone is required' });
    }
    
    // Create lead in Supabase
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
    
    // Log event
    await supabase.from('lead_events').insert({
      lead_id: lead.id,
      org_id: lead.org_id,
      event_type: 'created',
      event_data: { source: lead.source }
    });
    
    res.status(201).json({
      success: true,
      lead_id: lead.id,
      status: 'pending_assignment'
    });
    
  } catch (error) {
    console.error('Intake error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// =====================================================
// POST /api/leads/:id/assign
// Assigns a lead to next available agent
// =====================================================

app.post('/api/leads/:id/assign', authenticateRequest, async (req, res) => {
  try {
    const { id: leadId } = req.params;
    
    // Call PostgreSQL function to assign lead
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
// Marks a lead as contacted by agent
// =====================================================

app.post('/api/leads/:id/contacted', authenticateRequest, async (req, res) => {
  try {
    const { id: leadId } = req.params;
    
    // Call PostgreSQL function
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
// Gets all leads past their SLA deadline for monitoring
// =====================================================

app.get('/api/organizations/:org_id/overdue-leads', authenticateRequest, async (req, res) => {
  try {
    const { org_id } = req.params;
    
    // Call PostgreSQL function
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
// Escalates a lead that's overdue
// =====================================================

app.post('/api/leads/:id/escalate', authenticateRequest, async (req, res) => {
  try {
    const { id: leadId } = req.params;
    const { tier = 1 } = req.body;
    
    // Call PostgreSQL function
    const { data, error } = await supabase
      .rpc('escalate_lead', { 
        p_lead_id: leadId,
        p_tier: tier
      });
    
    if (error) {
      console.error('Escalation error:', error);
      return res.status(500).json({ error: 'Failed to escalate lead', details: error.message });
    }
    
    res.json({
      success: true,
      lead_id: leadId,
      escalation_id: data,
      tier,
      escalated_at: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Escalate error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// =====================================================
// GET /api/organizations/:org_id/stats
// Get basic stats for a client
// =====================================================

app.get('/api/organizations/:org_id/stats', authenticateRequest, async (req, res) => {
  try {
    const { org_id } = req.params;
    
    // Get lead counts by status
    const { data: leads, error: leadsError } = await supabase
      .from('leads')
      .select('status')
      .eq('org_id', org_id);
    
    if (leadsError) throw leadsError;
    
    // Calculate stats
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
    
    // Get average response time for contacted leads (last 30 days)
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

// =====================================================
// START SERVER
// =====================================================

app.listen(PORT, () => {
  console.log(`✅ Lucent API running on port ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
});

// =====================================================
// EXAMPLE REQUESTS (for testing with curl)
// =====================================================

/*

1. CREATE A LEAD (webhook simulation):

curl -X POST http://localhost:3000/api/leads/intake \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-secret-key" \
  -d '{
    "org_id": "00000000-0000-0000-0000-000000000001",
    "first_name": "John",
    "last_name": "Doe",
    "phone": "+15559876543",
    "email": "john@example.com",
    "source": "followupboss",
    "lead_temperature": "hot"
  }'

2. ASSIGN THE LEAD:

curl -X POST http://localhost:3000/api/leads/{LEAD_ID}/assign \
  -H "X-API-Key: your-secret-key"

3. MARK AS CONTACTED:

curl -X POST http://localhost:3000/api/leads/{LEAD_ID}/contacted \
  -H "X-API-Key: your-secret-key"

4. GET OVERDUE LEADS:

curl http://localhost:3000/api/organizations/00000000-0000-0000-0000-000000000001/overdue-leads \
  -H "X-API-Key: your-secret-key"

5. ESCALATE A LEAD:

curl -X POST http://localhost:3000/api/leads/{LEAD_ID}/escalate \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-secret-key" \
  -d '{"tier": 1}'

6. GET ORG STATS:

curl http://localhost:3000/api/organizations/00000000-0000-0000-0000-000000000001/stats \
  -H "X-API-Key: your-secret-key"

*/
