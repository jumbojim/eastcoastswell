import pg from 'pg';
import { config } from './config.js';

const { Pool } = pg;

// Supabase's pooled connection requires SSL; rejectUnauthorized:false is the
// standard setting for Supabase's managed cert chain (same as their own docs).
export const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseUrl?.includes('supabase.co') ? { rejectUnauthorized: false } : undefined,
  max: 5,
});

export async function query(text, params) {
  return pool.query(text, params);
}

export async function withClient(fn) {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}
