const http = require('http');

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.CODING_MODEL || 'gpt-5.6-luna';
const ACCESS_TOKEN = process.env.CODING_BOT_TOKEN || '';
const ALLOWED_ORIGIN = 'https://abkalen778-eng.github.io';

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

function extractText(data) {
  for (const item of data.output || []) {
    for (const part of item.content || []) {
      if (part.type === 'output_text' && typeof part.text === 'string') return part.text;
    }
  }
  return '';
}

const SYSTEM = `You are Black Hole Coder, a custom coding assistant built for the user's Black Hole Server. You are NOT Codex and do not claim to be Codex. You help write, explain, debug, refactor, and plan code.

Supported languages and technologies include Python, JavaScript, TypeScript, HTML, CSS, Node.js, SQL, Java, C, C++, C#, Go, Rust, Bash, JSON, YAML, React, Express, and PostgreSQL.

Rules:
- Give complete working code when practical.
- Prefer secure defaults.
- Explain file names and where code goes.
- Never claim code was executed or deployed unless the calling application actually did that.
- For destructive or security-sensitive actions, explain the risk and require explicit user approval in the surrounding app before making changes.
- When asked to build an app, return a concise plan followed by the code needed for the first usable version.
- If the user provides an error, identify the likely cause and give a concrete fix.
- Keep answers mobile-friendly but technically useful.`;

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'OPTIONS') {
    if (origin === ALLOWED_ORIGIN) {
      res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Black-Hole-Token');
    }
    res.writeHead(204);
    return res.end();
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
    return sendJson(res, 200, {
      name: 'Black Hole Coding Bot',
      status: 'online',
      model: MODEL,
      configured: Boolean(OPENAI_API_KEY),
      languages: ['Python','JavaScript','TypeScript','HTML','CSS','Node.js','SQL','Java','C','C++','C#','Go','Rust','Bash']
    }, origin);
  }

  if (req.method === 'POST' && url.pathname === '/generate') {
    if (origin !== ALLOWED_ORIGIN) return sendJson(res, 403, { error: 'Origin not allowed' }, origin);
    if (ACCESS_TOKEN && req.headers['x-black-hole-token'] !== ACCESS_TOKEN) return sendJson(res, 401, { error: 'Invalid access token' }, origin);
    if (!OPENAI_API_KEY) return sendJson(res, 503, { error: 'AI model is not configured.' }, origin);

    try {
      const body = await readJson(req);
      const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
      const language = typeof body.language === 'string' ? body.language.trim() : 'Auto';
      if (!prompt || prompt.length > 8000) return sendJson(res, 400, { error: 'Prompt must be between 1 and 8000 characters.' }, origin);

      const input = `Preferred language/stack: ${language}\n\nUser request:\n${prompt}`;
      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: MODEL,
          instructions: SYSTEM,
          input,
          max_output_tokens: 2200
        })
      });
      const data = await response.json();
      if (!response.ok) {
        console.error('Coding model error:', response.status, data?.error?.message || 'Unknown error');
        return sendJson(res, 502, { error: data?.error?.message || 'Coding model request failed.' }, origin);
      }
      const reply = extractText(data);
      if (!reply) return sendJson(res, 502, { error: 'The coding model returned no text.' }, origin);
      return sendJson(res, 200, { reply, model: data.model || MODEL }, origin);
    } catch (err) {
      return sendJson(res, 500, { error: err.message || 'Could not process request.' }, origin);
    }
  }

  return sendJson(res, 404, { error: 'Not found' }, origin);
});

server.listen(PORT, '0.0.0.0', () => console.log(`Black Hole Coding Bot listening on ${PORT}`));
