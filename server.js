/* GitHub Manager — سرور محلی مدیریت مخازن گیت‌هاب
 * Node.js >= 22.5
 * اجرا: node server.js
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (e) {
  console.error('\n[خطا] ماژول node:sqlite در این نسخه Node در دسترس نیست.');
  console.error('نسخه Node را بررسی کنید: node --version');
  console.error('در Node 22.x با پرچم --experimental-sqlite اجرا کنید:');
  console.error('node --experimental-sqlite server.js\n');
  process.exit(1);
}

const PORT = String(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = __dirname;
const DB_PATH = path.join(ROOT, 'data', 'github-manager.db');
const PUBLIC_DIR = path.join(ROOT, 'public');
const GH = process.env.GH_API || 'https://api.github.com';

/* ---------------------------- راه‌اندازی دیتابیس ---------------------------- */

fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
const db = new DatabaseSync(DB_PATH);

db.exec(`
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('create','edit','delete','move','copy')),
  kind TEXT NOT NULL CHECK (kind IN ('file','folder')),
  path TEXT NOT NULL,
  dst TEXT,
  content TEXT,
  is_binary INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_changes_repo ON changes(repo);
`);

function getSetting(key) {
  const row = db.prepare(
    'SELECT value FROM settings WHERE key = ?'
  ).get(key);

  return row ? row.value : null;
}

function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings(key,value)
    VALUES(?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `).run(key, value === null ? null : String(value));
}

/* ------------------------------ ابزارهای عمومی ------------------------------ */

function send(res, status, data) {
  const body = JSON.stringify(data);

  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });

  res.end(body);
}

const fail = (res, status, message, extra) =>
  send(res, status, Object.assign({ error: message }, extra || {}));

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on('data', (c) => {
      size += c.length;

      if (size > 60 * 1024 * 1024) {
        reject(new Error('حجم درخواست بیش از حد مجاز است'));
        req.destroy();
        return;
      }

      chunks.push(c);
    });

    req.on('end', () => {
      if (!chunks.length) return resolve({});

      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('بدنه درخواست JSON معتبر نیست'));
      }
    });

    req.on('error', reject);
  });
}

/** بررسی امنیت مسیر فایل/پوشه */
function safePath(p) {
  if (typeof p !== 'string') return null;

  let s = p.trim().replace(/\\/g, '/').replace(/^\/+/, '');

  while (s.startsWith('./')) s = s.slice(2);

  s = s.replace(/\/{2,}/g, '/');
  s = s.replace(/\/+$/, '');

  if (!s) return null;
  if (/[\0-\x08\x0e-\x1f]/.test(s)) return null;

  const parts = s.split('/');

  if (parts.some((seg) =>
    seg === '' ||
    seg === '.' ||
    seg === '..' ||
    seg === '.git' ||
    seg.length > 255
  )) return null;

  return parts.join('/');
}

/** تماس با REST API گیت‌هاب */
async function gh(apiPath, { method = 'GET', body, token, raw = false } = {}) {
  const tok = token || getSetting('token');

  if (!tok) {
    const e = new Error('AUTH');
    e.code = 401;
    throw e;
  }

  const headers = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'github-manager-local',
  };

  headers['Authorization'] = `Bearer ${tok}`;

  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }

  let res;

  try {
    res = await fetch(
      apiPath.startsWith('http') ? apiPath : GH + apiPath,
      { method, headers, body }
    );
  } catch (e) {
    const err = new Error(
      'ارتباط با گیت‌هاب برقرار نشد؛ اتصال اینترنت را بررسی کنید.'
    );

    err.code = 502;
    throw err;
  }

  if (res.status === 204) {
    return { ok: true, status: 204, data: null, headers: res.headers };
  }

  if (res.status === 304) {
    return { ok: true, status: 304, data: null, headers: res.headers };
  }

  const data = await res.json().catch(() => null);

  if (!res.ok) {
    const retryAfter = res.headers.get('retry-after');
    const remains = res.headers.get('x-ratelimit-remaining');

    let msg = (data && data.message) ||
      `خطای گیت‌هاب (کد ${res.status})`;

    if (remains === '0') {
      msg = 'سهمیه درخواست‌های گیت‌هاب به پایان رسید؛ چند دقیقه بعد دوباره تلاش کنید.';
    }

    if (retryAfter) {
      msg += ` — ${retryAfter} ثانیه صبر کنید.`;
    }

    const err = new Error(msg);
    err.code = res.status === 401 ? 401 :
      (res.status >= 500 ? 502 : res.status);

    err.ghStatus = res.status;
    throw err;
  }

  return {
    ok: true,
    status: res.status,
    data,
    headers: res.headers,
    raw
  };
}

/* ============================== احراز هویت ============================== */

async function handleAuth(req, res, url) {
  const token = getSetting('token');

  if (req.method === 'GET' && url.pathname === '/api/auth/session') {
    if (!token) return send(res, 200, { user: null });

    try {
      const { data, headers } = await gh('/user');

      return send(res, 200, {
        user: {
          login: data.login,
          name: data.name,
          avatar_url: data.avatar_url,
          html_url: data.html_url,
          public_repos: data.public_repos,
          email: data.email || null,
          id: data.id,
        },
        scopes: (
          headers.get('x-oauth-scopes') ||
          getSetting('scopes') ||
          ''
        ),
      });
    } catch (e) {
      if (e.code === 401) {
        return send(res, 200, { user: null, stale: true });
      }

      throw e;
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/token') {
    const body = await readBody(req);
    const t = (body.token || '').trim();

    if (!t) return fail(res, 400, 'توکن را وارد کنید.');

    const { data, headers } = await gh('/user', { token: t });
    const scopes = headers.get('x-oauth-scopes') || '';

    setSetting('token', t);
    setSetting('scopes', scopes);
    setSetting('login', data.login);

    return send(res, 200, {
      user: {
        login: data.login,
        name: data.name,
        avatar_url: data.avatar_url,
        html_url: data.html_url,
        id: data.id,
        email: data.email || null
      },
      scopes,
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/device/start') {
    const body = await readBody(req);
    const clientId = (body.client_id || '').trim();

    if (!clientId) {
      return fail(res, 400, 'Client ID اپلیکیشن OAuth را وارد کنید.');
    }

    const r = await fetch('https://github.com/login/device/code', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        client_id: clientId,
        scope: 'repo read:user delete_repo'
      }),
    });

    const data = await r.json().catch(() => null);

    if (!data || !data.device_code) {
      return fail(
        res,
        400,
        (data && data.error_description) ||
          'شروع Device Flow ناموفق بود.'
      );
    }

    return send(res, 200, {
      device_code: data.device_code,
      user_code: data.user_code,
      verification_uri: data.verification_uri,
      expires_in: data.expires_in,
      interval: data.interval || 5,
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/device/poll') {
    const body = await readBody(req);

    if (!body.client_id || !body.device_code) {
      return fail(res, 400, 'پارامترهای Device Flow ناقص است.');
    }

    const r = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        client_id: body.client_id,
        device_code: body.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });

    const data = await r.json().catch(() => null);

    if (data && data.access_token) {
      const { data: user, headers } = await gh('/user', {
        token: data.access_token
      });

      setSetting('token', data.access_token);
      setSetting('scopes', headers.get('x-oauth-scopes') || '');
      setSetting('login', user.login);

      return send(res, 200, {
        ok: true,
        user: {
          login: user.login,
          name: user.name,
          avatar_url: user.avatar_url,
          html_url: user.html_url,
          id: user.id,
          email: user.email || null
        },
      });
    }

    const err = (data && data.error) || 'unknown';

    if (err === 'authorization_pending') {
      return send(res, 200, { ok: false, pending: true });
    }

    if (err === 'slow_down') {
      return send(res, 200, { ok: false, pending: true, slow: true });
    }

    return fail(
      res,
      400,
      (data && data.error_description) ||
        'احراز هویت Device Flow ناموفق بود.'
    );
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
    setSetting('token', null);
    setSetting('scopes', null);
    setSetting('login', null);

    db.exec('DELETE FROM changes');

    return send(res, 200, { ok: true });
  }

  return fail(res, 404, 'مسیر احراز هویت یافت نشد.');
}

/* ============================== تنظیمات ============================== */

function handleSettings(req, res, url) {
  if (url.pathname === '/api/settings' && req.method === 'GET') {
    return send(res, 200, {
      author_name: getSetting('author_name') || 'GitHub Manager',
      author_email: getSetting('author_email') ||
        'manager@github-manager.local',
      coauthor: getSetting('coauthor') !== '0',
    });
  }

  if (url.pathname === '/api/settings' && req.method === 'POST') {
    return readBody(req).then((b) => {
      if (typeof b.author_name === 'string' && b.author_name.trim()) {
        setSetting('author_name', b.author_name.trim().slice(0, 100));
      }

      if (typeof b.author_email === 'string' && b.author_email.trim()) {
        setSetting('author_email', b.author_email.trim().slice(0, 100));
      }

      if (typeof b.coauthor === 'boolean') {
        setSetting('coauthor', b.coauthor ? '1' : '0');
      }

      send(res, 200, { ok: true });
    }).catch((e) => fail(res, 400, e.message));
  }

  return Promise.resolve(fail(res, 404, 'مسیر تنظیمات یافت نشد.'));
}

/* ============================== مخازن ============================== */

function requireAuth() {
  if (!getSetting('token')) {
    const e = new Error('AUTH');
    e.code = 401;
    throw e;
  }
}

async function handleRepos(req, res, url, owner, repo) {
  requireAuth();

  /* ---- فهرست مخازن ---- */
  if (req.method === 'GET' && url.pathname === '/api/repos') {
    const all = [];

    for (let page = 1; page <= 10; page++) {
      const { data } = await gh(
        `/user/repos?per_page=100&page=${page}&sort=updated&visibility=all&affiliation=owner,collaborator,organization_member`
      );

      all.push(...data);

      if (data.length < 100) break;
    }

    const seen = new Set();

    const list = all
      .filter((r) => (
        seen.has(r.full_name)
          ? false
          : (seen.add(r.full_name), true)
      ))
      .map((r) => ({
        id: r.id,
        full_name: r.full_name,
        name: r.name,
        owner: r.owner.login,
        description: r.description,
        private: r.private,
        fork: r.fork,
        language: r.language,
        stars: r.stargazers_count,
        forks: r.forks_count,
        default_branch: r.default_branch,
        updated_at: r.updated_at,
        html_url: r.html_url,
        permissions: r.permissions,
      }));

    return send(res, 200, { repos: list });
  }

  /* ---- ساخت مخزن جدید ---- */
  if (req.method === 'POST' && url.pathname === '/api/repos') {
    const b = await readBody(req);
    const name = (b.name || '').trim();

    if (!/^[\w.\-]{1,100}$/.test(name)) {
      return fail(
        res,
        400,
        'نام مخزن معتبر نیست (فقط حرف، رقم، نقطه، خط تیره).'
      );
    }

    const { data } = await gh('/user/repos', {
      method: 'POST',
      body: {
        name,
        description: (b.description || '').slice(0, 350) || null,
        private: !!b.private,
        auto_init: b.auto_init !== false,
        has_issues: true,
        has_wiki: false,
      },
    });

    return send(res, 201, {
      repo: {
        full_name: data.full_name,
        default_branch: data.default_branch,
        html_url: data.html_url
      }
    });
  }

  if (!owner || !repo) {
    return fail(res, 404, 'مسیر یافت نشد.');
  }

  const full = `${owner}/${repo}`;
  const branchFromQuery =
    url.searchParams.get('ref') ||
    url.searchParams.get('branch');

  /* ---- اطلاعات مخزن ---- */
  if (
    req.method === 'GET' &&
    url.pathname === `/api/repos/${owner}/${repo}`
  ) {
    const { data } = await gh(`/repos/${full}`);

    return send(res, 200, {
      full_name: data.full_name,
      description: data.description,
      private: data.private,
      default_branch: data.default_branch,
      html_url: data.html_url,
      stars: data.stargazers_count,
      forks: data.forks_count,
      language: data.language,
      permissions: data.permissions,
      size: data.size,
      license: data.license && data.license.name,
    });
  }

  /* ---- ویرایش مخزن ---- */
  if (
    req.method === 'PATCH' &&
    url.pathname === `/api/repos/${owner}/${repo}`
  ) {
    const b = await readBody(req);
    const payload = {};

    if (
      typeof b.name === 'string' &&
      b.name.trim() &&
      b.name !== repo
    ) {
      payload.name = b.name.trim();
    }

    if (typeof b.description === 'string') {
      payload.description = b.description.slice(0, 350);
    }

    if (typeof b.private === 'boolean') {
      payload.private = b.private;
    }

    if (typeof b.default_branch === 'string' && b.default_branch.trim()) {
      payload.default_branch = b.default_branch.trim();
    }

    if (!Object.keys(payload).length) {
      return fail(res, 400, 'چیزی برای تغییر ارسال نشد.');
    }

    const { data } = await gh(`/repos/${full}`, {
      method: 'PATCH',
      body: payload
    });

    return send(res, 200, {
      full_name: data.full_name,
      default_branch: data.default_branch
    });
  }

  /* ---- حذف مخزن ---- */
  if (
    req.method === 'DELETE' &&
    url.pathname === `/api/repos/${owner}/${repo}`
  ) {
    try {
      await gh(`/repos/${full}`, { method: 'DELETE' });
    } catch (e) {
      if (e.ghStatus === 403 || e.ghStatus === 404) {
        return fail(
          res,
          400,
          'حذف مخزن ممکن نیست؛ توکن شما باید دسترسی delete_repo داشته باشد.'
        );
      }

      throw e;
    }

    db.prepare('DELETE FROM changes WHERE repo = ?').run(full);

    return send(res, 200, { ok: true });
  }

  /* ---- شاخه‌ها ---- */
  if (
    req.method === 'GET' &&
    url.pathname === `/api/repos/${owner}/${repo}/branches`
  ) {
    const all = [];

    for (let page = 1; page <= 5; page++) {
      const { data } = await gh(
        `/repos/${full}/branches?per_page=100&page=${page}`
      );

      all.push(...data);

      if (data.length < 100) break;
    }

    return send(res, 200, {
      branches: all.map((b) => ({
        name: b.name,
        protected: b.protected
      }))
    });
  }

  if (
    req.method === 'POST' &&
    url.pathname === `/api/repos/${owner}/${repo}/branches`
  ) {
    const b = await readBody(req);
    const name = (b.name || '').trim();

    if (!/^[\w.\-\/]{1,200}$/.test(name)) {
      return fail(res, 400, 'نام شاخه معتبر نیست.');
    }

    const from = (b.from || '').trim();

    const { data: ref } = await gh(
      `/repos/${full}/git/ref/heads/${from.split('/').map(encodeURIComponent).join('/')}`
    );

    await gh(`/repos/${full}/git/refs`, {
      method: 'POST',
      body: {
        ref: `refs/heads/${name}`,
        sha: ref.object.sha
      },
    });

    return send(res, 201, { ok: true });
  }

  /* ---- درخت فایل (بازگشتی) ---- */
  if (
    req.method === 'GET' &&
    url.pathname === `/api/repos/${owner}/${repo}/tree`
  ) {
    let branch = branchFromQuery;

    if (!branch) {
      const { data } = await gh(`/repos/${full}`);
      branch = data.default_branch;
    }

    if (!branch) {
      return fail(res, 404, 'شاخه پیش‌فرض مخزن مشخص نیست.');
    }

    // در API گیت‌هاب، ref در این endpoint به شکل heads/main است.
    const refPath = `heads/${branch}`
      .split('/')
      .map(encodeURIComponent)
      .join('/');

    let head;

    try {
      const { data } = await gh(
        `/repos/${full}/git/ref/${refPath}`
      );

      head = data.object.sha;
    } catch (e) {
      console.error('[TREE REF ERROR]', {
        repository: full,
        branch,
        status: e.ghStatus,
        message: e.message
      });

      if (e.ghStatus === 404) {
        return fail(
          res,
          404,
          `شاخه «${branch}» یافت نشد یا مخزن قابل دسترسی نیست.`,
          { github_status: 404 }
        );
      }

      throw e;
    }

    try {
      const { data: commitData } = await gh(
        `/repos/${full}/git/commits/${head}`
      );

      const baseTree = commitData.tree.sha;

      const { data: treeData } = await gh(
        `/repos/${full}/git/trees/${baseTree}?recursive=1`
      );

      const entries = (treeData.tree || [])
        .filter((t) => t.type === 'blob')
        .map((t) => ({
          path: t.path,
          sha: t.sha,
          size: t.size || 0
        }));

      const stagedCount = db.prepare(
        'SELECT COUNT(*) AS c FROM changes WHERE repo = ?'
      ).get(full).c;

      return send(res, 200, {
        branch,
        head_sha: head,
        base_tree: baseTree,
        entries,
        truncated: !!treeData.truncated,
        staged_count: stagedCount,
      });

    } catch (e) {
      console.error('[TREE CONTENT ERROR]', {
        repository: full,
        branch,
        head,
        githubStatus: e.ghStatus,
        message: e.message
      });

      throw e;
    }
  }

  /* ---- محتوای فایل ---- */
  if (
    req.method === 'GET' &&
    url.pathname === `/api/repos/${owner}/${repo}/content`
  ) {
    const p = safePath(url.searchParams.get('path') || '');

    if (!p) {
      return fail(res, 400, 'مسیر فایل نامعتبر است.');
    }

    const branch = branchFromQuery;
    let data;

    try {
      const apiPath =
        `/repos/${full}/contents/${p.split('/').map(encodeURIComponent).join('/')}` +
        (branch ? `?ref=${encodeURIComponent(branch)}` : '');

      ({ data } = await gh(apiPath));

    } catch (e) {
      if (e.ghStatus === 404) {
        return fail(res, 404, 'فایل یافت نشد.');
      }

      if (e.ghStatus === 403) {
        const sha = url.searchParams.get('sha');

        if (!sha) {
          return fail(
            res,
            403,
            'فایل برای API محتوا بزرگ است و SHA آن ارسال نشده.'
          );
        }

        ({ data } = await gh(`/repos/${full}/git/blobs/${sha}`));
      } else {
        throw e;
      }
    }

    if (Array.isArray(data) || data.type === 'dir') {
      return fail(res, 400, 'این مسیر یک پوشه است.');
    }

    if (data.content === undefined) {
      return fail(res, 404, 'محتوای فایل در دسترس نیست.');
    }

    if ((data.size || 0) > 25 * 1024 * 1024) {
      return fail(res, 400, 'فایل بزرگ‌تر از ۲۵ مگابایت قابل دریافت نیست.');
    }

    return send(res, 200, {
      path: p,
      name: data.name || p.split('/').pop(),
      size: data.size || 0,
      sha: data.sha,
      content: data.content,
      encoding: data.encoding || 'base64',
    });
  }

  return fail(res, 404, 'مسیر مخزن یافت نشد.');
}

/* ============================== تغییرات محلی (Stage) ============================== */

function stagingRows(full) {
  return db.prepare(
    'SELECT * FROM changes WHERE repo = ? ORDER BY id'
  ).all(full).map((r) => ({
    id: r.id,
    op: r.op,
    kind: r.kind,
    path: r.path,
    dst: r.dst,
    is_binary: !!r.is_binary,
    size: r.size,
    created_at: r.created_at,
    content: r.content,
  }));
}

async function handleStaging(req, res, url, owner, repo) {
  requireAuth();

  const full = `${owner}/${repo}`;

  const m = url.pathname.match(
    /^\/api\/staging\/([^/]+)\/([^/]+)(?:\/(\d+))?$/
  );

  if (!m) return fail(res, 404, 'مسیر یافت نشد.');

  const ownerD = decodeURIComponent(m[1]);
  const repoD = decodeURIComponent(m[2]);
  const fullD = `${ownerD}/${repoD}`;
  const opId = m[3] ? Number(m[3]) : null;

  /* فهرست تغییرات ثبت‌شده محلی */
  if (req.method === 'GET' && opId === null) {
    return send(res, 200, {
      changes: stagingRows(fullD)
    });
  }

  /* افزودن تغییر */
  if (req.method === 'POST' && opId === null) {
    const b = await readBody(req);
    const op = b.op;
    const kind = b.kind;
    const p = safePath(b.path);

    if (!['create', 'edit', 'delete', 'move', 'copy'].includes(op)) {
      return fail(res, 400, 'نوع عملیات نامعتبر است.');
    }

    if (!['file', 'folder'].includes(kind)) {
      return fail(res, 400, 'نوع آیتم نامعتبر است.');
    }

    if (!p) {
      return fail(res, 400, 'مسیر نامعتبر است.');
    }

    let dst = null;

    if (op === 'move' || op === 'copy') {
      dst = safePath(b.dst);

      if (!dst) {
        return fail(res, 400, 'مسیر مقصد نامعتبر است.');
      }

      if (dst === p) {
        return fail(res, 400, 'مبدأ و مقصد یکسان است.');
      }

      if (dst.startsWith(p + '/')) {
        return fail(res, 400, 'نمیتوان یک آیتم را داخل خودش منتقل کرد.');
      }
    }

    let content = null;
    let isBinary = 0;
    let size = 0;

    if (
      (op === 'create' || op === 'edit') &&
      kind === 'file'
    ) {
      if (typeof b.content !== 'string' || !b.content) {
        return fail(res, 400, 'محتوا (base64) ارسال نشده است.');
      }

      const buf = Buffer.from(b.content, 'base64');

      if (!buf.length) {
        return fail(res, 400, 'محتوای فایل خالی است.');
      }

      const limit = b.is_binary
        ? 20 * 1024 * 1024
        : 10 * 1024 * 1024;

      const limitMsg = b.is_binary ? '۲۰' : '۱۰';

      if (buf.length > limit) {
        return fail(
          res,
          400,
          `فایل بزرگ‌تر از ${limitMsg} مگابایت قابل ثبت نیست.`
        );
      }

      isBinary = b.is_binary ? 1 : 0;
      content = b.content;
      size = buf.length;
    }

    const info = db.prepare(`
      INSERT INTO changes(
        repo,op,kind,path,dst,content,is_binary,size,created_at
      )
      VALUES(?,?,?,?,?,?,?,?,?)
    `).run(
      fullD,
      op,
      kind,
      p,
      dst,
      content,
      isBinary,
      size,
      new Date().toISOString()
    );

    return send(res, 201, {
      id: info.lastInsertRowid,
      changes: stagingRows(fullD)
    });
  }

  /* حذف یک تغییر از صف */
  if (req.method === 'DELETE' && opId !== null) {
    const r = db.prepare(
      'SELECT id FROM changes WHERE id = ? AND repo = ?'
    ).get(opId, fullD);

    if (!r) {
      return fail(res, 404, 'تغییر یافت نشد.');
    }

    db.prepare('DELETE FROM changes WHERE id = ?').run(opId);

    return send(res, 200, {
      changes: stagingRows(fullD)
    });
  }

  /* حذف همه تغییرات مخزن */
  if (req.method === 'DELETE' && opId === null) {
    db.prepare(
      'DELETE FROM changes WHERE repo = ?'
    ).run(fullD);

    return send(res, 200, { changes: [] });
  }

  return fail(res, 404, 'مسیر یافت نشد.');
}

/* ============================== موتور کامیت ============================== */

/** اعمال ترتیبی صف تغییرات روی نقشه‌ی درخت */
function applyOps(remoteEntries, ops) {
  const work = new Map();

  for (const e of remoteEntries) {
    work.set(e.path, { sha: e.sha });
  }

  const err = (op, msg) => {
    const e = new Error(`«${op.path}»: ${msg}`);
    e.path = op.path;
    throw e;
  };

  for (const op of ops) {
    const p = op.path;

    switch (`${op.op}:${op.kind}`) {
      case 'create:file':
      case 'edit:file':
        work.set(p, { contentB64: op.content || '' });
        break;

      case 'delete:file':
        if (!work.has(p)) err(op, 'فایل یافت نشد.');
        work.delete(p);
        break;

      case 'move:file': {
        if (!work.has(p)) err(op, 'فایل یافت نشد.');

        const v = work.get(p);

        work.delete(p);
        work.set(op.dst, v);
        break;
      }

      case 'copy:file': {
        if (!work.has(p)) err(op, 'فایل یافت نشد.');

        work.set(op.dst, work.get(p));
        break;
      }

      case 'create:folder':
        work.set(p + '/.gitkeep', { contentB64: '' });
        break;

      case 'delete:folder': {
        let found = false;

        for (const key of [...work.keys()]) {
          if (key === p || key.startsWith(p + '/')) {
            work.delete(key);
            found = true;
          }
        }

        if (!found) err(op, 'پوشه خالی است یا یافت نشد.');
        break;
      }

      case 'move:folder': {
        let found = false;

        for (const key of [...work.keys()]) {
          if (key.startsWith(p + '/')) {
            work.set(
              op.dst + key.slice(p.length),
              work.get(key)
            );

            work.delete(key);
            found = true;
          }
        }

        if (!found) {
          err(
            op,
            'پوشه یافت نشد یا خالی است (پوشه‌های خالی در گیت وجود ندارند).'
          );
        }

        break;
      }

      case 'copy:folder': {
        let found = false;

        for (const key of [...work.keys()]) {
          if (key.startsWith(p + '/')) {
            work.set(
              op.dst + key.slice(p.length),
              work.get(key)
            );

            found = true;
          }
        }

        if (!found) {
          err(
            op,
            'پوشه یافت نشد یا خالی است (پوشه‌های خالی در گیت وجود ندارند).'
          );
        }

        break;
      }

      default:
        err(op, 'عملیات ناشناخته.');
    }
  }

  return work;
}

/** مقایسه وضعیت نهایی با درخت اصلی */
function computeDiff(remoteEntries, work) {
  const remoteMap = new Map(
    remoteEntries.map((e) => [e.path, e])
  );

  const diff = [];

  for (const [filePath, v] of work) {
    if (v.contentB64 !== undefined) {
      diff.push({
        path: filePath,
        mode: '100644',
        contentB64: v.contentB64,
        status: remoteMap.has(filePath) ? 'modified' : 'added'
      });
    } else {
      const orig = remoteMap.get(filePath);

      if (!orig || orig.sha !== v.sha) {
        diff.push({
          path: filePath,
          mode: '100644',
          sha: v.sha,
          status: orig ? 'modified' : 'renamed'
        });
      }
    }
  }

  for (const [filePath] of remoteMap) {
    if (!work.has(filePath)) {
      diff.push({
        path: filePath,
        mode: '100644',
        sha: null,
        status: 'removed'
      });
    }
  }

  return diff;
}

async function handleCommit(req, res, url, owner, repo) {
  requireAuth();

  const full = `${owner}/${repo}`;

  if (req.method !== 'POST') {
    return fail(res, 404, 'متد پشتیبانی نمی‌شود.');
  }

  const b = await readBody(req);
  const message = (b.message || '').trim();

  if (!message) {
    return fail(res, 400, 'پیام کامیت را بنویسید.');
  }

  if (message.length > 5000) {
    return fail(res, 400, 'پیام کامیت بیش از حد طولانی است.');
  }

  const ops = db.prepare(
    'SELECT * FROM changes WHERE repo = ? ORDER BY id'
  ).all(full);

  if (!ops.length) {
    return fail(res, 400, 'هیچ تغییری برای ثبت وجود ندارد.');
  }

  /* ۱) HEAD شاخه */
  let branch = (b.branch || '').trim();

  if (!branch) {
    const { data: r } = await gh(`/repos/${full}`);
    branch = r.default_branch;
  }

  const refPath = `heads/${branch}`
    .split('/')
    .map(encodeURIComponent)
    .join('/');

  let head;

  try {
    const { data } = await gh(
      `/repos/${full}/git/ref/${refPath}`
    );

    head = data.object.sha;

  } catch (e) {
    if (e.ghStatus === 404) {
      return fail(res, 404, `شاخه «${branch}» یافت نشد.`);
    }

    throw e;
  }

  /* ۲) درخت پایه و فایل‌های فعلی */
  const { data: commitData } = await gh(
    `/repos/${full}/git/commits/${head}`
  );

  const baseTree = commitData.tree.sha;

  const { data: treeData } = await gh(
    `/repos/${full}/git/trees/${baseTree}?recursive=1`
  );

  const remoteEntries = (treeData.tree || [])
    .filter((t) => t.type === 'blob')
    .map((t) => ({
      path: t.path,
      sha: t.sha,
      size: t.size || 0
    }));

  /* ۳) اعمال تغییرات محلی */
  const work = applyOps(
    remoteEntries,
    ops.map((o) => ({
      op: o.op,
      kind: o.kind,
      path: o.path,
      dst: o.dst,
      content: o.content,
    }))
  );

  const diff = computeDiff(remoteEntries, work);

  if (!diff.length) {
    return fail(
      res,
      400,
      'بعد از اعمال تغییرات، هیچ تفاوتی با نسخه‌ی گیت‌هاب باقی نمانده است.'
    );
  }

  /* ۴) آپلود بلاب‌های جدید */
  let uploaded = 0;

  for (const d of diff) {
    if (d.contentB64 !== undefined) {
      const { data: blob } = await gh(
        `/repos/${full}/git/blobs`,
        {
          method: 'POST',
          body: {
            content: d.contentB64,
            encoding: 'base64'
          },
        }
      );

      d.sha = blob.sha;
      delete d.contentB64;
      uploaded++;
    }
  }

  /* ۵) ساخت درخت */
  let treeSha = baseTree;

  for (let i = 0; i < diff.length; i += 400) {
    const batch = diff.slice(i, i + 400).map((d) => ({
      path: d.path,
      mode: d.mode,
      type: 'blob',
      sha: d.sha
    }));

    const { data } = await gh(
      `/repos/${full}/git/trees`,
      {
        method: 'POST',
        body: {
          base_tree: treeSha,
          tree: batch
        },
      }
    );

    treeSha = data.sha;
  }

  /* ۶) هویت نویسنده و پیام کامیت */
  const authorName =
    getSetting('author_name') || 'GitHub Manager';

  const authorEmail =
    getSetting('author_email') || 'manager@github-manager.local';

  let fullMessage = message;

  if (getSetting('coauthor') !== '0') {
    try {
      const { data: u } = await gh('/user');

      const email = u.email ||
        `${u.id}+${u.login}@users.noreply.github.com`;

      const name = u.name || u.login;

      fullMessage += `\n\nCo-authored-by: ${name} <${email}>`;

    } catch {
      // در صورت خطا، کامیت بدون Co-author ادامه می‌یابد.
    }
  }

  /* ۷) ساخت کامیت */
  const { data: newCommit } = await gh(
    `/repos/${full}/git/commits`,
    {
      method: 'POST',
      body: {
        message: fullMessage,
        tree: treeSha,
        parents: [head],
        author: {
          name: authorName,
          email: authorEmail,
          date: new Date().toISOString()
        },
      },
    }
  );

  /* به‌روزرسانی شاخه */
  try {
    await gh(
      `/repos/${full}/git/refs/${refPath}`,
      {
        method: 'PATCH',
        body: {
          sha: newCommit.sha,
          force: false
        }
      }
    );

  } catch (e) {
    if (e.ghStatus === 422) {
      return fail(
        res,
        409,
        'شاخه در این فاصله تغییر کرده است؛ دوباره تلاش کنید.'
      );
    }

    if (e.ghStatus === 403) {
      return fail(
        res,
        403,
        'کامیت روی این شاخه مجاز نیست (ممکن است محافظت‌شده باشد).'
      );
    }

    throw e;
  }

  /* ۸) پاک‌سازی صف تغییرات */
  db.prepare(
    'DELETE FROM changes WHERE repo = ?'
  ).run(full);

  const counts = {
    added: 0,
    modified: 0,
    removed: 0,
    renamed: 0
  };

  for (const d of diff) {
    counts[d.status] = (counts[d.status] || 0) + 1;
  }

  return send(res, 200, {
    ok: true,
    sha: newCommit.sha,
    html_url: `https://github.com/${full}/commit/${newCommit.sha}`,
    branch,
    total_changes: diff.length,
    uploaded_blobs: uploaded,
    counts,
  });
}

/* ============================== سرور و مسیریابی ============================== */

function serveStatic(req, res, url) {
  if (
    url.pathname === '/' ||
    url.pathname === '/index.html'
  ) {
    const file = path.join(PUBLIC_DIR, 'index.html');

    if (!fs.existsSync(file)) {
      res.writeHead(500);
      return res.end('public/index.html یافت نشد');
    }

    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store'
    });

    return res.end(fs.readFileSync(file));
  }

  if (url.pathname === '/favicon.ico') {
    res.writeHead(204);
    return res.end();
  }

  res.writeHead(404, {
    'Content-Type': 'text/plain; charset=utf-8'
  });

  res.end('Not found');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(
    req.url,
    `http://${req.headers.host || 'localhost'}`
  );

  req.urlParts = url.pathname.split('/');

  try {
    if (url.pathname === '/api/health') {
      return send(res, 200, {
        ok: true,
        app: 'GitHub Manager',
        time: new Date().toISOString()
      });
    }

    if (url.pathname.startsWith('/api/auth/')) {
      return await handleAuth(req, res, url);
    }

    if (url.pathname === '/api/settings') {
      return await handleSettings(req, res, url);
    }

    if (url.pathname.startsWith('/api/repos')) {
      const segs = url.pathname.split('/').filter(Boolean);

      const owner = segs[2]
        ? decodeURIComponent(segs[2])
        : '';

      const repo = segs[3]
        ? decodeURIComponent(segs[3])
        : '';

      return await handleRepos(
        req,
        res,
        url,
        owner,
        repo
      );
    }

    if (url.pathname.startsWith('/api/staging/')) {
      const segs = url.pathname.split('/').filter(Boolean);

      const owner = segs[2]
        ? decodeURIComponent(segs[2])
        : '';

      const repo = segs[3]
        ? decodeURIComponent(segs[3])
        : '';

      return await handleStaging(
        req,
        res,
        url,
        owner,
        repo
      );
    }

    if (url.pathname.startsWith('/api/commit/')) {
      const segs = url.pathname.split('/').filter(Boolean);

      const owner = segs[2]
        ? decodeURIComponent(segs[2])
        : '';

      const repo = segs[3]
        ? decodeURIComponent(segs[3])
        : '';

      return await handleCommit(
        req,
        res,
        url,
        owner,
        repo
      );
    }

    if (!url.pathname.startsWith('/api/')) {
      return serveStatic(req, res, url);
    }

    return fail(res, 404, 'مسیر API یافت نشد.');

  } catch (e) {
    if (e.message === 'AUTH' || e.code === 401) {
      return fail(res, 401, 'AUTH');
    }

    if (e.code === 409) {
      return fail(res, 409, e.message);
    }

    if (e.code && e.code >= 400 && e.code < 600) {
      return fail(res, e.code, e.message, {
        github_status: e.ghStatus || null
      });
    }

    console.error('[خطای سرور]', e);

    return fail(
      res,
      500,
      'خطای داخلی سرور: ' + e.message
    );
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log('┌──────────────────────────────────────────────┐');
    console.log('│   GitHub Manager  •  مدیریت‌کننده گیت‌هاب      │');
    console.log(`│   آدرس:  http://localhost:${PORT.padStart(4)}            │`);
    console.log('│   دیتابیس:  data/github-manager.db           │');
    console.log('│   توقف: Ctrl+C                               │');
    console.log('└──────────────────────────────────────────────┘');
  });
}

module.exports = {
  applyOps,
  computeDiff,
  server,
  PORT,
  HOST
};