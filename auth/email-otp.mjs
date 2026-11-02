import { randomInt } from 'node:crypto';
import { check, hash, matches, secret, transaction, rateLimit, uuid } from './common.mjs';

// Email is a delivery address, never an account identifier supplied by the caller.
export function createEmailOtp({db,auth,onboarding,now=()=>Date.now()}) {
  const {rememberLinkedPurchase,emailKey,digest,purchase,validatePurchase,available,queueMail,mail}=onboarding.otpSupport;
  const identity=key=>db.prepare('SELECT * FROM auth_email_identities WHERE email_key=?').get(key);
  const link=customer=>db.prepare("SELECT account_id FROM auth_stripe_links WHERE customer_id=? AND stripe_mode='test'").get(customer);
  const enabledAccount=account=>db.prepare("SELECT 1 FROM auth_accounts WHERE id=? AND status='active'").get(account);
  function record(action,account,resource) { db.prepare('INSERT INTO auth_audit(action,account_id,resource_id,created_at) VALUES(?,?,?,?)').run(action,account,resource,now()); }
  function candidate(key,session) {
    const registered=identity(key);
    if(registered) {
      if(session && registered.account_id!==session.account_id)return null;
      if(!enabledAccount(registered.account_id) || link(registered.customer_id)?.account_id!==registered.account_id)return null;
      return {row:purchase(registered.customer_id),account:registered.account_id};
    }
    const rows=db.prepare('SELECT * FROM onboarding_purchases WHERE email_key=? LIMIT 101').all(key);
    if(rows.length>100)return null;
    const owner=db.prepare('SELECT account_id FROM onboarding_verified_emails WHERE email_key=?').get(key);
    if(owner && owner.account_id!==session?.account_id)return null;
    // A legacy linked purchase at this address is never bypassed by creating a second account.
    if(rows.some(row=>link(row.customer_id) && link(row.customer_id).account_id!==session?.account_id))return null;
    const eligible=rows.filter(row=>session?link(row.customer_id)?.account_id===session.account_id:!link(row.customer_id));
    // No arbitrary choice among customers; explicit support required for ambiguity.
    if(eligible.length!==1)return null;
    if(!session && db.prepare('SELECT 1 FROM onboarding_verified_emails WHERE email_key=?').get(key))return null;
    return {row:eligible[0],account:session?.account_id||null};
  }
  function checkBinding(input,binding) {
    check(typeof binding==='string' && /^[A-Za-z0-9_-]{43}$/.test(binding),400,'invalid_verification');
    check(typeof input.requestId==='string' && /^[A-Za-z0-9_-]{43}$/.test(input.requestId),400,'invalid_verification');
  }
  async function start(input,binding,session=null) {
    await available();
    check(typeof input.email==='string' && input.email.length<=254 && /^[^\s<>"@]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(input.email),400,'invalid_request');
    check(typeof binding==='string' && /^[A-Za-z0-9_-]{43}$/.test(binding) && typeof input.requestKey==='string' && /^[A-Za-z0-9_-]{43}$/.test(input.requestKey),400,'invalid_request');
    if(session)auth.requireRecent(session);
    const key=emailKey(input.email),requestHash=digest('otp-request:'+input.requestKey),bindingHash=hash(binding);
    const existing=db.prepare('SELECT * FROM auth_email_challenges WHERE request_hash=?').get(requestHash);
    if(existing) {
      check(existing.binding_hash===bindingHash && existing.email_key===key && existing.enrollment_session===(session?.id||null),400,'invalid_request');
      return {ok:true,requestId:existing.id};
    }
    rateLimit(db,'email-otp-recipient:'+key,3,now(),3600_000);
    if(session && !candidate(key,session))await rememberLinkedPurchase(session.account_id,key);
    const found=candidate(key,session),requestId=secret(),code=String(randomInt(0,1_000_000)).padStart(6,'0');
    return transaction(db,()=>{
      if(session)auth.requireRecent(session);
      const duplicate=db.prepare('SELECT * FROM auth_email_challenges WHERE request_hash=?').get(requestHash);
      if(duplicate) {
        check(duplicate.binding_hash===bindingHash && duplicate.email_key===key && duplicate.enrollment_session===(session?.id||null),400,'invalid_request');
        return {ok:true,requestId:duplicate.id};
      }
      // Recheck candidate synchronously under SQLite write lock.
      const current=candidate(key,session);
      const target=found && current?.row?.customer_id===found.row?.customer_id && current.account===found.account?current:null;
      db.prepare('INSERT INTO auth_email_challenges(id,request_hash,binding_hash,email_key,customer_id,account_id,enrollment_session,code_hmac,expires_at) VALUES(?,?,?,?,?,?,?,?,?)').run(requestId,requestHash,bindingHash,key,target?.row?.customer_id||null,target?.account||null,session?.id||null,digest('otp-code:'+requestId+':'+code),now()+600_000);
      if(target?.row)queueMail(target.row.customer_id,'login',requestId,mail(target.row,'OmniPDV — código de acesso',`Seu código de acesso ao OmniPDV é: ${code}\n\nVálido por 10 minutos, para uma única utilização. Não compartilhe. Só informe na página oficial se você iniciou o acesso. Se não solicitou, ignore esta mensagem.`),now()+600_000);
      return {ok:true,requestId};
    });
  }
  async function verify(input,binding,session=null) {
    await available();checkBinding(input,binding);
    check(typeof input.code==='string' && /^\d{6}$/.test(input.code),400,'invalid_verification');
    if(session)auth.requireRecent(session);
    const challenge=transaction(db,()=>{
      const row=db.prepare('SELECT * FROM auth_email_challenges WHERE id=?').get(input.requestId);
      if(!row || row.used_at || row.expires_at<=now() || row.attempts>=5 || row.binding_hash!==hash(binding) || row.enrollment_session!==(session?.id||null))return null;
      const valid=matches(digest('otp-code:'+row.id+':'+input.code),hash(row.code_hmac));
      db.prepare('UPDATE auth_email_challenges SET attempts=attempts+1,used_at=? WHERE id=?').run(valid||row.attempts+1>=5?now():null,row.id);
      return valid && row.customer_id?row:null;
    });
    check(challenge,400,'invalid_verification');
    const row=purchase(challenge.customer_id);
    check(row && row.email_key===challenge.email_key,400,'invalid_verification');
    await validatePurchase(row); // Fail closed on Stripe errors, pending or mismatched payment.
    return transaction(db,()=>{
      if(session)auth.requireRecent(session);
      const current=candidate(challenge.email_key,session);
      check(current?.row?.customer_id===challenge.customer_id && current.account===challenge.account_id,400,'invalid_verification');
      let account=challenge.account_id;
      if(!account) {
        // The customer's unique link and email identity are checked again under lock.
        check(!link(row.customer_id) && !identity(row.email_key),400,'invalid_verification');
        account=uuid();db.prepare('INSERT INTO auth_accounts VALUES(?,?,?,?)').run(account,'Cliente OmniPDV','active',now());
        db.prepare('INSERT INTO auth_stripe_links VALUES(?,?,?,?)').run(row.customer_id,'test',account,now());
        db.prepare('INSERT OR IGNORE INTO onboarding_verified_emails VALUES(?,?)').run(row.email_key,account);
        db.prepare('UPDATE onboarding_invites SET active=0,used_at=COALESCE(used_at,?) WHERE customer_id=?').run(now(),row.customer_id);
        record('email_otp_customer_claimed',account,row.customer_id);
      }
      check(enabledAccount(account) && link(row.customer_id)?.account_id===account,400,'invalid_verification');
      const old=identity(row.email_key);check(!old || old.account_id===account,400,'invalid_verification');
      if(!old) {
        db.prepare('INSERT INTO auth_email_identities VALUES(?,?,?,?)').run(row.email_key,account,row.customer_id,now());
        record('email_otp_enabled',account,row.customer_id);
      }
      // Use the same browser cookie, CSRF, PKCE, desktop token rotation and revocation.
      return auth.createEmailSession(account);
    });
  }
  return {start,verify};
}
