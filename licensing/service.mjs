import { SignJWT, exportJWK, jwtVerify } from 'jose';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { ApiError, check, uuid, transaction } from '../auth/common.mjs';

const id = value => typeof value === 'string' ? value : value?.id;
const invoiceSubscription = invoice => id(invoice.parent?.subscription_details?.subscription || invoice.subscription);
const linePrice = line => id(line.pricing?.price_details?.price || line.price);
const lineSubscription = line => id(line.parent?.subscription_item_details?.subscription || line.subscription);

export async function createLicensing({ db, stripe, config, privateKeyPem, now = () => Date.now() }) {
  const signingKey = createPrivateKey(privateKeyPem);
  check(signingKey.asymmetricKeyType === 'ed25519',500,'invalid_signing_key');
  const publicKey = createPublicKey(signingKey);
  const jwk = { ...await exportJWK(publicKey),kid:config.keyId,alg:'EdDSA',use:'sig' };
  async function invoiceLines(invoice) {
    if (!invoice.lines?.has_more) return invoice.lines?.data || [];
    const result=[];
    for await (const line of stripe.invoices.listLineItems(invoice.id,{limit:100})) {
      result.push(line); if (result.length > 10_000) throw new Error('invoice_limit');
    }
    return result;
  }
  async function initialInvoice(subscription, customerId) {
    const known = db.prepare('SELECT initial_invoice_id FROM license_entitlements WHERE subscription_id=? AND customer_id=?').get(subscription.id,customerId)?.initial_invoice_id;
    if (known) {
      const invoice = await stripe.invoices.retrieve(known);
      if (invoiceSubscription(invoice) === subscription.id && id(invoice.customer) === customerId && invoice.billing_reason === 'subscription_create' && invoice.status === 'paid' && invoice.paid !== false) return invoice;
      return null;
    }
    // Paginates historical invoices. A resource limit fails closed rather than silently missing data.
    let count=0;
    for await (const invoice of stripe.invoices.list({customer:customerId,subscription:subscription.id,status:'paid',limit:100})) {
      if (++count>10_000) throw new Error('invoice_limit');
      if (invoiceSubscription(invoice) === subscription.id && id(invoice.customer) === customerId && invoice.billing_reason === 'subscription_create' && invoice.status === 'paid' && invoice.paid !== false) return invoice;
    }
    return null;
  }
  async function assess(subscription, customerId) {
    check(id(subscription.customer) === customerId && subscription.livemode === false,503,'license_unavailable');
    const items=[];
    if (subscription.items?.has_more) {
      for await(const item of stripe.subscriptionItems.list({subscription:subscription.id,limit:100})) { items.push(item); if(items.length>10_000)throw new Error('item_limit'); }
    } else items.push(...(subscription.items?.data || []));
    const target = items.filter(item => item.price?.id === config.priceId);
    const initial = target.length ? await initialInvoice(subscription,customerId) : null;
    let paidUntil=0;
    if (initial && subscription.latest_invoice) {
      const invoice = typeof subscription.latest_invoice === 'string' ? await stripe.invoices.retrieve(subscription.latest_invoice) : subscription.latest_invoice;
      if (invoice.status === 'paid' && invoice.paid !== false && id(invoice.customer) === customerId && invoiceSubscription(invoice) === subscription.id) {
        const lines = await invoiceLines(invoice);
        // Only recurring lines of the licensed Price authorize this product; no unrelated proration.
        const ends=lines.filter(line=>linePrice(line)===config.priceId && lineSubscription(line)===subscription.id && !line.proration && !line.parent?.subscription_item_details?.proration && Number.isSafeInteger(line.period?.start) && line.period.start <= Math.floor(now()/1000) && Number.isSafeInteger(line.period?.end)).map(line=>line.period.end);
        paidUntil=Math.max(0,...ends);
      }
    }
    let status=subscription.status;
    if (!target.length) status='no_subscription';
    else if (!initial) status='initial_payment_unconfirmed';
    else if (status==='active' && !paidUntil) status='payment_unconfirmed';
    else if (status==='active' && paidUntil<=Math.floor(now()/1000)) status='expired';
    const authorized=subscription.status==='active' && !!initial && !!target.length && paidUntil>Math.floor(now()/1000);
    return {sid:subscription.id,customerId,status,initialId:initial?.id || null,paidUntil,authorized};
  }
  async function status(session) {
    check(session.kind==='desktop',403,'desktop_session_required');
    const links=db.prepare("SELECT customer_id FROM auth_stripe_links WHERE account_id=? AND stripe_mode='test'").all(session.account_id);
    const records=[];
    try {
      for (const link of links) {
        let count=0;
        for await (const subscription of stripe.subscriptions.list({customer:link.customer_id,status:'all',limit:100,expand:['data.latest_invoice']})) {
          if(++count>1000)throw new Error('subscription_limit');
          records.push(await assess(subscription,link.customer_id));
        }
      }
    } catch { throw new ApiError(503,'license_unavailable'); }
    // Signing is deliberately never based on a stale cached positive result.
    const chosen=records.filter(r=>r.authorized).sort((a,b)=>b.paidUntil-a.paidUntil)[0] || records.sort((a,b)=>b.paidUntil-a.paidUntil)[0];
    transaction(db,()=>{
      for(const row of records)db.prepare(`INSERT INTO license_entitlements VALUES(?,?,?,?,?,?,?) ON CONFLICT(subscription_id) DO UPDATE SET
        customer_id=excluded.customer_id,stripe_status=excluded.stripe_status,initial_invoice_id=excluded.initial_invoice_id,
        paid_until=excluded.paid_until,authorized=excluded.authorized,verified_at=excluded.verified_at`).run(row.sid,row.customerId,row.status,row.initialId,row.paidUntil||null,Number(row.authorized),now());
    });
    // Recheck session/account after awaiting Stripe: a concurrent revocation cannot mint another lease.
    const current=db.prepare("SELECT s.revoked_at,s.expires_at,a.status FROM auth_sessions s JOIN auth_accounts a ON a.id=s.account_id WHERE s.id=?").get(session.id);
    check(current && !current.revoked_at && current.expires_at>now() && current.status==='active',401,'invalid_session');
    let expiry=null,offline=null;
    if (chosen?.authorized) {
      expiry=Math.min(Math.floor(now()/1000)+config.offlineTtlSeconds,chosen.paidUntil,Math.floor(current.expires_at/1000));
      offline=await new SignJWT({sid:session.id,installation_id:session.installation_id,product:'omnipvd',authorized:true})
        .setProtectedHeader({alg:'EdDSA',kid:config.keyId,typ:'omnipvd-license+jwt'})
        .setIssuer(config.issuer).setAudience(config.audience).setSubject(session.account_id)
        .setJti(uuid()).setIssuedAt(Math.floor(now()/1000)).setNotBefore(Math.floor(now()/1000)).setExpirationTime(expiry).sign(signingKey);
    }
    const next=Math.min(now()+config.recheckSeconds*1000,expiry ? expiry*1000 : Infinity);
    return {authorized:!!chosen?.authorized,subscription_status:chosen?.status || 'no_subscription',authorization_expires_at:expiry ? new Date(expiry*1000).toISOString() : null,next_check_at:new Date(next).toISOString(),offline_authorization:offline};
  }
  return {status,jwks:{keys:[jwk]}};
}

// Reference verifier for the desktop protocol. Only a pinned/trusted public key is accepted.
export async function verifyOfflineLicense(token,{publicKey,issuer,audience,installationId,accountId,sessionId,now=new Date()}) {
  const result=await jwtVerify(token,publicKey,{issuer,audience,algorithms:['EdDSA'],typ:'omnipvd-license+jwt',currentDate:now,requiredClaims:['sub','sid','installation_id','iat','nbf','exp','jti']});
  check(result.payload.authorized===true && result.payload.product==='omnipvd' && result.payload.installation_id===installationId && result.payload.sub===accountId && result.payload.sid===sessionId,403,'invalid_offline_license');
  return result.payload;
}
