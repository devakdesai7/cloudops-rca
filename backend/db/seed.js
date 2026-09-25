// backend/db/seed.js
// Inserts two demo users only if the users table is empty.
// Safe to run multiple times — it is a no-op when users already exist.
// Run manually: node db/seed.js
require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const { randomUUID } = require('crypto');

if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL is not set. Add it to backend/.env.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const DEMO_USERS = [
  { email: 'approver@demo.com', password: 'approver123', role: 'approver', name: 'Alice Approver' },
  { email: 'viewer@demo.com',   password: 'viewer123',   role: 'viewer',   name: 'Victor Viewer'  },
];

async function seed() {
  const client = await pool.connect();
  try {
    const { rows } = await client.query('SELECT COUNT(*) AS cnt FROM users');
    if (parseInt(rows[0].cnt, 10) > 0) {
      console.log('Users table already has data — skipping seed.');
      return;
    }

    console.log('Seeding demo users…');
    for (const u of DEMO_USERS) {
      const hash = await bcrypt.hash(u.password, 10);
      await client.query(
        'INSERT INTO users (id, email, password_hash, role, name) VALUES ($1, $2, $3, $4, $5)',
        [randomUUID(), u.email, hash, u.role, u.name]
      );
      console.log(`  ✓ ${u.role.padEnd(8)}  email: ${u.email}  password: ${u.password}`);
    }
    console.log('Seed complete.');
  } catch (err) {
    console.error('Seed failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
