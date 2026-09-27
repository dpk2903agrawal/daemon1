const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

const agent = new https.Agent({
  rejectUnauthorized: false,
  secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT,
  ciphers: 'DEFAULT:@SECLEVEL=1',
  minVersion: 'TLSv1',
  timeout: 15000,
});

const SITE_URL = (process.env.SOURCE_ENDPOINT || process.env.SITE_URL || '').replace(/\/+$/, '');
const SECRET = process.env.SECRET_KEY || process.env.WEBHOOK_SECRET || '';

let WEBHOOK = process.env.WEBHOOK_ENDPOINT;
if (!WEBHOOK && SITE_URL) {
  WEBHOOK = `${SITE_URL}/api/webhooks/incoming-notice?token=${SECRET}`;
} else if (WEBHOOK && !WEBHOOK.includes('token=')) {
  WEBHOOK += (WEBHOOK.includes('?') ? '&' : '?') + `token=${SECRET}`;
}

async function getTargets() {
  if (!SITE_URL) return [];
  try {
    const res = await fetch(`${SITE_URL}/api/ai-scraper/portals?token=${SECRET}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Authorization': `Bearer ${SECRET}`,
        'x-webhook-secret': SECRET,
      },
    });
    if (res.ok) {
      const data = await res.json();
      return (data.portals || [])
        .filter((p) => p.isEnabled)
        .map((t) => ({
          name: t.name,
          url: t.url,
          selector: 'a',
          keywords: (t.keywords || 'recruitment,notice,admit,result,vacancy')
            .split(',')
            .map((k) => k.trim().toLowerCase())
            .filter(Boolean),
        }));
    }
  } catch (_) {}
  return [];
}

const UA = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
];

async function fetchPage(urlStr, timeoutMs = 15000) {
  const headers = {
    'User-Agent': UA[Math.floor(Math.random() * UA.length)],
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
  };

  try {
    const res = await fetch(urlStr, { signal: AbortSignal.timeout(timeoutMs), headers });
    if (res.ok) return { ok: true, status: res.status, html: await res.text() };
  } catch (_) {}

  return new Promise((resolve) => {
    try {
      const u = new URL(urlStr);
      const isHttps = u.protocol === 'https:';
      const lib = isHttps ? https : http;
      const req = lib.get(
        {
          hostname: u.hostname,
          port: u.port || (isHttps ? 443 : 80),
          path: u.pathname + u.search,
          headers: { ...headers, Host: u.hostname },
          agent: isHttps ? agent : undefined,
          timeout: timeoutMs,
        },
        (res) => {
          let body = '';
          res.setEncoding('utf-8');
          res.on('data', (c) => {
            if (body.length < 1500000) body += c;
          });
          res.on('end', () => {
            resolve({
              ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 400,
              status: res.statusCode || 500,
              html: body,
            });
          });
        }
      );
      req.on('error', () => resolve({ ok: false, status: 500, html: '' }));
      req.on('timeout', () => {
        req.destroy();
        resolve({ ok: false, status: 408, html: '' });
      });
    } catch (_) {
      resolve({ ok: false, status: 500, html: '' });
    }
  });
}

function parseNotices(html, target) {
  if (!html) return [];
  const $ = cheerio.load(html);
  const results = [];
  const seen = new Set();

  $(target.selector || 'a').each((_, el) => {
    const text = $(el).text().trim().replace(/\s+/g, ' ');
    const href = $(el).attr('href');
    if (!text || !href || text.length < 15 || text.length > 250) return;

    const lower = text.toLowerCase();
    if (
      lower.includes('about us') ||
      lower.includes('contact') ||
      lower.includes('home') ||
      lower.includes('privacy') ||
      lower.includes('terms') ||
      lower.includes('sitemap') ||
      lower.includes('copyright') ||
      lower.includes('skip to')
    ) {
      return;
    }

    const matched = target.keywords.some((k) => lower.includes(k)) || /\.(pdf|docx?|zip)$/i.test(href);
    if (!matched) return;

    let fullUrl = href;
    try {
      fullUrl = new URL(href, target.url).href;
    } catch (_) {}

    if (!seen.has(text)) {
      seen.add(text);
      results.push({ title: text, url: fullUrl, source: target.name });
    }
  });

  return results.slice(0, 5);
}

const CACHE_FILE = path.join(__dirname, 'cloud_seen_urls.json');

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
    const arr = Array.from(set).slice(-2000);
    fs.writeFileSync(CACHE_FILE, JSON.stringify(arr, null, 2), 'utf8');
  } catch (_) {}
}

async function postWebhook(item) {
  if (!WEBHOOK) return false;
  try {
    const res = await fetch(WEBHOOK, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-webhook-secret': SECRET,
      },
      body: JSON.stringify(item),
    });
    const data = await res.json().catch(() => ({}));
    return res.ok && data.success;
  } catch (_) {
    return false;
  }
}

async function start() {
  console.log(`[Watchdog] Initiated at ${new Date().toISOString()}`);
  const cache = loadCache();
  const targets = await getTargets();

  if (!targets.length) {
    console.log('[Watchdog] No targets available. Exiting.');
    return;
  }

  console.log(`[Watchdog] Processing ${targets.length} target(s)...`);

  const CONCURRENCY = 6;
  let cursor = 0;
  let created = 0;
  let skipped = 0;

  async function worker() {
    while (cursor < targets.length) {
      const cur = targets[cursor++];
      if (!cur) break;

      const page = await fetchPage(cur.url);
      if (!page.ok) {
        skipped++;
        continue;
      }

      const notices = parseNotices(page.html, cur);
      for (const n of notices) {
        if (cache.has(n.url)) {
          skipped++;
          continue;
        }
        cache.add(n.url);
        const ok = await postWebhook(n);
        if (ok) created++;
        await new Promise((r) => setTimeout(r, 150));
      }
    }
  }

  const pool = Array.from({ length: Math.min(CONCURRENCY, targets.length) }, () => worker());
  await Promise.all(pool);

  saveCache(cache);

  if (SITE_URL && SECRET) {
    try {
      await fetch(`${SITE_URL}/api/ai-scraper/scan?onlyDue=true&token=${SECRET}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${SECRET}`,
          'x-webhook-secret': SECRET,
        },
      });
    } catch (_) {}
  }

  console.log(`[Watchdog] Completed. Dispatched: ${created} | Cached: ${skipped}`);
}

start().catch((err) => {
  console.error('[Watchdog] Error:', err.message);
  process.exit(1);
});
