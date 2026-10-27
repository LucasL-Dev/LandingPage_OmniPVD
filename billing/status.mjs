import { DatabaseSync } from 'node:sqlite';
import { loadEnvFile } from 'node:process';
try { loadEnvFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (!process.env.BILLING_DB_PATH) throw new Error('Configure BILLING_DB_PATH.');
const db = new DatabaseSync(process.env.BILLING_DB_PATH, { readOnly: true });
try {
  console.table(db.prepare('SELECT status,count(*) AS total FROM deliveries GROUP BY status').all());
  console.table(db.prepare('SELECT subscription_id,status,attempts,next_at,last_error FROM deliveries ORDER BY next_at LIMIT 100').all());
} finally { db.close(); }
