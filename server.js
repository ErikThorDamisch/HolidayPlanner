const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const crypto   = require('crypto');
const { Pool } = require('pg');
const path     = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

const JWT_SECRET           = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const DISABLE_REGISTRATION = process.env.DISABLE_REGISTRATION === 'true';

// ── Database ──────────────────────────────────────────────────────────────────
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});

async function initDb() {
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

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    try {
        req.user = jwt.verify(auth.slice(7), JWT_SECRET);
        next();
    } catch (e) {
        res.status(401).json({ error: 'Session expired, please log in again' });
    }
}

// ── Auth routes ───────────────────────────────────────────────────────────────

// POST /api/auth/register
app.post('/api/auth/register', async (req, res) => {
    if (DISABLE_REGISTRATION) {
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
        const token = jwt.sign({ id, username: username.trim() }, JWT_SECRET, { expiresIn: '30d' });
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

        const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
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

function defaultYearData() {
    return { settings: { totalDays: 25, dailyHours: 8, workSat: 'none', workSun: 'none' }, vacations: {}, holidays: [], compDays: {} };
}

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
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────
initDb()
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
