const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const fs       = require('fs');
const path     = require('path');
const crypto   = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Config ────────────────────────────────────────────────────────────────────
const DATA_DIR    = process.env.DATA_DIR || path.join(__dirname, 'data');
const USERS_FILE  = path.join(DATA_DIR, 'users.json');
const USER_DATA   = path.join(DATA_DIR, 'userdata');

// IMPORTANT: set JWT_SECRET as an environment variable on Render (or anywhere
// you deploy). If left unset, a random secret is generated at startup, which
// means all users are logged out every time the server restarts.
const JWT_SECRET  = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');

// Set DISABLE_REGISTRATION=true in env vars to stop new sign-ups
// (useful once you've created all the accounts you need)
const DISABLE_REGISTRATION = process.env.DISABLE_REGISTRATION === 'true';

// ── Ensure directories exist ──────────────────────────────────────────────────
[DATA_DIR, USER_DATA].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── User store helpers ────────────────────────────────────────────────────────
function readUsers() {
    try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }
    catch (e) { return { users: [] }; }
}
function writeUsers(store) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(store, null, 2));
}

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
    if (username.trim().length < 3)  return res.status(400).json({ error: 'Username must be at least 3 characters.' });
    if (password.length < 6)         return res.status(400).json({ error: 'Password must be at least 6 characters.' });

    const store = readUsers();
    if (store.users.find(u => u.username.toLowerCase() === username.toLowerCase())) {
        return res.status(409).json({ error: 'That username is already taken.' });
    }

    const hash = await bcrypt.hash(password, 10);
    const user = {
        id: crypto.randomUUID(),
        username: username.trim(),
        passwordHash: hash,
        createdAt: new Date().toISOString()
    };
    store.users.push(user);
    writeUsers(store);

    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, username: user.username });
});

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });

    const store = readUsers();
    const user  = store.users.find(u => u.username.toLowerCase() === username.toLowerCase());
    if (!user) return res.status(401).json({ error: 'Invalid username or password.' });

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok)  return res.status(401).json({ error: 'Invalid username or password.' });

    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, username: user.username });
});

// GET /api/auth/me  — validate token and return username
app.get('/api/auth/me', requireAuth, (req, res) => {
    res.json({ username: req.user.username });
});

// ── Per-user data helpers ─────────────────────────────────────────────────────
function userDir(userId) {
    const dir = path.join(USER_DATA, userId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function yearFile(userId, year) {
    return path.join(userDir(userId), `year_${parseInt(year)}.json`);
}

function defaultYearData() {
    return { settings: { totalDays: 25, dailyHours: 8 }, vacations: {}, holidays: [] };
}

// ── Data routes (auth required) ───────────────────────────────────────────────

// GET /api/year/:year
app.get('/api/year/:year', requireAuth, (req, res) => {
    const file = yearFile(req.user.id, req.params.year);
    if (!fs.existsSync(file)) return res.json(defaultYearData());
    try { res.json(JSON.parse(fs.readFileSync(file, 'utf8'))); }
    catch (e) { res.json(defaultYearData()); }
});

// PUT /api/year/:year
app.put('/api/year/:year', requireAuth, (req, res) => {
    const year = parseInt(req.params.year);
    if (isNaN(year) || year < 2000 || year > 2100) {
        return res.status(400).json({ error: 'Invalid year.' });
    }
    try {
        fs.writeFileSync(yearFile(req.user.id, year), JSON.stringify(req.body, null, 2));
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: 'Failed to save data.' });
    }
});

// ── Catch-all: serve login page for unknown routes ────────────────────────────
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Swiss Holiday Planner v2 running at http://localhost:${PORT}`);
    console.log(`Registration: ${DISABLE_REGISTRATION ? 'DISABLED' : 'enabled'}`);
    if (!process.env.JWT_SECRET) {
        console.warn('⚠  JWT_SECRET not set — tokens will be invalidated on every restart!');
        console.warn('   Set JWT_SECRET as an environment variable for persistent sessions.');
    }
});
