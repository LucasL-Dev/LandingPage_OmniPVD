-- Additive only. Automatic invitations are intentionally NOT auth_claims:
-- older releases must fail closed instead of accepting them as administrative proof.
CREATE TABLE onboarding_purchases (
  customer_id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL, invoice_id TEXT NOT NULL,
  email_key TEXT NOT NULL, recipient_cipher TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX onboarding_purchase_email ON onboarding_purchases(email_key);
CREATE TABLE onboarding_invites (
  token_hash TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES onboarding_purchases(customer_id),
  expires_at INTEGER NOT NULL, used_at INTEGER, active INTEGER NOT NULL,
  secret_cipher TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX onboarding_invite_active ON onboarding_invites(customer_id) WHERE active=1;
CREATE TABLE onboarding_verifications (
  token_hash TEXT PRIMARY KEY, purpose TEXT NOT NULL, customer_id TEXT,
  invite_hash TEXT, email_key TEXT NOT NULL, code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, used_at INTEGER
);
CREATE TABLE onboarding_proofs (
  token_hash TEXT PRIMARY KEY, invite_hash TEXT NOT NULL REFERENCES onboarding_invites(token_hash),
  expires_at INTEGER NOT NULL, used_at INTEGER
);
CREATE TABLE onboarding_verified_emails (
  email_key TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES auth_accounts(id)
);
CREATE TABLE onboarding_outbox (
  id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES onboarding_purchases(customer_id),
  purpose TEXT NOT NULL, subject_hash TEXT NOT NULL, payload_cipher TEXT NOT NULL,
  expires_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL DEFAULT 0, first_at INTEGER, lease_until INTEGER NOT NULL DEFAULT 0,
  resend_id TEXT, last_error TEXT
);

CREATE TABLE onboarding_settings (name TEXT PRIMARY KEY, value TEXT NOT NULL);
