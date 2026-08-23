const http = require('http');

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ALLOWED_ORIGIN = 'https://abkalen778-eng.github.io';
const STARTED_AT = Date.now();

const rate = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const windowMs = 60_000;
  const limit = 20;
  const current = rate.get(ip) || { start: now, count: 0 };
  if (now - current.start > windowMs) {
    current.start = now;
    current.count = 0;
  }
  current.count += 1;
  rate.set(ip, current);
  return current.count > limit;
}

function sendJson(res, status, body, origin) {
  if (origin === ALLOWED_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.writeHead(status);
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 20_000) {
        reject(new Error('Request too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function extractText(data) {
  for (const item of data.output || []) {
    for (const part of item.content || []) {
      if (part.type === 'output_text' && typeof part.text === 'string') return part.text;
    }
  }
  return '';
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';

  if (req.method === 'OPTIONS') {
    if (origin === ALLOWED_ORIGIN) {
      res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '86400');
    }
    res.writeHead(204);
    return res.end();
  }

  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    return sendJson(res, 200, {
      name: 'Black Hole Backend',
      status: 'online',
      version: '2.0.0',
      gptConfigured: Boolean(OPENAI_API_KEY),
      timestamp: new Date().toISOString()
    }, origin);
  }

  if (req.method === 'GET' && req.url === '/stats') {
    const mem = process.memoryUsage();
    return sendJson(res, 200, {
      status: 'online',
      uptimeSeconds: Math.floor((Date.now() - STARTED_AT) / 1000),
      memoryMB: {
        rss: Math.round(mem.rss / 1024 / 1024),
        heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotal: Math.round(mem.heapTotal / 1024 / 1024)
      },
      node: process.version,
      platform: process.platform,
      timestamp: new Date().toISOString()
    }, origin);
  }

  if (req.method === 'GET' && req.url === '/ai-status') {
    return sendJson(res, 200, {
      configured: Boolean(OPENAI_API_KEY),
      model: 'gpt-5.6-luna'
    }, origin);
  }

  if (req.method === 'POST' && req.url === '/chat') {
    if (origin !== ALLOWED_ORIGIN) {
      return sendJson(res, 403, { error: 'Origin not allowed' }, origin);
    }

    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').toString().split(',')[0].trim();
    if (rateLimited(ip)) {
      return sendJson(res, 429, { error: 'Too many requests. Try again in a minute.' }, origin);
    }

    if (!OPENAI_API_KEY) {
      return sendJson(res, 503, { error: 'GPT is not configured yet. Add OPENAI_API_KEY in Railway.' }, origin);
    }

    try {
      const body = await readJson(req);
      const message = typeof body.message === 'string' ? body.message.trim() : '';
      if (!message || message.length > 4000) {
        return sendJson(res, 400, { error: 'Message must be between 1 and 4000 characters.' }, origin);
      }

      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'gpt-5.6-luna',
          instructions: 'You are Black Hole GPT, a concise, helpful personal AI assistant inside the Black Hole Server mobile dashboard. Help with coding, technology, learning, planning, and everyday questions. Keep answers clear and mobile-friendly.',
          input: message,
          max_output_tokens: 700
        })
      });

      const data = await response.json();
      if (!response.ok) {
        console.error('OpenAI error:', response.status, data?.error?.message || 'Unknown error');
        return sendJson(res, 502, { error: 'The GPT service returned an error.' }, origin);
      }

      const reply = extractText(data);
      if (!reply) return sendJson(res, 502, { error: 'GPT returned an empty response.' }, origin);
      return sendJson(res, 200, { reply, model: data.model || 'gpt-5.6-luna' }, origin);
    } catch (err) {
      console.error('Chat error:', err.message);
      return sendJson(res, 500, { error: 'Could not process the chat request.' }, origin);
    }
  }

  return sendJson(res, 404, { error: 'Not found' }, origin);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Black Hole Backend listening on port ${PORT}`);
});
