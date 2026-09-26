// backend/index.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const pool = require('./db/pool');
const authRouter = require('./routes/auth');
const incidentsRouter = require('./routes/incidents');
const { requireAuth } = require('./middleware/auth');

const PORT = process.env.PORT || 4000;
const app = express();

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ── Routes ───────────────────────────────────────────────────────────────────
app.use('/api/auth', authRouter);
app.use('/api/incidents', requireAuth, incidentsRouter);

// ── Health check ─────────────────────────────────────────────────────────────
// GET /api/health  — also runs SELECT 1 to verify Neon connectivity.
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected' });
  } catch (err) {
    console.error('Health check DB error:', err.message);
    res.status(503).json({ status: 'error', db: 'unreachable', detail: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
async function start() {
  if (!process.env.DATABASE_URL) {
    console.error('ERROR: DATABASE_URL is not set. Create backend/.env from backend/.env.example.');
    process.exit(1);
  }

  // Verify the DB is reachable before accepting traffic.
  try {
    await pool.query('SELECT 1');
    console.log('Database connection verified.');
  } catch (err) {
    console.error('ERROR: Could not reach the Neon database:', err.message);
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`Backend listening on http://localhost:${PORT}`);
    console.log(`Health: http://localhost:${PORT}/api/health`);
    console.log('NOTE: Migrations are NOT run automatically. Run "node db/migrate.js" manually once.');
  });
}

start();
