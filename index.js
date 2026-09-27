


const https = require('https');
const http = require('http');

const endpoint = (process.env.SOURCE_ENDPOINT || process.env.WEBHOOK_ENDPOINT || '').replace(/\/+$/, '');
const secret = process.env.SECRET_KEY || '';

if (!endpoint || !secret) {
  console.error('[Runner] Missing required environment configuration.');
  process.exit(1);
}

// Dynamically construct daemon target without exposing hardcoded URLs
const targetPath = '/api/monitor/daemon-scan';
let targetUrl = endpoint.includes('/api/')
  ? endpoint
  : `${endpoint}${targetPath}`;

const sep = targetUrl.includes('?') ? '&' : '?';
targetUrl = `${targetUrl}${sep}token=${encodeURIComponent(secret)}&onlyDue=true`;

console.log('[Runner] Dispatching scheduled check...');

async function execute() {
  const urlObj = new URL(targetUrl);
  const isHttps = urlObj.protocol === 'https:';
  const client = isHttps ? https : http;

  const payload = JSON.stringify({
    timestamp: Date.now(),
    trigger: 'scheduled',
  });

  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'User-Agent': 'Cloud-Task-Runner/1.0',
    'Authorization': `Bearer ${secret}`,
    'x-webhook-secret': secret,
  };

  const options = {
    hostname: urlObj.hostname,
    port: urlObj.port || (isHttps ? 443 : 80),
    path: urlObj.pathname + urlObj.search,
    method: 'POST',
    headers,
    timeout: 115000,
  };

  return new Promise((resolve, reject) => {
    const req = client.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        console.log(`[Runner] Response HTTP Status: ${res.statusCode}`);
        resolve();
      });
    });

    req.on('error', (err) => {
      console.error('[Runner] Request error:', err.message);
      reject(err);
    });

    req.on('timeout', () => {
      req.destroy();
      console.warn('[Runner] Request timed out.');
      resolve();
    });

    req.write(payload);
    req.end();
  });
}

execute()
  .then(() => {
    console.log('[Runner] Task finished.');
    process.exit(0);
  })
  .catch(() => process.exit(1));
