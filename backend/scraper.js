require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MARKETS = [
  { country: 'Malaysia', code: 'MY', query: 'property for sale Kuala Lumpur site:propertyguru.com.my', currency: 'MYR', flag: '🇲🇾' },
  { country: 'Singapore', code: 'SG', query: 'property for sale Singapore site:propertyguru.com.sg', currency: 'SGD', flag: '🇸🇬' },
  { country: 'Thailand', code: 'TH', query: 'property for sale Bangkok site:ddproperty.com', currency: 'THB', flag: '🇹🇭' },
  { country: 'Indonesia', code: 'ID', query: 'property for sale Jakarta site:rumah123.com', currency: 'IDR', flag: '🇮🇩' },
  { country: 'Philippines', code: 'PH', query: 'property for sale Manila site:lamudi.com.ph', currency: 'PHP', flag: '🇵🇭' },
  { country: 'Vietnam', code: 'VN', query: 'property for sale Ho Chi Minh site:batdongsan.com.vn', currency: 'VND', flag: '🇻🇳' }
];

async function scrapeMarket(market) {
  console.log(`🔍 Scraping ${market.flag} ${market.country}...`);
  try {
    const response = await axios.post(
      'https://api.brightdata.com/request',
      {
        zone: 'serp_api',
        url: `https://www.google.com/search?q=${encodeURIComponent(market.query)}&num=10`,
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
    console.log(`✅ ${market.country} scraped successfully`);
    return response.data;
  } catch (error) {
    console.error(`❌ Error scraping ${market.country}:`, error.message);
    return null;
  }
}

async function analyzeWithClaude(market, rawData) {
  console.log(`🤖 Analyzing ${market.flag} ${market.country} with Claude AI...`);
  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: `You are a senior real estate market analyst specializing in Southeast Asia.
          
Analyze this raw Google search data for the ${market.country} property market and extract key intelligence.

Market: ${market.country}
Currency: ${market.currency}

Raw search data:
${JSON.stringify(rawData).substring(0, 3000)}

Respond ONLY with a valid JSON object in this exact format:
{
  "avg_price_range": "price range in local currency e.g. MYR 500K - 1.2M",
  "hot_locations": ["top 3 locations mentioned"],
  "sentiment": "hot or warm or cool",
  "trends": ["trend 1", "trend 2", "trend 3"],
  "market_score": 7.5,
  "summary": "2 sentence market summary for investors",
  "opportunities": "1 sentence on best opportunity right now"
}`
        }
      ]
    });

    const text = message.content[0].text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return JSON.parse(text);
  } catch (error) {
    console.error(`❌ Claude analysis error for ${market.country}:`, error.message);
    return null;
  }
}

async function saveToSupabase(market, analysis) {
  console.log(`💾 Saving ${market.country} to Supabase...`);
  const { error } = await supabase
    .from('property_signals')
    .upsert(
      {
        country: market.country,
        country_code: market.code,
        avg_price_range: analysis.avg_price_range,
        hot_locations: analysis.hot_locations,
        sentiment: analysis.sentiment,
        trends: analysis.trends,
        market_score: analysis.market_score,
        summary: analysis.summary,
        raw_results: { opportunities: analysis.opportunities },
        scanned_at: new Date().toISOString()
      },
      { onConflict: 'country_code' }
    );

  if (error) {
    console.error(`❌ Supabase error for ${market.country}:`, error.message);
  } else {
    console.log(`✅ ${market.country} saved to database`);
  }
}

async function runScan() {
  console.log('🚀 SEA Property Pulse scan started...');
  console.log(`📅 ${new Date().toISOString()}`);
  console.log('─'.repeat(50));

  let successCount = 0;

  for (const market of MARKETS) {
    const rawData = await scrapeMarket(market);
    if (rawData) {
      const analysis = await analyzeWithClaude(market, rawData);
      if (analysis) {
        await saveToSupabase(market, analysis);
        successCount++;
      }
    }
    await new Promise(r => setTimeout(r, 3000));
  }

  console.log('─'.repeat(50));
  console.log(`✅ Scan complete! ${successCount}/${MARKETS.length} markets processed`);
  console.log(`📅 ${new Date().toISOString()}`);
}

runScan();
