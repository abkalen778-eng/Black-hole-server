const http = require('http');
const path = require('path');

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const CODEX_ACCESS_TOKEN = process.env.CODEX_ACCESS_TOKEN;
const ALLOWED_ORIGIN = 'https://abkalen778-eng.github.io';
const STARTED_AT = Date.now();

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
      if (body.length > 30000) {
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

function authorized(req) {
  if (!CODEX_ACCESS_TOKEN) return false;
  const auth = req.headers.authorization || '';
  return auth === `Bearer ${CODEX_ACCESS_TOKEN}`;
}

let codexClientPromise;
async function getCodex() {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is missing');
  if (!codexClientPromise) {
    codexClientPromise = import('@openai/codex-sdk').then(({ Codex }) => {
      return new Codex({
        apiKey: OPENAI_API_KEY,
        env: {
          PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
          HOME: '/tmp/codex-home'
        },
        config: {
          features: { plugins: false },
          web_search: 'disabled'
        }
      });
    });
  }
  return codexClientPromise;
}

async function runCodex(prompt) {
  const codex = await getCodex();
  const thread = codex.startThread({
    workingDirectory: process.cwd(),
    skipGitRepoCheck: true,
    sandboxMode: 'read-only',
    approvalPolicy: 'never',
    networkAccessEnabled: false,
    webSearchMode: 'disabled',
    modelReasoningEffort: 'medium'
  });
  const instruction = [
    'You are Black Hole Codex, a read-only coding agent for the Black-hole-server repository.',
    'Inspect project files when useful. Do not modify files, run network requests, inspect environment variables, reveal credentials, or attempt privilege escalation.',
    'Return practical coding guidance and, when code changes are requested, provide a concise proposed patch or exact file edits for the user to review.',
    '',
    `User request: ${prompt}`
  ].join('\n');
  const turn = await thread.run(instruction);
  return { reply: turn.finalResponse || 'Codex completed without a text response.', threadId: thread.id || null, usage: turn.usage || null };
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'OPTIONS') {
    if (origin === ALLOWED_ORIGIN) {
      res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Max-Age', '86400');
    }
    res.writeHead(204);
    return res.end();
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
    return sendJson(res, 200, {
      name: 'Black Hole Codex',
      status: 'online',
      mode: 'read-only',
      configured: Boolean(OPENAI_API_KEY && CODEX_ACCESS_TOKEN),
      uptimeSeconds: Math.floor((Date.now() - STARTED_AT) / 1000),
      timestamp: new Date().toISOString()
    }, origin);
  }

  if (req.method === 'POST' && url.pathname === '/codex') {
    if (origin !== ALLOWED_ORIGIN) return sendJson(res, 403, { error: 'Origin not allowed' }, origin);
    if (!authorized(req)) return sendJson(res, 401, { error: 'Invalid Black Hole Codex access key.' }, origin);
    try {
      const body = await readJson(req);
      const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
      if (!prompt || prompt.length > 8000) return sendJson(res, 400, { error: 'Prompt must be between 1 and 8000 characters.' }, origin);
      const result = await runCodex(prompt);
      return sendJson(res, 200, result, origin);
    } catch (err) {
      console.error('Codex error:', err.message);
      return sendJson(res, 502, { error: 'Codex could not complete the request.', detail: err.message }, origin);
    }
  }

  return sendJson(res, 404, { error: 'Not found' }, origin);
});

server.listen(PORT, '0.0.0.0', () => console.log(`Black Hole Codex listening on ${PORT}`));
