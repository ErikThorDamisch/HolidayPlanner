'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const http   = require('node:http');
const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');

const { createApp, defaultYearData } = require('../server.js');

const JWT_SECRET = 'test-secret';

// ── Test helpers ──────────────────────────────────────────────────────────────

// A minimal stand-in for a pg Pool. `handler(text, params)` returns the rows for
// each query; it also records every call so tests can assert on what was run.
function makePool(handler) {
  const calls = [];
  return {
    calls,
    query: async (text, params) => {
      calls.push({ text, params });
      const rows = (handler ? handler(text, params) : undefined) || [];
      return { rows };
    },
  };
}

// Boot the app on an ephemeral port and hand back a tiny fetch wrapper + closer.
async function startApp(pool, opts = {}) {
  const app = createApp({ pool, jwtSecret: JWT_SECRET, ...opts });
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const request = async (method, path, { body, token, rawAuth } = {}) => {
    const headers = {};
    if (body    !== undefined) headers['Content-Type']  = 'application/json';
    if (token   !== undefined) headers['Authorization'] = 'Bearer ' + token;
    if (rawAuth !== undefined) headers['Authorization'] = rawAuth;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch { /* non-JSON body */ }
    return { status: res.status, json };
  };

  const close = () => new Promise(resolve => server.close(resolve));
  return { request, close, pool };
}

function tokenFor(user) {
  return jwt.sign(user, JWT_SECRET, { expiresIn: '30d' });
}

// ── defaultYearData ────────────────────────────────────────────────────────────

test('defaultYearData returns a fresh, sensible blank year', () => {
  const d = defaultYearData();
  assert.deepEqual(d, {
    settings: { totalDays: 25, dailyHours: 8, workSat: 'none', workSun: 'none' },
    vacations: {},
    holidays: [],
    compDays: {},
  });
  // Returns a new object each call (no shared mutable state).
  assert.notEqual(defaultYearData(), d);
  defaultYearData().holidays.push('x');
  assert.deepEqual(defaultYearData().holidays, []);
});

test('createApp throws without a pool', () => {
  assert.throws(() => createApp({}), /requires a pool/);
});

// ── Registration ────────────────────────────────────────────────────────────────

test('register rejects missing credentials', async () => {
  const app = await startApp(makePool());
  try {
    const res = await app.request('POST', '/api/auth/register', { body: { username: 'alice' } });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /required/);
  } finally { await app.close(); }
});

test('register rejects a too-short username', async () => {
  const app = await startApp(makePool());
  try {
    const res = await app.request('POST', '/api/auth/register', { body: { username: 'ab', password: 'secret123' } });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /at least 3 characters/);
  } finally { await app.close(); }
});

test('register rejects a too-short password', async () => {
  const app = await startApp(makePool());
  try {
    const res = await app.request('POST', '/api/auth/register', { body: { username: 'alice', password: '123' } });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /at least 6 characters/);
  } finally { await app.close(); }
});

test('register rejects a duplicate username', async () => {
  const pool = makePool(text => text.startsWith('SELECT id FROM users') ? [{ id: 'existing' }] : []);
  const app = await startApp(pool);
  try {
    const res = await app.request('POST', '/api/auth/register', { body: { username: 'alice', password: 'secret123' } });
    assert.equal(res.status, 409);
    assert.match(res.json.error, /already taken/);
  } finally { await app.close(); }
});

test('register creates a user, trims the name and returns a usable token', async () => {
  const inserts = [];
  const pool = makePool((text, params) => {
    if (text.startsWith('SELECT id FROM users')) return [];   // no existing user
    if (text.startsWith('INSERT INTO users'))     { inserts.push(params); return []; }
    return [];
  });
  const app = await startApp(pool);
  try {
    const res = await app.request('POST', '/api/auth/register', { body: { username: '  alice  ', password: 'secret123' } });
    assert.equal(res.status, 200);
    assert.equal(res.json.username, 'alice');               // trimmed
    assert.ok(res.json.token, 'a token is returned');

    // Token is valid and carries the trimmed username.
    const decoded = jwt.verify(res.json.token, JWT_SECRET);
    assert.equal(decoded.username, 'alice');

    // The stored username and password hash look right.
    const [, storedName, storedHash] = inserts[0];
    assert.equal(storedName, 'alice');
    assert.ok(bcrypt.compareSync('secret123', storedHash), 'password is stored hashed, not in plaintext');
  } finally { await app.close(); }
});

test('register is blocked when registration is disabled', async () => {
  const app = await startApp(makePool(), { disableRegistration: true });
  try {
    const res = await app.request('POST', '/api/auth/register', { body: { username: 'alice', password: 'secret123' } });
    assert.equal(res.status, 403);
    assert.match(res.json.error, /disabled/);
  } finally { await app.close(); }
});

// ── Login ─────────────────────────────────────────────────────────────────────

test('login rejects missing credentials', async () => {
  const app = await startApp(makePool());
  try {
    const res = await app.request('POST', '/api/auth/login', { body: {} });
    assert.equal(res.status, 400);
  } finally { await app.close(); }
});

test('login rejects an unknown username', async () => {
  const app = await startApp(makePool(() => []));   // no user found
  try {
    const res = await app.request('POST', '/api/auth/login', { body: { username: 'ghost', password: 'secret123' } });
    assert.equal(res.status, 401);
    assert.match(res.json.error, /Invalid username or password/);
  } finally { await app.close(); }
});

test('login rejects a wrong password', async () => {
  const hash = bcrypt.hashSync('correct-horse', 10);
  const pool = makePool(() => [{ id: 'u1', username: 'alice', password_hash: hash }]);
  const app = await startApp(pool);
  try {
    const res = await app.request('POST', '/api/auth/login', { body: { username: 'alice', password: 'wrong' } });
    assert.equal(res.status, 401);
    assert.match(res.json.error, /Invalid username or password/);
  } finally { await app.close(); }
});

test('login succeeds with the right password and returns a token', async () => {
  const hash = bcrypt.hashSync('correct-horse', 10);
  const pool = makePool(() => [{ id: 'u1', username: 'Alice', password_hash: hash }]);
  const app = await startApp(pool);
  try {
    const res = await app.request('POST', '/api/auth/login', { body: { username: 'alice', password: 'correct-horse' } });
    assert.equal(res.status, 200);
    assert.equal(res.json.username, 'Alice');
    const decoded = jwt.verify(res.json.token, JWT_SECRET);
    assert.equal(decoded.id, 'u1');
  } finally { await app.close(); }
});

// ── Auth middleware (via /api/auth/me) ──────────────────────────────────────────

test('protected route returns 401 without a token', async () => {
  const app = await startApp(makePool());
  try {
    const res = await app.request('GET', '/api/auth/me');
    assert.equal(res.status, 401);
    assert.match(res.json.error, /Not authenticated/);
  } finally { await app.close(); }
});

test('protected route returns 401 for a non-Bearer Authorization header', async () => {
  const app = await startApp(makePool());
  try {
    const res = await app.request('GET', '/api/auth/me', { rawAuth: 'Basic abc123' });
    assert.equal(res.status, 401);
    assert.match(res.json.error, /Not authenticated/);
  } finally { await app.close(); }
});

test('protected route returns 401 for an invalid token', async () => {
  const app = await startApp(makePool());
  try {
    const res = await app.request('GET', '/api/auth/me', { token: 'not-a-real-jwt' });
    assert.equal(res.status, 401);
    assert.match(res.json.error, /Session expired/);
  } finally { await app.close(); }
});

test('protected route returns 401 for a token signed with the wrong secret', async () => {
  const app = await startApp(makePool());
  try {
    const badToken = jwt.sign({ id: 'u1', username: 'alice' }, 'some-other-secret');
    const res = await app.request('GET', '/api/auth/me', { token: badToken });
    assert.equal(res.status, 401);
  } finally { await app.close(); }
});

test('protected route returns the username for a valid token', async () => {
  const app = await startApp(makePool());
  try {
    const res = await app.request('GET', '/api/auth/me', { token: tokenFor({ id: 'u1', username: 'alice' }) });
    assert.equal(res.status, 200);
    assert.equal(res.json.username, 'alice');
  } finally { await app.close(); }
});

// ── Year data routes ────────────────────────────────────────────────────────────

test('GET /api/year returns stored data scoped to the user and year', async () => {
  const stored = { settings: { totalDays: 30, dailyHours: 7.5, workSat: 'half', workSun: 'none' }, vacations: { '2025-06-30': 'full' }, holidays: [], compDays: {} };
  const pool = makePool(() => [{ data: stored }]);
  const app = await startApp(pool);
  try {
    const res = await app.request('GET', '/api/year/2025', { token: tokenFor({ id: 'u1', username: 'alice' }) });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, stored);

    // Query was parameterised by the authenticated user id and parsed year.
    const dataQuery = pool.calls.find(c => c.text.includes('SELECT data FROM year_data'));
    assert.deepEqual(dataQuery.params, ['u1', 2025]);
  } finally { await app.close(); }
});

test('GET /api/year returns default data when nothing is stored', async () => {
  const pool = makePool(() => []);   // no rows
  const app = await startApp(pool);
  try {
    const res = await app.request('GET', '/api/year/2025', { token: tokenFor({ id: 'u1', username: 'alice' }) });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, defaultYearData());
  } finally { await app.close(); }
});

test('GET /api/year falls back to default data when the query throws', async () => {
  const pool = { query: async () => { throw new Error('db down'); } };
  const app = await startApp(pool);
  try {
    const res = await app.request('GET', '/api/year/2025', { token: tokenFor({ id: 'u1', username: 'alice' }) });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, defaultYearData());
  } finally { await app.close(); }
});

test('PUT /api/year rejects out-of-range and non-numeric years', async () => {
  const app = await startApp(makePool());
  const token = tokenFor({ id: 'u1', username: 'alice' });
  try {
    for (const yr of ['1999', '2101', 'abc']) {
      const res = await app.request('PUT', `/api/year/${yr}`, { token, body: { settings: {} } });
      assert.equal(res.status, 400, `year ${yr} should be rejected`);
      assert.match(res.json.error, /Invalid year/);
    }
  } finally { await app.close(); }
});

test('PUT /api/year persists the body for a valid year', async () => {
  const pool = makePool(() => []);
  const app = await startApp(pool);
  const token = tokenFor({ id: 'u1', username: 'alice' });
  const payload = { settings: { totalDays: 25 }, vacations: { '2025-07-01': 'morning' }, holidays: [], compDays: {} };
  try {
    const res = await app.request('PUT', '/api/year/2025', { token, body: payload });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { ok: true });

    const upsert = pool.calls.find(c => c.text.includes('INSERT INTO year_data'));
    assert.ok(upsert, 'an upsert was issued');
    assert.deepEqual(upsert.params, ['u1', 2025, payload]);
  } finally { await app.close(); }
});

test('PUT /api/year returns 500 when the write fails', async () => {
  const pool = { query: async () => { throw new Error('write failed'); } };
  const app = await startApp(pool);
  const token = tokenFor({ id: 'u1', username: 'alice' });
  try {
    const res = await app.request('PUT', '/api/year/2025', { token, body: { settings: {} } });
    assert.equal(res.status, 500);
    assert.match(res.json.error, /Failed to save/);
  } finally { await app.close(); }
});

test('year routes require authentication', async () => {
  const app = await startApp(makePool());
  try {
    assert.equal((await app.request('GET', '/api/year/2025')).status, 401);
    assert.equal((await app.request('PUT', '/api/year/2025', { body: {} })).status, 401);
  } finally { await app.close(); }
});
