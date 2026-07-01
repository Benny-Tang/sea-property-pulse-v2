require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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

const THRESHOLD = 5000;

async function checkAndClearOldData() {
  console.log('🔍 Checking total listings count...');
  const { count, error } = await supabase
    .from('property_listings')
    .select('*', { count: 'exact', head: true });

  if (error) {
    console.error('❌ Count check error:', error.message);
    return;
  }

  console.log(`📊 Current total: ${count} listings`);

  if (count >= THRESHOLD) {
    console.log(`⚠️  Threshold of ${THRESHOLD} reached! Clearing listings older than 7 days...`);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);

    const { error: deleteError } = await supabase
      .from('property_listings')
      .delete()
      .lt('scanned_at', cutoff.toISOString());

    if (deleteError) {
      console.error('❌ Delete error:', deleteError.message);
    } else {
      console.log('✅ Old listings cleared successfully!');
    }
  } else {
    console.log(`✅ Below threshold — accumulating data (${THRESHOLD - count} slots remaining)`);
  }
}

async function scrapeQuery(market, query) {
  console.log(`🔍 Scraping: ${query}`);
  try {
    const response = await axios.post(
      'https://api.brightdata.com/request',
      {
        zone: 'serp_api',
        url: `https://www.google.com/search?q=${encodeURIComponent(query)}&num=10`,
        format: 'json'
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.BRIGHT_DATA_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );
    return response.data;
  } catch (error) {
    console.error(`❌ Error:`, error.message);
    return null;
  }
}

async function analyzeWithClaude(market, rawData, query) {
  console.log(`🤖 Analyzing with Claude AI...`);
  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      messages: [
        {
          role: 'user',
          content: `You are a real estate market analyst specializing in Southeast Asia.

Analyze this Google search data for ${market.country} property market.
Query used: "${query}"

Raw search data:
${JSON.stringify(rawData).substring(0, 4000)}

Extract up to 10 individual property signals from the results.
Classify each as:
- "buyer_intent" = people looking to buy, demand signals
- "seller_stress" = price drops, urgent sales, oversupply
- "momentum" = new launches, investment hotspots, growth areas

Respond ONLY with a valid JSON array like this:
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
]`
        }
      ]
    });

    const text = message.content[0].text;
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return [];
  } catch (error) {
    console.error(`❌ Claude error:`, error.message);
    return [];
  }
}

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

  const { error } = await supabase
    .from('property_listings')
    .insert(rows);

  if (error) {
    console.error(`❌ Supabase error:`, error.message);
  } else {
    console.log(`✅ ${listings.length} listings saved for ${market.country}`);
  }
}

async function runScan() {
  console.log('🚀 SEA Property Pulse scan started...');
  console.log(`📅 ${new Date().toISOString()}`);
  console.log('─'.repeat(50));

  await checkAndClearOldData();
  console.log('─'.repeat(50));

  let totalSaved = 0;

  for (const market of MARKETS) {
    console.log(`\n${market.flag} Processing ${market.country}...`);
    for (const query of market.queries) {
      const rawData = await scrapeQuery(market, query);
      if (rawData) {
        const listings = await analyzeWithClaude(market, rawData, query);
        if (listings.length > 0) {
          await saveListings(market, listings);
          totalSaved += listings.length;
        }
      }
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  console.log('\n' + '─'.repeat(50));
  console.log(`✅ Scan complete! ${totalSaved} total listings saved`);
  console.log(`📅 ${new Date().toISOString()}`);
}

runScan();
