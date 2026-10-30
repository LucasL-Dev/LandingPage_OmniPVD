import { readFileSync } from 'node:fs';

// Separate version ledger: no DROP, reset, or alteration of billing tables.
export function migrateLicensing(db) {
  db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
  try {
    db.exec('CREATE TABLE IF NOT EXISTS auth_schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
    if (!db.prepare('SELECT 1 FROM auth_schema_migrations WHERE version=1').get()) {
      db.exec(readFileSync(new URL('./migrations/001-licensing.sql', import.meta.url), 'utf8'));
      db.prepare('INSERT INTO auth_schema_migrations VALUES(1,?)').run(Date.now());
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
