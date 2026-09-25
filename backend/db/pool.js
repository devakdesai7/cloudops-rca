// Single shared pg.Pool instance for the entire backend.
// Neon requires SSL; rejectUnauthorized:false avoids cert-chain issues
// for this hackathon setup — known simplification, not production-grade.
require('dotenv').config();
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL is not set. Add it to backend/.env.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

module.exports = pool;
