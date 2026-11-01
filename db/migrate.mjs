import { readFileSync } from 'node:fs';

// Separate version ledger: no DROP, reset, or alteration of billing tables.
export function migrateLicensing(db) {
  db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
  try {
    db.exec('CREATE TABLE IF NOT EXISTS auth_schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
    for (const [version, filename] of [[1,'001-licensing.sql'],[2,'002-automatic-onboarding.sql']]) {
      if (!db.prepare('SELECT 1 FROM auth_schema_migrations WHERE version=?').get(version)) {
        db.exec(readFileSync(new URL(`./migrations/${filename}`, import.meta.url), 'utf8'));
        db.prepare('INSERT INTO auth_schema_migrations VALUES(?,?)').run(version,Date.now());
      }
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
