import * as WebAuthn from '@simplewebauthn/server';
import { migrateLicensing } from '../db/migrate.mjs';
import { ApiError, check, hash, matches, secret, transaction, uuid, validateAuthorization } from './common.mjs';

export function createAuth({ db, config, now = () => Date.now(), webauthn = WebAuthn }) {
  migrateLicensing(db);
  const audit = (action, account, resource) => db.prepare('INSERT INTO auth_audit(action,account_id,resource_id,created_at) VALUES(?,?,?,?)').run(action, account || null, resource || null, now());
  const activeAccount = account => check(db.prepare("SELECT 1 FROM auth_accounts WHERE id=? AND status='active'").get(account), 401, 'invalid_session');
  const claim = token => {
    check(typeof token === 'string' && token.length <= 100, 400, 'invalid_claim');
    const row = db.prepare('SELECT * FROM auth_claims WHERE token_hash=?').get(hash(token));
    check(row && !row.used_at && row.expires_at > now(), 400, 'invalid_claim');
    check(!db.prepare('SELECT 1 FROM auth_stripe_links WHERE customer_id=? AND stripe_mode=?').get(row.customer_id,row.stripe_mode),409,'customer_already_linked');
    return row;
  };
  function issueClaim(customerId, reference) {
    check(/^cus_[A-Za-z0-9]+$/.test(customerId) && typeof reference === 'string' && reference.length >= 3 && reference.length <= 200);
    check(!db.prepare('SELECT 1 FROM auth_stripe_links WHERE customer_id=?').get(customerId),409,'customer_already_linked');
    const token = secret();
    db.prepare('INSERT INTO auth_claims VALUES(?,?,?, ?,NULL,?)').run(hash(token),customerId,'test',now()+30*60_000,reference);
    audit('claim_issued',null,customerId);
    return token;
  }
  function linkClaim(account, token) {
    activeAccount(account);
    return transaction(db, () => {
      const row = claim(token);
      db.prepare('INSERT INTO auth_stripe_links VALUES(?,?,?,?)').run(row.customer_id,row.stripe_mode,account,now());
      db.prepare('UPDATE auth_claims SET used_at=? WHERE token_hash=?').run(now(),row.token_hash);
      audit('customer_linked',account,row.customer_id);
    });
  }
  function challenge(kind, value, data) {
    const token = secret();
    db.prepare('INSERT INTO auth_challenges VALUES(?,?,?,?,?,NULL)').run(hash(token),kind,value,JSON.stringify(data),now()+5*60_000);
    return token;
  }
  function takeChallenge(token, kind) {
    check(typeof token === 'string' && token.length <= 100);
    return transaction(db, () => {
      const row = db.prepare('SELECT * FROM auth_challenges WHERE token_hash=?').get(hash(token));
      check(row && row.kind === kind && !row.used_at && row.expires_at > now(),400,'invalid_challenge');
      db.prepare('UPDATE auth_challenges SET used_at=? WHERE token_hash=?').run(now(),row.token_hash);
      return { ...row, data:JSON.parse(row.data) };
    });
  }
  function newSession(account, kind, details = {}) {
    activeAccount(account);
    const sid = uuid(), browserToken = kind === 'browser' ? secret() : null;
    const ttl = kind === 'browser' ? config.browserTtlMs : config.sessionTtlMs;
    db.prepare('INSERT INTO auth_sessions VALUES(?,?,?,?,?,?,NULL,?,?,NULL)').run(sid,account,kind,details.installation_id || null,details.device_name || 'Navegador',browserToken ? hash(browserToken) : null,now(),now()+ttl);
    audit('session_created',account,sid);
    return { session: db.prepare('SELECT * FROM auth_sessions WHERE id=?').get(sid), browserToken };
  }
  function tokens(session) {
    const access = secret(), refresh = secret();
    const accessExpires = Math.min(now()+config.accessTtlMs,session.expires_at);
    db.prepare('INSERT INTO auth_access_tokens VALUES(?,?,?)').run(hash(access),session.id,accessExpires);
    db.prepare('INSERT INTO auth_refresh_tokens VALUES(?,?,?,NULL)').run(hash(refresh),session.id,session.expires_at);
    return { access_token:access, refresh_token:refresh, token_type:'Bearer', account_id:session.account_id, session_id:session.id, installation_id:session.installation_id, expires_in:Math.max(0,Math.floor((accessExpires-now())/1000)), session_expires_at:new Date(session.expires_at).toISOString() };
  }
  function validSession(session) {
    check(session && !session.revoked_at && session.expires_at > now(),401,'invalid_session');
    activeAccount(session.account_id);
    return session;
  }
  function browserSession(raw) {
    check(typeof raw === 'string' && /^[A-Za-z0-9_-]{43}$/.test(raw),401,'invalid_session');
    return validSession(db.prepare("SELECT * FROM auth_sessions WHERE browser_hash=? AND kind='browser'").get(hash(raw)));
  }
  function accessSession(raw) {
    check(typeof raw === 'string' && /^[A-Za-z0-9_-]{43}$/.test(raw),401,'invalid_session');
    const row = db.prepare('SELECT session_id,expires_at FROM auth_access_tokens WHERE token_hash=?').get(hash(raw));
    check(row && row.expires_at > now(),401,'invalid_session');
    return validSession(db.prepare("SELECT * FROM auth_sessions WHERE id=? AND kind='desktop'").get(row.session_id));
  }
  function requireRecent(session) {
    const current=validSession(db.prepare('SELECT * FROM auth_sessions WHERE id=?').get(session.id));
    check(current.kind==='browser' && now()-current.created_at<=5*60_000,403,'reauth_required');
  }
  const csrf = session => {
    const value = secret();
    db.prepare('UPDATE auth_sessions SET csrf_hash=? WHERE id=?').run(hash(value),session.id);
    return value;
  };
  const verifyCsrf = (session, value) => check(matches(value,db.prepare('SELECT csrf_hash FROM auth_sessions WHERE id=?').get(session.id)?.csrf_hash),403,'invalid_csrf');
  async function registrationOptions(input, session = null) {
    if (session) requireRecent(session); else claim(input.claimToken);
    const accountId = session?.account_id || uuid();
    const displayName = session ? db.prepare('SELECT display_name FROM auth_accounts WHERE id=?').get(accountId).display_name : String(input.displayName || '').trim().slice(0,80);
    check(displayName.length > 0 && !/[\x00-\x1f]/.test(displayName));
    const credentials = db.prepare('SELECT id,transports FROM auth_credentials WHERE account_id=?').all(accountId);
    const options = await webauthn.generateRegistrationOptions({
      rpName:'OmniPVD',rpID:config.rpId,userID:Buffer.from(accountId),userName:`OmniPVD ${accountId.slice(0,8)}`,userDisplayName:displayName,
      attestationType:'none',supportedAlgorithmIDs:[-7,-257],authenticatorSelection:{residentKey:'required',userVerification:'required'},
      excludeCredentials:credentials.map(c=>({id:c.id,transports:JSON.parse(c.transports)})),
    });
    const flowToken = challenge('register',options.challenge,{accountId,displayName,claimTokenHash:session ? null : hash(input.claimToken),existingAccount:!!session,sessionId:session?.id || null});
    return { options, flowToken };
  }
  async function registrationVerify(input, session = null) {
    const flow = takeChallenge(input.flowToken,'register');
    if (flow.data.existingAccount) { check(session && session.id === flow.data.sessionId && session.account_id === flow.data.accountId,401,'invalid_session'); requireRecent(session); }
    else check(matches(input.claimToken,flow.data.claimTokenHash),400,'invalid_claim');
    let result;
    try { result = await webauthn.verifyRegistrationResponse({response:input.response,expectedChallenge:flow.challenge,expectedOrigin:config.origin,expectedRPID:config.rpId,requireUserVerification:true}); }
    catch { throw new ApiError(400,'passkey_verification_failed'); }
    check(result.verified && result.registrationInfo,400,'passkey_verification_failed');
    const credential = result.registrationInfo.credential;
    return transaction(db, () => {
      if (!flow.data.existingAccount) {
        const row = claim(input.claimToken);
        db.prepare('INSERT INTO auth_accounts VALUES(?,?,?,?)').run(flow.data.accountId,flow.data.displayName,'active',now());
        db.prepare('INSERT INTO auth_stripe_links VALUES(?,?,?,?)').run(row.customer_id,row.stripe_mode,flow.data.accountId,now());
        db.prepare('UPDATE auth_claims SET used_at=? WHERE token_hash=?').run(now(),row.token_hash);
        audit('customer_linked',flow.data.accountId,row.customer_id);
      } else validSession(db.prepare('SELECT * FROM auth_sessions WHERE id=?').get(session.id));
      db.prepare('INSERT INTO auth_credentials VALUES(?,?,?,?,?,?)').run(credential.id,flow.data.accountId,Buffer.from(credential.publicKey),credential.counter,JSON.stringify(credential.transports || []),now());
      audit('passkey_registered',flow.data.accountId,credential.id);
      return newSession(flow.data.accountId,'browser');
    });
  }
  async function loginOptions() {
    const options = await webauthn.generateAuthenticationOptions({rpID:config.rpId,userVerification:'required'});
    return { options,flowToken:challenge('login',options.challenge,{}) };
  }
  async function loginVerify(input) {
    const flow = takeChallenge(input.flowToken,'login');
    const credential = db.prepare('SELECT * FROM auth_credentials WHERE id=?').get(input.response?.id || '');
    check(credential,400,'passkey_verification_failed');
    activeAccount(credential.account_id);
    const userHandle = input.response?.response?.userHandle;
    check(userHandle === Buffer.from(credential.account_id).toString('base64url'),400,'passkey_verification_failed');
    let result;
    try { result = await webauthn.verifyAuthenticationResponse({response:input.response,expectedChallenge:flow.challenge,expectedOrigin:config.origin,expectedRPID:config.rpId,requireUserVerification:true,
      credential:{id:credential.id,publicKey:new Uint8Array(credential.public_key),counter:credential.counter,transports:JSON.parse(credential.transports)}}); }
    catch { throw new ApiError(400,'passkey_verification_failed'); }
    check(result.verified,400,'passkey_verification_failed');
    return transaction(db, () => {
      const current = db.prepare('SELECT counter FROM auth_credentials WHERE id=?').get(credential.id);
      check(current && current.counter === credential.counter,400,'passkey_verification_failed');
      db.prepare('UPDATE auth_credentials SET counter=? WHERE id=?').run(result.authenticationInfo.newCounter,credential.id);
      return newSession(credential.account_id,'browser');
    });
  }
  function authorize(session, input) {
    validSession(db.prepare('SELECT * FROM auth_sessions WHERE id=?').get(session.id));
    const params = validateAuthorization(input);
    const code = secret();
    db.prepare('INSERT INTO auth_codes VALUES(?,?,?,?,?,?,?,?,NULL)').run(hash(code),session.account_id,params.client_id,params.redirect_uri,params.code_challenge,params.installation_id,params.device_name,now()+60_000);
    // State is only echoed to the exact validated loopback URI.
    const redirect = new URL(params.redirect_uri);redirect.searchParams.set('code',code);redirect.searchParams.set('state',params.state);
    audit('desktop_authorized',session.account_id,null);
    return { redirect_uri:redirect.href };
  }
  function exchange(input) {
    check(input.client_id === 'omnipvd-desktop');
    if (input.grant_type === 'authorization_code') {
      check(typeof input.code === 'string' && input.code.length <= 100 && typeof input.code_verifier === 'string' && /^[A-Za-z0-9._~-]{43,128}$/.test(input.code_verifier));
      return transaction(db, () => {
        const row = db.prepare('SELECT * FROM auth_codes WHERE token_hash=?').get(hash(input.code));
        check(row && !row.used_at && row.expires_at > now() && row.client_id === input.client_id && row.redirect_uri === input.redirect_uri && matches(input.code_verifier,row.code_challenge),400,'invalid_grant');
        db.prepare('UPDATE auth_codes SET used_at=? WHERE token_hash=?').run(now(),row.token_hash);
        return tokens(newSession(row.account_id,'desktop',row).session);
      });
    }
    check(input.grant_type === 'refresh_token' && typeof input.refresh_token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(input.refresh_token),400,'invalid_grant');
    // Commit replay revocation even when the request ultimately fails.
    const result = transaction(db, () => {
      const row = db.prepare('SELECT * FROM auth_refresh_tokens WHERE token_hash=?').get(hash(input.refresh_token));
      if (!row || row.expires_at <= now()) return null;
      const session = db.prepare('SELECT * FROM auth_sessions WHERE id=?').get(row.session_id);
      if (row.used_at) {
        db.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(now(),row.session_id);
        audit('refresh_reuse',session?.account_id,row.session_id); return null;
      }
      validSession(session);
      db.prepare('UPDATE auth_refresh_tokens SET used_at=? WHERE token_hash=?').run(now(),row.token_hash);
      return tokens(session);
    });
    check(result,400,'invalid_grant');return result;
  }
  function revoke(session, sid = session.id) {
    const result = db.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=? AND account_id=?').run(now(),sid,session.account_id);
    check(result.changes,404,'session_not_found');audit('session_revoked',session.account_id,sid);
  }
  function sessions(session) {
    return db.prepare('SELECT id,kind,device_name,created_at,expires_at,revoked_at FROM auth_sessions WHERE account_id=? ORDER BY created_at DESC').all(session.account_id);
  }
  return {issueClaim,linkClaim,registrationOptions,registrationVerify,loginOptions,loginVerify,browserSession,accessSession,csrf,verifyCsrf,requireRecent,authorize,exchange,revoke,sessions};
}
