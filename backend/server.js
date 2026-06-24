require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

app.use(cors());
app.use(express.json());

// Get all market signals (country summaries)
app.get('/api/signals', async (req, res) => {
  const { data, error } = await supabase
    .from('property_signals')
    .select('*')
    .order('scanned_at', { ascending: false });
  if (error) return res.status(500).json({ error });
  // Sort by market_score for display after fetching latest scans
  const sorted = (data || []).sort((a, b) => (b.market_score || 0) - (a.market_score || 0));
  res.json(sorted);
});

// Get all individual listings
app.get('/api/listings', async (req, res) => {
  const { data, error } = await supabase
    .from('property_listings')
    .select('*')
    .order('scanned_at', { ascending: false })
    .limit(200);
  if (error) return res.status(500).json({ error });
  res.json(data);
});

// Get listings by country
app.get('/api/listings/:code', async (req, res) => {
  const { data, error } = await supabase
    .from('property_listings')
    .select('*')
    .eq('country_code', req.params.code.toUpperCase())
    .order('scanned_at', { ascending: false });
  if (error) return res.status(500).json({ error });
  res.json(data);
});

// Health check
app.get('/api/health', async (req, res) => {
  const { count } = await supabase
    .from('property_listings')
    .select('*', { count: 'exact', head: true });
  res.json({
    status: 'ok',
    records: count,
    timestamp: new Date().toISOString()
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
