import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
export const secret = () => randomBytes(32).toString('base64url');
export const hash = value => createHash('sha256').update(value).digest('base64url');
export const uuid = randomUUID;
export class ApiError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
export const check = (condition, status = 400, code = 'invalid_request') => { if (!condition) throw new ApiError(status, code); };
export const matches = (raw, expectedHash) => {
  if (typeof raw !== 'string' || typeof expectedHash !== 'string') return false;
  const actual = Buffer.from(hash(raw)), expected = Buffer.from(expectedHash);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function rateLimit(db, bucket, limit, now, windowMs = 60_000) {
  transaction(db, () => {
    db.prepare(`INSERT INTO auth_rate_limits VALUES(?,?,1) ON CONFLICT(bucket) DO UPDATE SET
      window_start=CASE WHEN window_start<=? THEN excluded.window_start ELSE window_start END,
      hits=CASE WHEN window_start<=? THEN 1 ELSE hits+1 END`).run(bucket, now, now-windowMs, now-windowMs);
  });
  check(db.prepare('SELECT hits FROM auth_rate_limits WHERE bucket=?').get(bucket).hits <= limit, 429, 'rate_limited');
}
export function validateAuthorization(input) {
  check(input.client_id === 'omnipvd-desktop' && input.response_type === 'code' && input.code_challenge_method === 'S256');
  check(typeof input.code_challenge === 'string' && /^[A-Za-z0-9_-]{43}$/.test(input.code_challenge));
  check(typeof input.state === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(input.state));
  check(typeof input.installation_id === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(input.installation_id));
  let uri; try { uri = new URL(input.redirect_uri); } catch { throw new ApiError(400,'invalid_redirect'); }
  check(uri.protocol === 'http:' && uri.hostname === '127.0.0.1' && uri.port && Number(uri.port) >= 1024 && uri.pathname === '/omnipvd/callback' && !uri.search && !uri.hash && !uri.username && !uri.password, 400, 'invalid_redirect');
  return { ...input, device_name: typeof input.device_name === 'string' ? input.device_name.slice(0,80) : 'OmniPVD Windows' };
}
