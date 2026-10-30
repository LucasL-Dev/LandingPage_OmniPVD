CREATE TABLE auth_accounts (
  id TEXT PRIMARY KEY, display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL
);
CREATE TABLE auth_stripe_links (
  customer_id TEXT NOT NULL, stripe_mode TEXT NOT NULL CHECK(stripe_mode='test'),
  account_id TEXT NOT NULL REFERENCES auth_accounts(id), verified_at INTEGER NOT NULL,
  PRIMARY KEY(customer_id,stripe_mode)
);
CREATE TABLE auth_claims (
  token_hash TEXT PRIMARY KEY, customer_id TEXT NOT NULL, stripe_mode TEXT NOT NULL,
  expires_at INTEGER NOT NULL, used_at INTEGER, verification_reference TEXT NOT NULL
);
CREATE TABLE auth_credentials (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES auth_accounts(id),
  public_key BLOB NOT NULL, counter INTEGER NOT NULL, transports TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE auth_challenges (
  token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, challenge TEXT NOT NULL,
  data TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER
);
CREATE TABLE auth_sessions (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES auth_accounts(id),
  kind TEXT NOT NULL, installation_id TEXT, device_name TEXT NOT NULL,
  browser_hash TEXT UNIQUE, csrf_hash TEXT, created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, revoked_at INTEGER
);
CREATE TABLE auth_access_tokens (
  token_hash TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES auth_sessions(id), expires_at INTEGER NOT NULL
);
CREATE TABLE auth_refresh_tokens (
  token_hash TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES auth_sessions(id),
  expires_at INTEGER NOT NULL, used_at INTEGER
);
CREATE TABLE auth_codes (
  token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES auth_accounts(id),
  client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, code_challenge TEXT NOT NULL,
  installation_id TEXT NOT NULL, device_name TEXT NOT NULL,
  expires_at INTEGER NOT NULL, used_at INTEGER
);
CREATE TABLE license_entitlements (
  subscription_id TEXT PRIMARY KEY, customer_id TEXT NOT NULL,
  stripe_status TEXT NOT NULL, initial_invoice_id TEXT, paid_until INTEGER,
  authorized INTEGER NOT NULL, verified_at INTEGER NOT NULL
);
CREATE TABLE auth_rate_limits (
  bucket TEXT PRIMARY KEY, window_start INTEGER NOT NULL, hits INTEGER NOT NULL
);
CREATE TABLE auth_audit (
  id INTEGER PRIMARY KEY, action TEXT NOT NULL, account_id TEXT, resource_id TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX auth_sessions_account ON auth_sessions(account_id);
CREATE INDEX auth_access_expiration ON auth_access_tokens(expires_at);
CREATE INDEX auth_links_account ON auth_stripe_links(account_id);
