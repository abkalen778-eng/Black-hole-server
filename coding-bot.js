const http = require('http');

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.CODING_MODEL || 'gemini-3.5-flash-lite';
const ALLOWED_ORIGIN = 'https://abkalen778-eng.github.io';
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 12;
const REQUEST_TIMEOUT_MS = 40_000;
const rate = new Map();

function sendJson(res, status, body, origin='') {
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
      if (body.length > 25000) {
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

function rateLimited(ip) {
  const now = Date.now();
  const current = rate.get(ip) || { start: now, count: 0 };
  if (now - current.start > RATE_WINDOW_MS) {
    current.start = now;
    current.count = 0;
  }
  current.count += 1;
  rate.set(ip, current);
  return current.count > RATE_LIMIT;
}

function extractGeminiText(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts.map(p => typeof p.text === 'string' ? p.text : '').filter(Boolean).join('\n').trim();
}

const SYSTEM = `You are Black Hole Coder, a custom coding assistant built for the user's Black Hole Server. You are not Codex. You help write, explain, debug, refactor, and plan code.

Supported languages and technologies include Python, JavaScript, TypeScript, HTML, CSS, Node.js, SQL, Java, C, C++, C#, Go, Rust, Bash, JSON, YAML, React, Express, and PostgreSQL.

Rules:
- Return working code quickly.
- Prefer concise answers unless the user asks for detail.
- Prefer secure defaults.
- Explain file names and where code goes.
- Never claim code was executed or deployed unless the calling application actually did that.
- For destructive or security-sensitive actions, explain the risk and require explicit approval in the surrounding app before making changes.
- When asked to build an app, give the smallest usable version first.
- If the user provides an error, identify the likely cause and give a concrete fix.`;

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'OPTIONS') {
    if (origin === ALLOWED_ORIGIN) {
      res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
    res.writeHead(204);
    return res.end();
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
    return sendJson(res, 200, {
      name: 'Black Hole Coding Bot',
      status: 'online',
      provider: 'Google Gemini',
      model: MODEL,
      configured: Boolean(GEMINI_API_KEY),
      languages: ['Python','JavaScript','TypeScript','HTML','CSS','Node.js','SQL','Java','C','C++','C#','Go','Rust','Bash']
    }, origin);
  }

  if (req.method === 'POST' && url.pathname === '/generate') {
    if (origin !== ALLOWED_ORIGIN) return sendJson(res, 403, { error: 'Origin not allowed' }, origin);
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').toString().split(',')[0].trim();
    if (rateLimited(ip)) return sendJson(res, 429, { error: 'Too many requests. Try again in a minute.' }, origin);
    if (!GEMINI_API_KEY) return sendJson(res, 503, { error: 'Gemini is not configured. Add GEMINI_API_KEY in Railway.' }, origin);

    try {
      const body = await readJson(req);
      const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
      const language = typeof body.language === 'string' ? body.language.trim() : 'Auto';
      if (!prompt || prompt.length > 8000) return sendJson(res, 400, { error: 'Prompt must be between 1 and 8000 characters.' }, origin);

      const userText = `Preferred language/stack: ${language}\n\nUser request:\n${prompt}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let response;
      try {
        response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`, {
          method: 'POST',
          headers: {
            'x-goog-api-key': GEMINI_API_KEY,
            'Content-Type': 'application/json'
          },
          signal: controller.signal,
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: SYSTEM }] },
            contents: [{ role: 'user', parts: [{ text: userText }] }],
            generationConfig: {
              maxOutputTokens: 1200,
              thinkingConfig: { thinkingLevel: 'minimal' }
            }
          })
        });
      } finally {
        clearTimeout(timeout);
      }

      const data = await response.json();
      if (!response.ok) {
        const msg = data?.error?.message || `Gemini request failed with HTTP ${response.status}`;
        console.error('Gemini coding model error:', response.status, msg);
        return sendJson(res, 502, { error: msg }, origin);
      }
      const reply = extractGeminiText(data);
      if (!reply) return sendJson(res, 502, { error: 'Gemini returned no text.' }, origin);
      return sendJson(res, 200, { reply, model: MODEL, provider: 'Google Gemini' }, origin);
    } catch (err) {
      if (err?.name === 'AbortError') {
        return sendJson(res, 504, { error: 'The coding model took too long. Try a shorter request.' }, origin);
      }
      console.error('Generate error:', err.message);
      return sendJson(res, 500, { error: err.message || 'Could not process request.' }, origin);
    }
  }

  return sendJson(res, 404, { error: 'Not found' }, origin);
});

server.listen(PORT, '0.0.0.0', () => console.log(`Black Hole Coding Bot listening on ${PORT} using ${MODEL}`));
