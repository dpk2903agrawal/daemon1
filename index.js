const https = require('https');
const http = require('http');

const targetUrl = process.env.WEBHOOK_ENDPOINT || process.env.SOURCE_ENDPOINT;
const authToken = process.env.SECRET_KEY;

if (!targetUrl) {
  console.error('Target endpoint is not defined');
  process.exit(1);
}

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
  };

  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
    headers['x-webhook-secret'] = authToken;
  }

  const options = {
    hostname: urlObj.hostname,
    port: urlObj.port || (isHttps ? 443 : 80),
    path: urlObj.pathname + urlObj.search,
    method: 'POST',
    headers,
    timeout: 55000,
  };

  return new Promise((resolve, reject) => {
    const req = client.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        console.log(`Status: ${res.statusCode}`);
        resolve();
      });
    });

    req.on('error', (err) => {
      console.error('Request failed:', err.message);
      reject(err);
    });

    req.on('timeout', () => {
      req.destroy();
      console.warn('Request timed out');
      resolve();
    });

    req.write(payload);
    req.end();
  });
}

execute()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
