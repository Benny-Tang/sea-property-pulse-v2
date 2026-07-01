require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

const APIFY_ACTOR_ID = 'apify~google-search-scraper';
const APIFY_BASE_URL = 'https://api.apify.com/v2';

const MARKETS = [
  { country: 'Malaysia', code: 'MY', currency: 'MYR', flag: '🇲🇾', queries: [
    'property for sale Kuala Lumpur site:propertyguru.com.my',
    'buy condo Kuala Lumpur 2026',
    'Malaysia property investment opportunity 2026'
  ]},
  { country: 'Singapore', code: 'SG', currency: 'SGD', flag: '🇸🇬', queries: [
    'property for sale Singapore site:propertyguru.com.sg',
    'buy condo Singapore 2026',
    'Singapore property investment opportunity 2026'
  ]},
  { country: 'Thailand', code: 'TH', currency: 'THB', flag: '🇹🇭', queries: [
    'property for sale Bangkok site:ddproperty.com',
    'buy condo Bangkok 2026',
    'Thailand property investment opportunity 2026'
  ]},
  { country: 'Indonesia', code: 'ID', currency: 'IDR', flag: '🇮🇩', queries: [
    'property for sale Jakarta site:rumah123.com',
    'buy apartment Jakarta 2026',
    'Indonesia property investment opportunity 2026'
  ]},
  { country: 'Philippines', code: 'PH', currency: 'PHP', flag: '🇵🇭', queries: [
    'property for sale Manila site:lamudi.com.ph',
    'buy condo Manila 2026',
    'Philippines property investment opportunity 2026'
  ]},
  { country: 'Vietnam', code: 'VN', currency: 'VND', flag: '🇻🇳', queries: [
    'property for sale Ho Chi Minh site:batdongsan.com.vn',
    'buy apartment Ho Chi Minh 2026',
    'Vietnam property investment opportunity 2026'
  ]}
];

// ─── APIFY: Run Actor and wait for results ───────────────────────────────────
async function scrapeQuery(market, query) {
  console.log(`🔍 Scraping: ${query}`);
  try {
    const runRes = await axios.post(
      `${APIFY_BASE_URL}/acts/${APIFY_ACTOR_ID}/runs?token=${process.env.APIFY_TOKEN}`,
      {
        queries: query,
        maxPagesPerQuery: 1,
        resultsPerPage: 10,
        mobileResults: false,
        languageCode: 'en',
        maxConcurrency: 1
      },
      { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
    );

    const runId = runRes.data.data.id;
    console.log(`  ▶ Actor run started: ${runId}`);

    let status = 'RUNNING';
    let attempts = 0;
    while (status === 'RUNNING' || status === 'READY') {
      await new Promise(r => setTimeout(r, 5000));
      const statusRes = await axios.get(
        `${APIFY_BASE_URL}/actor-runs/${runId}?token=${process.env.APIFY_TOKEN}`
      );
      status = statusRes.data.data.status;
      attempts++;
      if (attempts > 24) { console.error(`  ⚠ Timeout for run ${runId}`); return null; }
    }

    if (status !== 'SUCCEEDED') {
      console.error(`  ❌ Actor run failed: ${status}`);
      return null;
    }

    const datasetId = runRes.data.data.defaultDatasetId;
    const resultsRes = await axios.get(
      `${APIFY_BASE_URL}/datasets/${datasetId}/items?token=${process.env.APIFY_TOKEN}&format=json`
    );

    const items = resultsRes.data;
    if (!items || items.length === 0) { console.warn(`  ⚠ No results for: ${query}`); return null; }

    console.log(`  ✅ Got ${items.length} result pages`);
    return items;

  } catch (error) {
    console.error(`❌ Apify error:`, error.response?.data?.error?.message || error.message);
    return null;
  }
}

// ─── GEMINI: Analyze search results ─────────────────────────────────────────
async function analyzeWithGemini(market, rawData, query) {
  console.log(`🤖 Analyzing with Gemini AI...`);
  try {
    const searchResults = rawData.flatMap(page =>
      (page.organicResults || []).map(r => ({
        title: r.title,
        url: r.url,
        description: r.description
      }))
    ).slice(0, 20);

    const prompt = `You are a real estate market analyst specializing in Southeast Asia.

Analyze this Google search data for ${market.country} property market.
Query used: "${query}"

Search results:
${JSON.stringify(searchResults)}

Extract up to 10 individual property signals from the results.
Classify each as:
- "buyer_intent" = people looking to buy, demand signals
- "seller_stress" = price drops, urgent sales, oversupply
- "momentum" = new launches, investment hotspots, growth areas

Respond ONLY with a valid JSON array, no markdown, no code fences:
[
  {
    "title": "listing or article title",
    "url": "url if available or null",
    "snippet": "brief description max 100 chars",
    "signal_type": "buyer_intent",
    "price": "price if mentioned or null",
    "location": "specific area or city",
    "source": "website source name"
  }
]`;

    const result = await model.generateContent(prompt);
    const text = result.response.text();
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
    return [];
  } catch (error) {
    console.error(`❌ Gemini error:`, error.message);
    return [];
  }
}

// ─── SUPABASE: Save individual listings ─────────────────────────────────────
async function saveListings(market, listings) {
  console.log(`💾 Saving ${listings.length} listings for ${market.country}...`);
  const rows = listings.map(l => ({
    country: market.country,
    country_code: market.code,
    title: l.title,
    url: l.url,
    snippet: l.snippet,
    signal_type: l.signal_type,
    price: l.price,
    location: l.location,
    source: l.source,
    scanned_at: new Date().toISOString()
  }));

  const { error } = await supabase.from('property_listings').insert(rows);
  if (error) {
    console.error(`❌ Supabase error:`, error.message);
  } else {
    console.log(`✅ ${listings.length} listings saved for ${market.country}`);
  }
}

// ─── SUPABASE: Save market signal summary ───────────────────────────────────
async function saveMarketSignal(market, listings) {
  if (!listings || listings.length === 0) {
    await supabase.from('property_signals')
      .update({ scanned_at: new Date().toISOString() })
      .eq('country_code', market.code);
    return;
  }

  try {
    const prompt = `You are a real estate market analyst for Southeast Asia.

Based on these ${listings.length} property signals collected for ${market.country}:
${JSON.stringify(listings.slice(0, 20))}

Generate a market summary. Respond ONLY with valid JSON (no markdown, no code fences):
{
  "sentiment": "hot|warm|cool|cold",
  "market_score": <number 1-10>,
  "avg_price_range": "<currency range string>",
  "summary": "<2-3 sentence market overview>",
  "hot_locations": ["<city/area>", "<city/area>", "<city/area>"],
  "trends": ["<trend 1>", "<trend 2>", "<trend 3>"]
}`;

    const result = await model.generateContent(prompt);
    const text = result.response.text();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in Gemini response');
    const signal = JSON.parse(jsonMatch[0]);

    const nowISO = new Date().toISOString();
    const payload = {
      country_code: market.code,
      country: market.country,
      sentiment: signal.sentiment,
      market_score: signal.market_score,
      avg_price_range: signal.avg_price_range,
      summary: signal.summary,
      hot_locations: signal.hot_locations,
      trends: signal.trends,
      scanned_at: nowISO
    };

    const { data: existing } = await supabase
      .from('property_signals').select('id').eq('country_code', market.code).limit(1);

    if (existing && existing.length > 0) {
      await supabase.from('property_signals').update(payload).eq('country_code', market.code);
    } else {
      await supabase.from('property_signals').insert(payload);
    }
    console.log(`📊 Signal saved for ${market.country} — ${signal.sentiment} (${signal.market_score}/10)`);

  } catch (err) {
    console.error(`❌ Signal save failed for ${market.country}:`, err.message);
    await supabase.from('property_signals')
      .update({ scanned_at: new Date().toISOString() })
      .eq('country_code', market.code);
  }
}

// ─── MAIN ────────────────────────────────────────────────────────────────────
async function runScan() {
  console.log('🚀 SEA Property Pulse scan started (Apify + Gemini)...');
  console.log(`📅 ${new Date().toISOString()}`);
  console.log('─'.repeat(50));

  let totalSaved = 0;

  for (const market of MARKETS) {
    console.log(`\n${market.flag} Processing ${market.country}...`);
    const marketListings = [];

    for (const query of market.queries) {
      const rawData = await scrapeQuery(market, query);
      if (rawData) {
        const listings = await analyzeWithGemini(market, rawData, query);
        if (listings.length > 0) {
          await saveListings(market, listings);
          marketListings.push(...listings);
          totalSaved += listings.length;
        }
      }
      await new Promise(r => setTimeout(r, 3000));
    }

    await saveMarketSignal(market, marketListings);
  }

  console.log('\n' + '─'.repeat(50));
  console.log(`✅ Scan complete! ${totalSaved} total listings saved`);
  console.log(`📅 ${new Date().toISOString()}`);
}

runScan()
  .then(() => { console.log('Scraper finished successfully.'); process.exit(0); })
  .catch(err => { console.error('Scraper crashed:', err.message); process.exit(1); });
