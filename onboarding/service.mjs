import { createCipheriv,createDecipheriv,createHmac,randomBytes,randomInt } from 'node:crypto';
import { check,hash,matches,secret,transaction,rateLimit,uuid } from '../auth/common.mjs';

const id=value=>typeof value==='string'?value:value?.id;
const sid=invoice=>id(invoice.parent?.subscription_details?.subscription || invoice.subscription);
const emailValid=value=>typeof value==='string' && value.length<=254 && /^[^\s<>"@]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(value);
const INVITE_TTL=48*3600_000,PROOF_TTL=10*60_000;
export function createOnboarding({db,stripe,delivery,config,key,now=()=>Date.now()}) {
  check(Buffer.isBuffer(key) && key.length===32,500,'invalid_outbox_key');
  const origin=new URL(config.origin);
  check(origin.protocol==='https:' && origin.origin===config.origin,500,'onboarding_https_required');
  const fingerprint=hash(key);
  transaction(db,()=>{
    const stored=db.prepare("SELECT value FROM onboarding_settings WHERE name='outbox_key_fingerprint'").get();
    check(!stored || stored.value===fingerprint,500,'outbox_key_changed');
    db.prepare("INSERT OR IGNORE INTO onboarding_settings VALUES('outbox_key_fingerprint',?)").run(fingerprint);
  });
  const audit=(action,resource)=>db.prepare('INSERT INTO auth_audit(action,account_id,resource_id,created_at) VALUES(?,NULL,?,?)').run(action,resource,now());
  const digest=value=>createHmac('sha256',key).update(value).digest('base64url');
  const emailKey=value=>digest('email:'+value.trim().toLowerCase());
  function seal(value,purpose) {
    const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(purpose));
    const bytes=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
    return ['onboarding1',iv.toString('base64url'),cipher.getAuthTag().toString('base64url'),bytes.toString('base64url')].join('.');
  }
  function open(value,purpose) {
    const [version,iv,tag,bytes,...rest]=value.split('.');check(version==='onboarding1' && !rest.length,500,'invalid_outbox_payload');
    const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(iv,'base64url'));decipher.setAAD(Buffer.from(purpose));decipher.setAuthTag(Buffer.from(tag,'base64url'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(bytes,'base64url')),decipher.final()]).toString('utf8'));
  }
  const linked=customer=>db.prepare("SELECT account_id FROM auth_stripe_links WHERE customer_id=? AND stripe_mode='test'").get(customer);
  const purchase=customer=>db.prepare('SELECT * FROM onboarding_purchases WHERE customer_id=?').get(customer);
  const recipient=row=>open(row.recipient_cipher,'recipient:'+row.customer_id);
  async function available() { check(await delivery.ready(),503,'onboarding_unavailable'); }
  async function validatePurchase(row) {
    check(row,400,'invalid_invite');
    const invoice=await stripe.invoices.retrieve(row.invoice_id);
    const sub=await stripe.subscriptions.retrieve(row.subscription_id);
    check(invoice?.livemode===false && sub?.livemode===false && invoice.status==='paid' && invoice.paid!==false && invoice.billing_reason==='subscription_create' && id(invoice.customer)===row.customer_id && sid(invoice)===row.subscription_id && id(sub.customer)===row.customer_id && sub.items?.data?.some(item=>item.price?.id===config.priceId) && emailValid(invoice.customer_email) && emailKey(invoice.customer_email)===row.email_key,400,'invalid_invite');
  }
  // Explicit legacy enrollment may import only an already-linked paid purchase.
  // No anonymous Stripe search, mutable customer contact or bulk historical backfill.
  async function rememberLinkedPurchase(accountId,lookup) {
    const jobs=db.prepare(`SELECT d.* FROM deliveries d JOIN auth_stripe_links l
      ON l.customer_id=d.customer_id AND l.stripe_mode='test' WHERE l.account_id=? LIMIT 101`).all(accountId);
    check(jobs.length<=100,503,'onboarding_unavailable');
    for(const job of jobs) {
      if(purchase(job.customer_id))continue;
      const invoice=await stripe.invoices.retrieve(job.invoice_id);
      if(!emailValid(invoice?.customer_email) || emailKey(invoice.customer_email)!==lookup)continue;
      const row={customer_id:job.customer_id,subscription_id:job.subscription_id,invoice_id:job.invoice_id,email_key:lookup};
      await validatePurchase(row);
      transaction(db,()=>{
        check(linked(job.customer_id)?.account_id===accountId,400,'invalid_verification');
        db.prepare('INSERT OR IGNORE INTO onboarding_purchases VALUES(?,?,?,?,?,?)').run(row.customer_id,row.subscription_id,row.invoice_id,lookup,seal(invoice.customer_email.trim(),'recipient:'+row.customer_id),now());
      });
    }
  }
  function invite(row) {
    check(!linked(row.customer_id),409,'customer_already_linked');
    const existing=db.prepare('SELECT * FROM onboarding_invites WHERE customer_id=? AND active=1').get(row.customer_id);
    if(existing && !existing.used_at && existing.expires_at>now())return open(existing.secret_cipher,'invite:'+existing.token_hash);
    db.prepare('UPDATE onboarding_invites SET active=0 WHERE customer_id=?').run(row.customer_id);
    const token=secret(),tokenHash=hash(token);
    db.prepare('INSERT INTO onboarding_invites VALUES(?,?,?,NULL,1,?,?)').run(tokenHash,row.customer_id,now()+INVITE_TTL,seal(token,'invite:'+tokenHash),now());
    audit('automatic_invite_issued',row.customer_id);
    return token;
  }
  function inviteUrl(token) { const url=new URL('/account/login',origin);url.hash=new URLSearchParams({invite:token}).toString();return url.href; }
  async function welcome(job,state,invoice) {
    check(invoice.livemode===false && state.sub.livemode===false && emailValid(invoice.customer_email),400,'buyer_email_unavailable');
    const address=invoice.customer_email.trim();
    if(linked(job.customer_id) && !config.emailOtp)return {to:address,activationUrl:new URL('/account/login',origin).href,activationMode:'login'};
    return transaction(db,()=>{
      const existing=purchase(job.customer_id);
      if(existing)check(existing.email_key===emailKey(address),409,'buyer_email_changed');
      else db.prepare('INSERT INTO onboarding_purchases VALUES(?,?,?,?,?,?)').run(job.customer_id,job.subscription_id,job.invoice_id,emailKey(address),seal(address,'recipient:'+job.customer_id),now());
      const row=purchase(job.customer_id);
      if(config.emailOtp) {
        const owner=linked(job.customer_id);
        const optedIn=owner && db.prepare('SELECT 1 FROM auth_email_identities WHERE account_id=? AND customer_id=?').get(owner.account_id,job.customer_id);
        return {to:recipient(row),activationUrl:new URL('/account/login',origin).href,activationMode:owner&&!optedIn?'login':'email-otp'};
      }
      const token=invite(row);
      return {to:recipient(row),activationUrl:inviteUrl(token),activationMode:'register'};
    });
  }
  function queueMail(customer,purpose,subjectHash,payload,expiresAt) {
    const mid=uuid();
    db.prepare('INSERT INTO onboarding_outbox(id,customer_id,purpose,subject_hash,payload_cipher,expires_at) VALUES(?,?,?,?,?,?)').run(mid,customer,purpose,subjectHash,seal(payload,'mail:'+mid),expiresAt);
  }
  function mail(row,subject,text) {
    // Codes are digits, URLs are backend-generated, and text is fixed, not caller HTML.
    return {from:config.from,to:recipient(row),replyTo:config.supportEmail,subject,text};
  }
  function newVerification(row,purpose,inviteHash,lookupKey) {
    const verificationId=secret(),vhash=hash(verificationId),code=String(randomInt(0,100_000_000)).padStart(8,'0');
    db.prepare('INSERT INTO onboarding_verifications VALUES(?,?,?,?,?,?,?,0,NULL)').run(vhash,purpose,row?.customer_id||null,inviteHash||null,lookupKey,digest('code:'+vhash+':'+code),now()+PROOF_TTL);
    if(row)queueMail(row.customer_id,'code',vhash,mail(row,'OmniPDV — código de verificação',`Seu código de verificação é: ${code}\n\nEle expira em 10 minutos e é válido somente para a solicitação iniciada na página oficial de ativação. Não compartilhe este código. Se você não solicitou, ignore esta mensagem.`),now()+PROOF_TTL);
    return {ok:true,verificationId};
  }
  function consumeCode(input,purpose) {
    check(typeof input.verificationId==='string' && input.verificationId.length<=100 && typeof input.code==='string' && /^\d{8}$/.test(input.code),400,'invalid_verification');
    const row=transaction(db,()=>{
      const v=db.prepare('SELECT * FROM onboarding_verifications WHERE token_hash=?').get(hash(input.verificationId));
      if(!v || v.purpose!==purpose || v.used_at || v.expires_at<=now() || v.attempts>=5)return null;
      const supplied=digest('code:'+v.token_hash+':'+input.code);
      const valid=matches(supplied,hash(v.code_hash));
      db.prepare('UPDATE onboarding_verifications SET attempts=attempts+1,used_at=? WHERE token_hash=?').run(valid||v.attempts+1>=5?now():null,v.token_hash);
      return valid && v.customer_id?v:null;
    });
    check(row,400,'invalid_verification');return row;
  }
  const pendingInvite=token=>{
    check(typeof token==='string' && /^[A-Za-z0-9_-]{43}$/.test(token),400,'invalid_invite');
    const row=db.prepare('SELECT * FROM onboarding_invites WHERE token_hash=?').get(hash(token));
    check(row && row.active && !row.used_at && row.expires_at>now() && !linked(row.customer_id),400,'invalid_invite');return row;
  };
  function proof(inviteHash) {
    const token=secret();db.prepare('INSERT INTO onboarding_proofs VALUES(?,?,?,NULL)').run(hash(token),inviteHash,now()+PROOF_TTL);return token;
  }
  async function start(input) {
    await available();const item=pendingInvite(input.claimToken),row=purchase(item.customer_id);
    rateLimit(db,'onboarding-mail:'+row.email_key,3,now(),3600_000);
    await validatePurchase(row);
    return transaction(db,()=>newVerification(row,'activate',item.token_hash,row.email_key));
  }
  async function verify(input) {
    await available();const item=pendingInvite(input.claimToken);
    // A code for a different invitation must not be consumed or promoted to proof.
    const candidate=db.prepare('SELECT * FROM onboarding_verifications WHERE token_hash=?').get(hash(String(input.verificationId||'')));
    check(candidate?.invite_hash===item.token_hash,400,'invalid_verification');
    const verified=consumeCode(input,'activate');await validatePurchase(purchase(verified.customer_id));
    return transaction(db,()=>{pendingInvite(input.claimToken);audit('buyer_email_verified',item.customer_id);return {ok:true,emailProof:proof(item.token_hash)};});
  }
  async function recoveryStart(input) {
    await available();check(emailValid(input.email),400,'invalid_email');
    const lookup=emailKey(input.email);rateLimit(db,'onboarding-recover:'+lookup,3,now(),3600_000);
    // No request to Stripe and no different public response for a nonexistent/linked address.
    const row=db.prepare(`SELECT p.* FROM onboarding_purchases p WHERE p.email_key=? AND NOT EXISTS
      (SELECT 1 FROM auth_stripe_links l WHERE l.customer_id=p.customer_id AND l.stripe_mode='test') ORDER BY p.created_at DESC LIMIT 1`).get(lookup);
    return transaction(db,()=>newVerification(row||null,'recover',null,lookup));
  }
  async function recoveryVerify(input) {
    await available();const v=consumeCode(input,'recover'),row=purchase(v.customer_id);await validatePurchase(row);
    const downloadUrl=await delivery.createDownload(row.customer_id,row.subscription_id);
    return transaction(db,()=>{
      check(!linked(row.customer_id),400,'invalid_verification');
      db.prepare('UPDATE onboarding_invites SET active=0 WHERE customer_id=?').run(row.customer_id);
      const claimToken=invite(row),emailProof=proof(hash(claimToken));
      queueMail(row.customer_id,'invite',hash(claimToken),mail(row,'OmniPDV — novo convite de ativação',`Após sua verificação de e-mail, este é seu novo convite de ativação:\n${inviteUrl(claimToken)}\n\nEle expira em 48 horas e não substitui a verificação de e-mail e passkey. Convites anteriores foram invalidados. Não compartilhe o acesso. ${downloadUrl?'Baixar instalador pelo acesso privado (48 horas):\n'+downloadUrl:'A licença precisa estar ativa para liberar novo acesso ao instalador.'}`),now()+INVITE_TTL);
      audit('automatic_invite_recovered',row.customer_id);return {ok:true,claimToken,emailProof};
    });
  }
  function claim(token,emailProof,accountId=null) {
    const item=pendingInvite(token);
    check(typeof emailProof==='string' && /^[A-Za-z0-9_-]{43}$/.test(emailProof),403,'email_verification_required');
    const verified=db.prepare('SELECT * FROM onboarding_proofs WHERE token_hash=?').get(hash(emailProof));
    check(verified && verified.invite_hash===item.token_hash && !verified.used_at && verified.expires_at>now(),403,'email_verification_required');
    const row=purchase(item.customer_id),owner=db.prepare('SELECT account_id FROM onboarding_verified_emails WHERE email_key=?').get(row.email_key);
    check(!owner || owner.account_id===accountId,409,'existing_account_login_required');
    return {token_hash:item.token_hash,customer_id:item.customer_id,stripe_mode:'test',expires_at:item.expires_at,used_at:item.used_at,automatic:true};
  }
  function consumeClaim(token,emailProof,accountId) {
    const item=claim(token,emailProof,accountId),row=purchase(item.customer_id);
    db.prepare('INSERT OR IGNORE INTO onboarding_verified_emails VALUES(?,?)').run(row.email_key,accountId);
    check(db.prepare('SELECT account_id FROM onboarding_verified_emails WHERE email_key=?').get(row.email_key).account_id===accountId,409,'existing_account_login_required');
    db.prepare('UPDATE onboarding_invites SET used_at=?,active=0 WHERE token_hash=?').run(now(),item.token_hash);
    db.prepare('UPDATE onboarding_proofs SET used_at=? WHERE token_hash=?').run(now(),hash(emailProof));
  }
  async function runQueue(shouldStop=()=>false) {
    const jobs=db.prepare("SELECT * FROM onboarding_outbox WHERE status IN ('pending','retry','sending') AND next_at<=? AND lease_until<=? AND (purpose<>'login' OR ?=1) LIMIT 20").all(now(),now(),config.emailOtp?1:0);
    for(const job of jobs) {
      if(shouldStop())break;
      if(job.purpose==='login' && !config.emailOtp)continue;
      if(job.expires_at<=now()){db.prepare("UPDATE onboarding_outbox SET status='expired' WHERE id=?").run(job.id);continue;}
      if(job.attempts>=8 || job.first_at && now()-job.first_at>=23*3600_000){db.prepare("UPDATE onboarding_outbox SET status='manual_review' WHERE id=?").run(job.id);continue;}
      if(!db.prepare("UPDATE onboarding_outbox SET lease_until=?,status='sending' WHERE id=? AND lease_until<=? AND status IN ('pending','retry','sending')").run(now()+5*60_000,job.id,now()).changes)continue;
      try {
        const row=purchase(job.customer_id);await validatePurchase(row);
        if(job.purpose!=='login' && linked(row.customer_id)){db.prepare("UPDATE onboarding_outbox SET status='obsolete',lease_until=0 WHERE id=?").run(job.id);continue;}
        if(job.purpose==='login') {
          const v=db.prepare('SELECT used_at,expires_at FROM auth_email_challenges WHERE id=?').get(job.subject_hash);
          if(!v || v.used_at || v.expires_at<=now()){db.prepare("UPDATE onboarding_outbox SET status='obsolete',lease_until=0 WHERE id=?").run(job.id);continue;}
        } else if(job.purpose==='code') {
          const v=db.prepare('SELECT used_at,expires_at FROM onboarding_verifications WHERE token_hash=?').get(job.subject_hash);
          if(!v || v.used_at || v.expires_at<=now()){db.prepare("UPDATE onboarding_outbox SET status='obsolete',lease_until=0 WHERE id=?").run(job.id);continue;}
        } else {
          const item=db.prepare('SELECT active,used_at FROM onboarding_invites WHERE token_hash=?').get(job.subject_hash);
          if(!item?.active || item.used_at){db.prepare("UPDATE onboarding_outbox SET status='obsolete',lease_until=0 WHERE id=?").run(job.id);continue;}
        }
        const payload=open(job.payload_cipher,'mail:'+job.id);
        db.prepare('UPDATE onboarding_outbox SET attempts=attempts+1,first_at=COALESCE(first_at,?) WHERE id=?').run(now(),job.id);
        const result=await delivery.send(payload,{idempotencyKey:'omnipdv-onboarding-'+job.id,signal:AbortSignal.timeout(30_000)});
        if(result.error || !result.data?.id)throw Error('send_not_confirmed');
        db.prepare("UPDATE onboarding_outbox SET status='sent',resend_id=?,last_error=NULL,lease_until=0 WHERE id=?").run(result.data.id,job.id);
      }catch{db.prepare("UPDATE onboarding_outbox SET status='retry',last_error='send_not_confirmed',next_at=?,lease_until=0 WHERE id=?").run(now()+Math.min(3600,30*2**job.attempts)*1000,job.id);}
    }
  }
  return {otpSupport:{rememberLinkedPurchase,emailKey,digest,purchase,recipient,validatePurchase,available,queueMail,mail},welcome,start,verify,recoveryStart,recoveryVerify,claim,consumeClaim,runQueue,sealWelcome:(payload,sid)=>seal(payload,'welcome:'+sid),openWelcome:(payload,sid)=>open(payload,'welcome:'+sid)};
}
