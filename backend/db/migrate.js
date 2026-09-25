// backend/db/migrate.js
// Reads schema.sql and runs each CREATE TABLE statement with
// CREATE TABLE IF NOT EXISTS semantics so it is safe and idempotent.
// Run manually: node db/migrate.js
// DO NOT auto-run this on server startup — the DB is shared by the team.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL is not set. Add it to backend/.env.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function migrate() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const raw = fs.readFileSync(schemaPath, 'utf8');

  // Convert every "CREATE TABLE <name>" to "CREATE TABLE IF NOT EXISTS <name>"
  // so re-running against the shared Neon DB never clobbers existing data.
  const idempotentSql = raw.replace(
    /CREATE TABLE\s+(?!IF NOT EXISTS)/gi,
    'CREATE TABLE IF NOT EXISTS '
  );

  const client = await pool.connect();
  try {
    console.log('Running migrations against shared Neon database…');
    await client.query(idempotentSql);
    console.log('Migration complete. All tables are up to date.');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
