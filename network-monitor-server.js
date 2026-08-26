const http = require('http');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const NETWORK_MONITOR_TOKEN = process.env.NETWORK_MONITOR_TOKEN;
const ALLOWED_ORIGIN = 'https://abkalen778-eng.github.io';

const pool = DATABASE_URL
  ? new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 3 })
  : null;

let dbReady = false;
let latestMemoryReport = null;

function sendJson(res, status, body, origin = '') {
  if (origin === ALLOWED_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.writeHead(status);
  res.end(JSON.stringify(body));
}

function authorized(req) {
  if (!NETWORK_MONITOR_TOKEN) return false;
  const header = req.headers.authorization || '';
  return header === `Bearer ${NETWORK_MONITOR_TOKEN}`;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 50_000) {
        reject(new Error('Request too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

async function initDatabase() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS network_reports (
      id BIGSERIAL PRIMARY KEY,
      sensor TEXT NOT NULL,
      internet_status TEXT NOT NULL,
      public_ip TEXT,
      device_count INTEGER NOT NULL,
      devices JSONB NOT NULL DEFAULT '[]'::jsonb,
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_network_reports_time
      ON network_reports(recorded_at DESC);
  `);
  dbReady = true;
}

function normalizeReport(body) {
  const sensor = typeof body.sensor === 'string' && body.sensor.trim()
    ? body.sensor.trim().slice(0, 80)
    : 'android-termux';

  const internetStatus = String(body.internetStatus || '').toUpperCase();
  if (!['ONLINE', 'OFFLINE'].includes(internetStatus)) {
    throw new Error('internetStatus must be ONLINE or OFFLINE');
  }

  const publicIp = typeof body.publicIp === 'string'
    ? body.publicIp.trim().slice(0, 64)
    : '';

  const rawDevices = Array.isArray(body.devices) ? body.devices.slice(0, 256) : [];
  const devices = rawDevices.map(device => {
    if (typeof device === 'string') {
      return { ip: device.slice(0, 64), name: 'Unknown Device' };
    }
    return {
      ip: typeof device?.ip === 'string' ? device.ip.slice(0, 64) : '',
      name: typeof device?.name === 'string' ? device.name.slice(0, 100) : 'Unknown Device'
    };
  }).filter(device => device.ip);

  return {
    sensor,
    internetStatus,
    publicIp,
    deviceCount: devices.length,
    devices,
    recordedAt: new Date().toISOString()
  };
}

async function saveReport(report) {
  latestMemoryReport = report;
  if (!pool || !dbReady) return;

  await pool.query(
    `INSERT INTO network_reports(sensor, internet_status, public_ip, device_count, devices)
     VALUES($1, $2, $3, $4, $5::jsonb)`,
    [report.sensor, report.internetStatus, report.publicIp || null, report.deviceCount, JSON.stringify(report.devices)]
  );

  // Keep the table lightweight for a phone sensor that reports frequently.
  await pool.query(`
    DELETE FROM network_reports
    WHERE id NOT IN (
      SELECT id FROM network_reports ORDER BY recorded_at DESC LIMIT 5000
    )
  `);
}

async function getLatestReport() {
  if (pool && dbReady) {
    const { rows } = await pool.query(`
      SELECT sensor, internet_status, public_ip, device_count, devices, recorded_at
      FROM network_reports
      ORDER BY recorded_at DESC
      LIMIT 1
    `);
    if (rows[0]) {
      return {
        sensor: rows[0].sensor,
        internetStatus: rows[0].internet_status,
        publicIp: rows[0].public_ip,
        deviceCount: rows[0].device_count,
        devices: rows[0].devices,
        recordedAt: rows[0].recorded_at
      };
    }
  }
  return latestMemoryReport;
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
      name: 'Black Hole Network Monitor',
      status: 'online',
      databaseReady: dbReady,
      tokenConfigured: Boolean(NETWORK_MONITOR_TOKEN),
      timestamp: new Date().toISOString()
    }, origin);
  }

  if (req.method === 'POST' && url.pathname === '/report') {
    if (!authorized(req)) {
      return sendJson(res, 401, { error: 'Unauthorized' }, origin);
    }

    try {
      const report = normalizeReport(await readJson(req));
      await saveReport(report);
      return sendJson(res, 200, {
        ok: true,
        deviceCount: report.deviceCount,
        recordedAt: report.recordedAt
      }, origin);
    } catch (err) {
      return sendJson(res, 400, { error: err.message || 'Invalid report' }, origin);
    }
  }

  if (req.method === 'GET' && url.pathname === '/latest') {
    if (!authorized(req)) {
      return sendJson(res, 401, { error: 'Unauthorized' }, origin);
    }
    const report = await getLatestReport();
    if (!report) return sendJson(res, 404, { error: 'No network report received yet.' }, origin);
    return sendJson(res, 200, report, origin);
  }

  if (req.method === 'GET' && url.pathname === '/summary') {
    const report = await getLatestReport();
    if (!report) {
      return sendJson(res, 200, {
        connected: false,
        internetStatus: 'UNKNOWN',
        deviceCount: 0,
        lastSeen: null
      }, origin);
    }

    const ageMs = Date.now() - new Date(report.recordedAt).getTime();
    return sendJson(res, 200, {
      connected: ageMs < 120_000,
      internetStatus: report.internetStatus,
      deviceCount: report.deviceCount,
      sensor: report.sensor,
      lastSeen: report.recordedAt
    }, origin);
  }

  return sendJson(res, 404, { error: 'Not found' }, origin);
});

server.listen(PORT, '0.0.0.0', async () => {
  console.log(`Black Hole Network Monitor listening on port ${PORT}`);
  try {
    await initDatabase();
    if (dbReady) console.log('Network monitor database ready');
  } catch (err) {
    console.error('Network monitor database init failed:', err.message);
  }
});
