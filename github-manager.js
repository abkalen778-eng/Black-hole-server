const http = require('http');

const PORT = process.env.PORT || 3000;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_OWNER = process.env.GITHUB_OWNER || 'abkalen778-eng';
const ALLOWED_ORIGIN = 'https://abkalen778-eng.github.io';

function cors(res, origin='') {
  if (origin === ALLOWED_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
}

function send(res, status, body, origin='') {
  cors(res, origin);
  res.writeHead(status);
  res.end(JSON.stringify(body));
}

async function gh(path) {
  const headers = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'Black-Hole-GitHub-Manager'
  };
  if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  const r = await fetch(`https://api.github.com${path}`, { headers });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(data?.message || `GitHub request failed (${r.status})`);
    err.status = r.status;
    throw err;
  }
  return data;
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'OPTIONS') {
    if (origin === ALLOWED_ORIGIN) {
      res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
    res.writeHead(204);
    return res.end();
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
    return send(res, 200, {
      name: 'Black Hole GitHub Manager',
      status: 'online',
      owner: GITHUB_OWNER,
      authenticated: Boolean(GITHUB_TOKEN),
      mode: GITHUB_TOKEN ? 'authenticated-read' : 'public-read'
    }, origin);
  }

  if (req.method === 'GET' && url.pathname === '/repos') {
    try {
      const repos = await gh(`/users/${encodeURIComponent(GITHUB_OWNER)}/repos?sort=updated&per_page=50`);
      return send(res, 200, { repos: repos.map(r => ({
        name: r.name,
        full_name: r.full_name,
        private: r.private,
        language: r.language,
        default_branch: r.default_branch,
        updated_at: r.updated_at,
        html_url: r.html_url,
        description: r.description
      })) }, origin);
    } catch (e) {
      return send(res, e.status || 500, { error: e.message }, origin);
    }
  }

  const match = url.pathname.match(/^\/repo\/([^/]+)\/([^/]+)\/(branches|commits)$/);
  if (req.method === 'GET' && match) {
    const [, owner, repo, kind] = match;
    try {
      if (kind === 'branches') {
        const data = await gh(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=50`);
        return send(res, 200, { branches: data.map(b => ({ name: b.name, sha: b.commit?.sha })) }, origin);
      }
      const data = await gh(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits?per_page=20`);
      return send(res, 200, { commits: data.map(c => ({
        sha: c.sha,
        message: c.commit?.message,
        author: c.commit?.author?.name,
        date: c.commit?.author?.date,
        html_url: c.html_url
      })) }, origin);
    } catch (e) {
      return send(res, e.status || 500, { error: e.message }, origin);
    }
  }

  return send(res, 404, { error: 'Not found' }, origin);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Black Hole GitHub Manager listening on ${PORT}`);
});
