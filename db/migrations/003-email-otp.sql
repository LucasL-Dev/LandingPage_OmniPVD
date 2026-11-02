-- Additive: legacy accounts are never opted into email authentication implicitly.
CREATE TABLE auth_email_identities (
  email_key TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES auth_accounts(id),
  customer_id TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE auth_email_challenges (
  id TEXT PRIMARY KEY, request_hash TEXT UNIQUE NOT NULL, binding_hash TEXT NOT NULL,
  email_key TEXT NOT NULL, customer_id TEXT, account_id TEXT, enrollment_session TEXT,
  code_hmac TEXT NOT NULL, expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, used_at INTEGER
);
