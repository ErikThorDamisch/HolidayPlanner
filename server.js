const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const crypto   = require('crypto');
const { Pool } = require('pg');
const path     = require('path');

const PORT = process.env.PORT || 3000;

const DEFAULT_JWT_SECRET   = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const DISABLE_REGISTRATION = process.env.DISABLE_REGISTRATION === 'true';

const PUBLIC_DIR = path.join(__dirname, 'public');

// ── Database ──────────────────────────────────────────────────────────────────
async function initDb(pool) {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id            TEXT PRIMARY KEY,
            username      TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            created_at    TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS year_data (
            user_id TEXT    NOT NULL,
            year    INTEGER NOT NULL,
            data    JSONB   NOT NULL DEFAULT '{}',
            PRIMARY KEY (user_id, year)
        );
    `);
}

function defaultYearData() {
    return { settings: { totalDays: 25, dailyHours: 8, workSat: 'none', workSun: 'none' }, vacations: {}, holidays: [], compDays: {} };
}

// ── App factory ───────────────────────────────────────────────────────────────
// Building the app through a factory (rather than at module load) keeps it free of
// implicit globals, so tests can inject a fake pool / secret and exercise routes.
function createApp({ pool, jwtSecret = DEFAULT_JWT_SECRET, disableRegistration = DISABLE_REGISTRATION } = {}) {
    if (!pool) throw new Error('createApp requires a pool');

    const app = express();

    app.use(express.json());
    app.use(express.static(PUBLIC_DIR));

    // ── Auth middleware ─────────────────────────────────────────────────────────
    function requireAuth(req, res, next) {
        const auth = req.headers.authorization;
        if (!auth || !auth.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Not authenticated' });
        }
        try {
            req.user = jwt.verify(auth.slice(7), jwtSecret);
            next();
        } catch (e) {
            res.status(401).json({ error: 'Session expired, please log in again' });
        }
    }

    // ── Auth routes ─────────────────────────────────────────────────────────────

    // POST /api/auth/register
    app.post('/api/auth/register', async (req, res) => {
        if (disableRegistration) {
            return res.status(403).json({ error: 'Registration is currently disabled.' });
        }
        const { username, password } = req.body || {};
        if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });
        if (username.trim().length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters.' });
        if (password.length < 6)        return res.status(400).json({ error: 'Password must be at least 6 characters.' });

        try {
            const existing = await pool.query(
                'SELECT id FROM users WHERE lower(username) = lower($1)', [username]
            );
            if (existing.rows.length) return res.status(409).json({ error: 'That username is already taken.' });

            const hash = await bcrypt.hash(password, 10);
            const id   = crypto.randomUUID();
            await pool.query(
                'INSERT INTO users (id, username, password_hash, created_at) VALUES ($1, $2, $3, $4)',
                [id, username.trim(), hash, new Date().toISOString()]
            );
            const token = jwt.sign({ id, username: username.trim() }, jwtSecret, { expiresIn: '30d' });
            res.json({ token, username: username.trim() });
        } catch (e) {
            console.error('Register error:', e);
            res.status(500).json({ error: 'Registration failed.' });
        }
    });

    // POST /api/auth/login
    app.post('/api/auth/login', async (req, res) => {
        const { username, password } = req.body || {};
        if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });

        try {
            const result = await pool.query(
                'SELECT * FROM users WHERE lower(username) = lower($1)', [username]
            );
            const user = result.rows[0];
            if (!user) return res.status(401).json({ error: 'Invalid username or password.' });

            const ok = await bcrypt.compare(password, user.password_hash);
            if (!ok) return res.status(401).json({ error: 'Invalid username or password.' });

            const token = jwt.sign({ id: user.id, username: user.username }, jwtSecret, { expiresIn: '30d' });
            res.json({ token, username: user.username });
        } catch (e) {
            console.error('Login error:', e);
            res.status(500).json({ error: 'Login failed.' });
        }
    });

    // GET /api/auth/me
    app.get('/api/auth/me', requireAuth, (req, res) => {
        res.json({ username: req.user.username });
    });

    // ── Data routes ───────────────────────────────────────────────────────────────

    // GET /api/year/:year
    app.get('/api/year/:year', requireAuth, async (req, res) => {
        const year = parseInt(req.params.year);
        try {
            const result = await pool.query(
                'SELECT data FROM year_data WHERE user_id = $1 AND year = $2',
                [req.user.id, year]
            );
            res.json(result.rows.length ? result.rows[0].data : defaultYearData());
        } catch (e) {
            console.error('Fetch year error:', e);
            res.json(defaultYearData());
        }
    });

    // PUT /api/year/:year
    app.put('/api/year/:year', requireAuth, async (req, res) => {
        const year = parseInt(req.params.year);
        if (isNaN(year) || year < 2000 || year > 2100) {
            return res.status(400).json({ error: 'Invalid year.' });
        }
        try {
            await pool.query(
                `INSERT INTO year_data (user_id, year, data) VALUES ($1, $2, $3)
                 ON CONFLICT (user_id, year) DO UPDATE SET data = EXCLUDED.data`,
                [req.user.id, year, req.body]
            );
            res.json({ ok: true });
        } catch (e) {
            console.error('Save year error:', e);
            res.status(500).json({ error: 'Failed to save data.' });
        }
    });

    // ── Catch-all ─────────────────────────────────────────────────────────────────
    app.get('*', (req, res) => {
        res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
    });

    return app;
}

// ── Start (only when run directly) ──────────────────────────────────────────────
function start() {
    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
    });
    const app = createApp({ pool });

    return initDb(pool)
        .then(() => app.listen(PORT, () => {
            console.log(`Holiday Planner running at http://localhost:${PORT}`);
            console.log(`Registration: ${DISABLE_REGISTRATION ? 'DISABLED' : 'enabled'}`);
            if (!process.env.JWT_SECRET)    console.warn('⚠  JWT_SECRET not set — sessions reset on every restart!');
            if (!process.env.DATABASE_URL)  console.warn('⚠  DATABASE_URL not set!');
        }))
        .catch(err => {
            console.error('Failed to connect to database:', err.message);
            process.exit(1);
        });
}

// ── Vercel serverless entry ──────────────────────────────────────────────────
// Vercel wraps this file as a single Function covering every route (its
// zero-config Node.js detection, triggered by package.json's "main" field),
// so the module's default export has to be a request handler itself — an
// object of named exports isn't valid there. The pool/app are built lazily on
// first invocation and reused across warm invocations of the same function.
let vercelPool, vercelApp, vercelDbReady;
function vercelHandler(req, res) {
    if (!vercelApp) {
        vercelPool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: { rejectUnauthorized: false },
        });
        vercelApp = createApp({ pool: vercelPool });
    }
    if (!vercelDbReady) vercelDbReady = initDb(vercelPool);
    return vercelDbReady.then(() => vercelApp(req, res));
}

if (require.main === module) {
    start();
}

module.exports = vercelHandler;
module.exports.createApp = createApp;
module.exports.initDb = initDb;
module.exports.defaultYearData = defaultYearData;
module.exports.start = start;
