// Vercel serverless entry point. Wraps the same Express app used for the
// standalone server (server.js) so both hosts share one codebase — only the
// process bootstrap differs. `public/` is served by Vercel's static hosting
// directly, so this function only ever receives /api/* requests (see the
// rewrite in vercel.json).
const { Pool } = require('pg');
const { createApp, initDb } = require('../server');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});

const app = createApp({ pool });

// Table creation only needs to run once per warm lambda instance, not per request.
let dbReady = null;
function ensureDb() {
    if (!dbReady) dbReady = initDb(pool);
    return dbReady;
}

module.exports = async (req, res) => {
    await ensureDb();
    app(req, res);
};
