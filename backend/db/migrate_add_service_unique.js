// backend/db/migrate_add_service_unique.js
// One-time migration: adds the UNIQUE (incident_id, service) constraint to
// the incident_services table that already exists on the shared Neon database.
//
// Safe to re-run — uses ADD CONSTRAINT IF NOT EXISTS semantics.
// Run manually ONCE: node db/migrate_add_service_unique.js
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

async function run() {
  const client = await pool.connect();
  try {
    console.log('Adding UNIQUE constraint on incident_services(incident_id, service)…');
    // DO $$ block makes this idempotent: skips if the constraint already exists.
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'incident_services_incident_id_service_key'
            AND conrelid = 'incident_services'::regclass
        ) THEN
          ALTER TABLE incident_services
            ADD CONSTRAINT incident_services_incident_id_service_key
            UNIQUE (incident_id, service);
          RAISE NOTICE 'Constraint added.';
        ELSE
          RAISE NOTICE 'Constraint already exists — skipping.';
        END IF;
      END
      $$;
    `);
    console.log('Done.');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
