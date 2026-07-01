require('dotenv').config({ path: __dirname + '/backend/.env' });
const { createClient } = require('@supabase/supabase-js');
const Groq = require('groq-sdk');
const axios = require('axios');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const GROQ_MODEL = 'llama-3.3-70b-versatile';
const APIFY_ACTOR_ID = 'apify~google-search-scraper';
const APIFY_BASE_URL = 'https://api.apify.com/v2';
const MARKETS = [
{ country: 'Malaysia', code: 'MY', query: 'Malaysia property market news when:1d' },
{ country: 'Singapore', code: 'SG', query: 'Singapore property market URA news when:1d' },
{ country: 'Thailand', code: 'TH', query: 'Thailand property market Bank of Thailand news when:1d' },
{ country: 'Indonesia', code: 'ID', query: 'Indonesia property market Bank Indonesia news when:1d' },
{ country: 'Philippines', code: 'PH', query: 'Philippines property market BSP news when:1d' },
{ country: 'Vietnam', code: 'VN', query: 'Vietnam property market housing news when:1d' }
];
async function scrapeNews(market) {
console.log('Scraping news: ' + market.query);
try {
const runRes = await axios.post(
APIFY_BASE_URL + '/acts/' + APIFY_ACTOR_ID + '/runs?token=' + process.env.APIFY_TOKEN,
{
queries: market.query,
maxPagesPerQuery: 1,
resultsPerPage: 10,
mobileResults: false,
languageCode: 'en',
maxConcurrency: 1
},
{ headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
);
const runId = runRes.data.data.id;
console.log('  Actor run started: ' + runId);
let status = 'RUNNING';
let attempts = 0;
while (status === 'RUNNING' || status === 'READY') {
await new Promise(r => setTimeout(r, 5000));
const statusRes = await axios.get(
APIFY_BASE_URL + '/actor-runs/' + runId + '?token=' + process.env.APIFY_TOKEN
);
status = statusRes.data.data.status;
attempts++;
if (attempts > 24) { console.error('  Timeout for run ' + runId); return null; }
}
if (status !== 'SUCCEEDED') {
console.error('  Actor run failed: ' + status);
return null;
}
const datasetId = runRes.data.data.defaultDatasetId;
const resultsRes = await axios.get(
APIFY_BASE_URL + '/datasets/' + datasetId + '/items?token=' + process.env.APIFY_TOKEN + '&format=json'
);
const items = resultsRes.data;
if (!items || items.length === 0) { console.warn('  No results for: ' + market.query); return null; }
console.log('  Got ' + items.length + ' result pages');
return items;
} catch (error) {
console.error('Apify error:', error.response && error.response.data && error.response.data.error && error.response.data.error.message || error.message);
return null;
}
}
async function analyzeSentiment(market, rawData) {
console.log('Analyzing sentiment with Groq AI...');
try {
const newsResults = rawData.flatMap(page =>
(page.organicResults || []).map(r => ({
title: r.title,
url: r.url,
description: r.description
}))
).slice(0, 15);
if (newsResults.length === 0) return null;

const prompt = 'You are a real estate market analyst covering Southeast Asia.\n' +
  'Based on these recent news headlines and snippets about the ' + market.country + ' property market:\n' +
  JSON.stringify(newsResults) + '\n' +
  'Identify two things:\n' +
  '1. What government, central bank, or official statistics/policy news is signaling about the market (interest rates, price indices, regulations, housing policy)\n' +
  '2. What private-sector or general market sentiment is signaling (developer activity, portal/broker commentary, buyer/investor mood, news coverage tone)\n' +
  'Then give an overall sentiment label and score.\n' +
  'Respond ONLY with valid JSON (no markdown, no code fences):\n' +
  '{\n' +
  '  "sentiment_label": "Bullish|Cautiously Optimistic|Stable|Cooling|Bearish",\n' +
  '  "sentiment_score": <number 1-10>,\n' +
  '  "summary": "<2-3 sentence overall market overview blending both signals>",\n' +
  '  "government_signal": "<1-2 sentences on official/policy signal, or note if none found>",\n' +
  '  "private_signal": "<1-2 sentences on private-sector/market sentiment signal>",\n' +
  '  "sources": [{"title": "<source title>", "url": "<source url>"}]\n' +
  '}';

const result = await groq.chat.completions.create({
  model: GROQ_MODEL,
  messages: [{ role: 'user', content: prompt }],
  temperature: 0.3
});
const text = result.choices[0].message.content;
const jsonMatch = text.match(/\{[\s\S]*\}/);
if (!jsonMatch) throw new Error('No JSON in Groq response');
return JSON.parse(jsonMatch[0]);
} catch (error) {
console.error('Groq error:', error.message);
return null;
}
}
async function saveSentiment(market, sentiment) {
const payload = {
country_code: market.code,
country: market.country,
sentiment_label: sentiment.sentiment_label,
sentiment_score: sentiment.sentiment_score,
summary: sentiment.summary,
government_signal: sentiment.government_signal,
private_signal: sentiment.private_signal,
sources: sentiment.sources,
scanned_at: new Date().toISOString()
};
const { error } = await supabase.from('market_sentiment').upsert(payload, { onConflict: 'country_code' });
if (error) {
console.error('Supabase error:', error.message);
} else {
console.log('Sentiment saved for ' + market.country + ' - ' + sentiment.sentiment_label + ' (' + sentiment.sentiment_score + '/10)');
}
}
async function runSentimentScan() {
console.log('SEA Property Pulse sentiment scan started (Apify + Groq)...');
console.log(new Date().toISOString());
console.log('-'.repeat(50));
for (const market of MARKETS) {
console.log('\nProcessing ' + market.country + '...');
const rawData = await scrapeNews(market);
if (rawData) {
const sentiment = await analyzeSentiment(market, rawData);
if (sentiment) {
await saveSentiment(market, sentiment);
} else {
console.warn('No sentiment generated for ' + market.country);
}
}
await new Promise(r => setTimeout(r, 3000));
}
console.log('\n' + '-'.repeat(50));
console.log('Sentiment scan complete!');
console.log(new Date().toISOString());
}
runSentimentScan()
.then(() => { console.log('Sentiment scan finished successfully.'); process.exit(0); })
.catch(err => { console.error('Sentiment scan crashed:', err.message); process.exit(1); });
