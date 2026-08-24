const http = require('http');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const RAILWAY_API_TOKEN = process.env.RAILWAY_API_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const ALLOWED_ORIGIN = 'https://abkalen778-eng.github.io';
const STARTED_AT = Date.now();
const COLLECT_INTERVAL_MS = 5 * 60 * 1000;

const BOT_TARGETS = [
  { name: 'Pump.fun Scanner', projectId: '2dc1806a-8c98-48a4-a3ed-caf205c5d814', project: 'zestful-perception', service: 'Pumpfun-discord-scanner' },
  { name: 'FanDuel Scanner', projectId: '9c1a6087-6afa-4530-a874-269684ec0fdb', project: 'faithful-adaptation', service: 'FanDuel-scanner' },
  { name: 'Pocket Option Bot', projectId: '9c1a6087-6afa-4530-a874-269684ec0fdb', project: 'faithful-adaptation', service: 'Pumpfun-discord-scanner' }
];

const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 4 }) : null;
let dbReady = false;
let lastCollection = null;
let lastCollectionError = null;
let collecting = false;

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

async function initDatabase() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS data_points (
      id BIGSERIAL PRIMARY KEY,
      source TEXT NOT NULL,
      metric TEXT NOT NULL,
      value_numeric DOUBLE PRECISION,
      value_text TEXT,
      unit TEXT,
      collected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_data_points_metric_time
      ON data_points(metric, collected_at DESC);
  `);
  dbReady = true;
}

async function insertPoint(source, metric, valueNumeric, valueText, unit) {
  if (!pool || !dbReady) return;
  await pool.query(
    'INSERT INTO data_points(source, metric, value_numeric, value_text, unit) VALUES($1,$2,$3,$4,$5)',
    [source, metric, valueNumeric ?? null, valueText ?? null, unit ?? null]
  );
}

async function collectCrypto() {
  const url = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,ripple&vs_currencies=usd';
  const response = await fetch(url, { headers: { 'User-Agent': 'Black-Hole-Data-Farm/1.0' } });
  if (!response.ok) throw new Error(`CoinGecko HTTP ${response.status}`);
  const data = await response.json();
  const points = [
    ['btc_usd', data.bitcoin?.usd],
    ['eth_usd', data.ethereum?.usd],
    ['xrp_usd', data.ripple?.usd]
  ];
  for (const [metric, value] of points) {
    if (Number.isFinite(value)) await insertPoint('coingecko', metric, value, null, 'USD');
  }
}

async function collectServerHealth() {
  const mem = process.memoryUsage();
  await insertPoint('black-hole-backend', 'backend_uptime_seconds', Math.floor((Date.now() - STARTED_AT) / 1000), null, 'seconds');
  await insertPoint('black-hole-backend', 'backend_memory_mb', Math.round(mem.rss / 1024 / 1024), null, 'MB');
  await insertPoint('black-hole-backend', 'backend_status', null, 'online', null);
}

async function runCollectors() {
  if (!dbReady || collecting) return;
  collecting = true;
  try {
    const results = await Promise.allSettled([collectCrypto(), collectServerHealth()]);
    const failed = results.filter(r => r.status === 'rejected');
    lastCollection = new Date().toISOString();
    lastCollectionError = failed.length ? failed.map(r => r.reason?.message || 'collector failed').join('; ') : null;
    if (lastCollectionError) console.error('Data farm collector warning:', lastCollectionError);
  } catch (err) {
    lastCollectionError = err.message;
    console.error('Data farm collector error:', err.message);
  } finally {
    collecting = false;
  }
}

async function latestData() {
  if (!pool || !dbReady) return [];
  const { rows } = await pool.query(`
    SELECT DISTINCT ON (metric)
      source, metric, value_numeric, value_text, unit, collected_at
    FROM data_points
    ORDER BY metric, collected_at DESC
  `);
  return rows;
}

async function historyData(metric, limit = 100) {
  if (!pool || !dbReady) return [];
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const { rows } = await pool.query(`
    SELECT source, metric, value_numeric, value_text, unit, collected_at
    FROM data_points
    WHERE metric = $1
    ORDER BY collected_at DESC
    LIMIT $2
  `, [metric, safeLimit]);
  return rows.reverse();
}

async function railwayProject(projectId) {
  const query = `query project($id: String!) {
    project(id: $id) {
      name
      services {
        edges {
          node {
            name
            serviceInstances {
              edges {
                node { latestDeployment { id status createdAt } }
              }
            }
          }
        }
      }
    }
  }`;
  const response = await fetch('https://backboard.railway.com/graphql/v2', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RAILWAY_API_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query, variables: { id: projectId } })
  });
  const data = await response.json();
  if (!response.ok || data.errors) {
    const msg = data?.errors?.[0]?.message || `Railway HTTP ${response.status}`;
    throw new Error(msg);
  }
  return data.data?.project;
}

async function getBotStatuses() {
  const projectIds = [...new Set(BOT_TARGETS.map(b => b.projectId))];
  const pairs = await Promise.all(projectIds.map(async id => [id, await railwayProject(id)]));
  const projects = Object.fromEntries(pairs);
  return BOT_TARGETS.map(target => {
    const project = projects[target.projectId];
    const serviceNode = project?.services?.edges?.map(e => e.node).find(s => s.name === target.service);
    const instances = serviceNode?.serviceInstances?.edges?.map(e => e.node) || [];
    const deployment = instances.map(i => i.latestDeployment).filter(Boolean).sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;
    return {
      name: target.name,
      project: target.project,
      service: target.service,
      status: deployment?.status || 'UNKNOWN',
      deploymentId: deployment?.id || null,
      createdAt: deployment?.createdAt || null
    };
  });
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';
  const url = new URL(req.url, 'http://localhost');

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

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
    return sendJson(res, 200, {
      name: 'Black Hole Backend',
      status: 'online',
      version: '2.3.0',
      gptConfigured: Boolean(OPENAI_API_KEY),
      botMonitorConfigured: Boolean(RAILWAY_API_TOKEN),
      dataFarmConfigured: Boolean(DATABASE_URL),
      dataFarmReady: dbReady,
      timestamp: new Date().toISOString()
    }, origin);
  }

  if (req.method === 'GET' && url.pathname === '/stats') {
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

  if (req.method === 'GET' && url.pathname === '/data-farm/status') {
    let count = 0;
    if (pool && dbReady) {
      try {
        const result = await pool.query('SELECT COUNT(*)::int AS count FROM data_points');
        count = result.rows[0]?.count || 0;
      } catch {}
    }
    return sendJson(res, 200, {
      configured: Boolean(DATABASE_URL),
      ready: dbReady,
      collecting,
      collectionIntervalMinutes: COLLECT_INTERVAL_MS / 60000,
      lastCollection,
      lastCollectionError,
      records: count,
      collectors: ['crypto', 'server-health'],
      planned: ['weather']
    }, origin);
  }

  if (req.method === 'GET' && url.pathname === '/data-farm/latest') {
    if (!dbReady) return sendJson(res, 503, { error: 'Data farm database is not ready yet.' }, origin);
    try {
      return sendJson(res, 200, { data: await latestData(), timestamp: new Date().toISOString() }, origin);
    } catch (err) {
      return sendJson(res, 500, { error: 'Could not read data farm.' }, origin);
    }
  }

  if (req.method === 'GET' && url.pathname === '/data-farm/history') {
    const metric = (url.searchParams.get('metric') || '').trim();
    if (!metric) return sendJson(res, 400, { error: 'metric is required' }, origin);
    if (!dbReady) return sendJson(res, 503, { error: 'Data farm database is not ready yet.' }, origin);
    try {
      return sendJson(res, 200, { metric, data: await historyData(metric, url.searchParams.get('limit')) }, origin);
    } catch {
      return sendJson(res, 500, { error: 'Could not read history.' }, origin);
    }
  }

  if (req.method === 'POST' && url.pathname === '/data-farm/collect') {
    if (origin !== ALLOWED_ORIGIN) return sendJson(res, 403, { error: 'Origin not allowed' }, origin);
    if (!dbReady) return sendJson(res, 503, { error: 'Data farm database is not ready yet.' }, origin);
    await runCollectors();
    return sendJson(res, 200, { ok: true, lastCollection, lastCollectionError }, origin);
  }

  if (req.method === 'GET' && url.pathname === '/bots-status') {
    if (!RAILWAY_API_TOKEN) {
      return sendJson(res, 200, {
        configured: false,
        bots: BOT_TARGETS.map(b => ({ name: b.name, project: b.project, service: b.service, status: 'UNKNOWN' }))
      }, origin);
    }
    try {
      const bots = await getBotStatuses();
      return sendJson(res, 200, { configured: true, bots, timestamp: new Date().toISOString() }, origin);
    } catch (err) {
      console.error('Railway monitor error:', err.message);
      return sendJson(res, 502, { configured: true, error: 'Could not read Railway bot status.' }, origin);
    }
  }

  if (req.method === 'GET' && url.pathname === '/ai-status') {
    return sendJson(res, 200, {
      configured: Boolean(OPENAI_API_KEY),
      model: 'gpt-5.6-luna'
    }, origin);
  }

  if (req.method === 'POST' && url.pathname === '/chat') {
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

server.listen(PORT, '0.0.0.0', async () => {
  console.log(`Black Hole Backend listening on port ${PORT}`);
  try {
    await initDatabase();
    if (dbReady) {
      console.log('Black Hole Data Farm database ready');
      await runCollectors();
      setInterval(runCollectors, COLLECT_INTERVAL_MS);
    }
  } catch (err) {
    lastCollectionError = `Database init failed: ${err.message}`;
    console.error(lastCollectionError);
  }
});
