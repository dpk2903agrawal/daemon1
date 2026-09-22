const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const SOURCE_API = process.env.SOURCE_ENDPOINT;
const WEBHOOK_API = process.env.WEBHOOK_ENDPOINT;
const KEY = process.env.SECRET_KEY;
const CACHE_FILE = path.join(__dirname, 'cache.json');

const EXCLUDED = [
  'tender', 'e-tender', 'quotation', 'procurement', 'bid', 'bidding',
  'auction', 'gem portal', 'empanelment', 'vendor', 'housekeeping',
  'stationery', 'cctv', 'furniture', 'vehicle', 'catering', 'sanitation',
  'corrigendum to tender', 'annual maintenance', 'amc', 'repair work'
];

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      if (Array.isArray(data)) return new Set(data);
    }
  } catch (_) {}
  return new Set();
}

function saveCache(set) {
  try {
    const list = Array.from(set).slice(-2500);
    fs.writeFileSync(CACHE_FILE, JSON.stringify(list, null, 2), 'utf8');
  } catch (_) {}
}

async function getLiveTargets() {
  if (!SOURCE_API) return [];
  try {
    const res = await fetch(SOURCE_API, {
      headers: {
        'x-webhook-secret': KEY || '',
        'Accept': 'application/json',
      },
      cache: 'no-store',
    });
    if (!res.ok) return [];
    const data = await res.json();
    const list = data.portals || (data.config && data.config.targets) || [];
    return list.filter((p) => p.isEnabled !== false && p.url);
  } catch (_) {
    return [];
  }
}

async function fetchSource(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,hi;q=0.8',
      },
    });
  } finally {
    clearTimeout(t);
  }
}

async function scan(target) {
  try {
    const res = await fetchSource(target.url);
    if (!res.ok) return [];

    const html = await res.text();
    const $ = cheerio.load(html);
    const matches = [];
    const seenLocal = new Set();
    const rawKeywords = target.keywords || 'recruitment, notice, admit, result, vacancy, advertisement';
    const keywords = Array.isArray(rawKeywords)
      ? rawKeywords
      : String(rawKeywords).split(',').map((k) => k.trim().toLowerCase()).filter(Boolean);

    $('a').each((_, el) => {
      const text = $(el).text().trim().replace(/\s+/g, ' ');
      const rawLink = $(el).attr('href');

      if (!text || !rawLink || text.length < 15 || text.length > 250) return;

      const lower = text.toLowerCase();

 
      if (lower.includes('about us') || lower.includes('contact') || lower.includes('home') || lower.includes('privacy') || lower.includes('terms') || lower.includes('sitemap') || lower.includes('copyright')) {
        return;
      }

 
      if (EXCLUDED.some((ex) => lower.includes(ex))) {
        return;
      }

      const hasKeyword = keywords.length === 0 || keywords.some((k) => lower.includes(k));
      const isDoc = /\.(pdf|docx?|zip)$/i.test(rawLink);

      if (hasKeyword || isDoc) {
        let fullLink = rawLink;
        try {
          fullLink = new URL(rawLink, target.url).href;
        } catch (_) {}

        if (!seenLocal.has(text)) {
          seenLocal.add(text);
          matches.push({
            title: text,
            url: fullLink,
            source: target.name || 'Source',
          });
        }
      }
    });

    return matches.slice(0, 5);
  } catch (_) {
    return [];
  }
}

async function send(payload) {
  if (!WEBHOOK_API) return false;
  try {
    const res = await fetch(WEBHOOK_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(KEY ? { 'x-webhook-secret': KEY } : {}),
      },
      body: JSON.stringify(payload),
    });
    return res.ok;
  } catch (_) {
    return false;
  }
}

async function run() {
  const targets = await getLiveTargets();
  if (targets.length === 0) {
    console.log('No active targets found.');
    return;
  }

  const cache = loadCache();
  let dispatched = 0;
  let skipped = 0;

  for (const t of targets) {
    const items = await scan(t);
    for (const item of items) {
      if (cache.has(item.url)) {
        skipped++;
        continue;
      }
      const ok = await send(item);
      cache.add(item.url);
      if (ok) dispatched++;
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  saveCache(cache);
  console.log(`Execution complete. Dispatched: ${dispatched}, Filtered: ${skipped}`);
}

run().catch(() => process.exit(1));
