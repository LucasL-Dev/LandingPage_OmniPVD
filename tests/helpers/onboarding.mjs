import assert from 'node:assert/strict';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomBytes,generateKeyPairSync } from 'node:crypto';
import { createBilling } from '../../billing/service.mjs';
import { createAuth } from '../../auth/service.mjs';
import { createOnboarding } from '../../onboarding/service.mjs';
import { migrateLicensing } from '../../db/migrate.mjs';
import { createLicensing } from '../../licensing/service.mjs';
import { hash } from '../../auth/common.mjs';
import { authenticator } from './webauthn.mjs';
import { createApp } from '../../server.mjs';
import { createAuthHandler } from '../../auth/http.mjs';

import { createEmailOtp } from '../../auth/email-otp.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const iter=values=>({async *[Symbol.asyncIterator](){yield* values;}});
export async function fixture({emailOtpEnabled=false}={}) {
 const dir=await mkdtemp(path.join(tmpdir(),'omnipdv-onboarding-'));await writeFile(path.join(dir,'installer.exe'),'PRIVATE TEST FIXTURE');
 let clock=Date.now(),fail=false;const calls=[],invoices=new Map(),subs=new Map(),key=randomBytes(32),signer=generateKeyPairSync('ed25519');
 const config={origin:'https://api.omnipdv.com.br',rpId:'api.omnipdv.com.br',secureCookies:true,accessTtlMs:600000,sessionTtlMs:2592000000,browserTtlMs:43200000,priceId:'price_fixture',emailOtp:emailOtpEnabled,from:'sender@example.invalid',supportEmail:'support@example.invalid'};
 const stripe={subscriptions:{retrieve:async sid=>structuredClone(subs.get(sid)),list:params=>iter([...subs.values()].filter(s=>s.customer.id===params.customer))},invoices:{retrieve:async iid=>structuredClone(invoices.get(iid)),list:params=>iter([...invoices.values()].filter(i=>i.customer===params.customer&&i.subscription===params.subscription))}};
 const resend={emails:{send:async(payload,options)=>{calls.push({payload,options:{idempotencyKey:options.idempotencyKey}});if(fail)return{error:{name:'application_error',message:'PRIVATE_ERROR'}};return{data:{id:'mail-'+calls.length}};}}};
 const billingConfig={projectRoot:root,dbPath:path.join(dir,'billing.sqlite'),emailEnabled:true,downloadEnabled:true,installerPath:path.join(dir,'installer.exe'),downloadOrigin:config.origin,priceId:config.priceId,from:config.from,supportEmail:config.supportEmail};
 let billing,auth,onboarding,licensing,emailOtp,server;
 async function open() {
  billing=createBilling({stripe,resend,config:billingConfig,now:()=>clock});migrateLicensing(billing.db);
  onboarding=createOnboarding({db:billing.db,stripe,delivery:billing.onboardingDelivery,config,key,now:()=>clock});billing.attachOnboarding(onboarding);
  auth=createAuth({db:billing.db,config,onboarding,now:()=>clock});
  emailOtp=createEmailOtp({db:billing.db,auth,onboarding,now:()=>clock});
  licensing=await createLicensing({db:billing.db,stripe,privateKeyPem:signer.privateKey.export({format:'pem',type:'pkcs8'}),config:{priceId:config.priceId,keyId:'test-key',issuer:config.origin,audience:'omnipvd-desktop',offlineTtlSeconds:14400,recheckSeconds:900},now:()=>clock});
 }
 await open();
 const addBuyer=(customer,email)=>{
  const invoice={id:'in_'+customer,customer,subscription:'sub_'+customer,livemode:false,status:'paid',paid:true,customer_email:email,billing_reason:'subscription_create',amount_paid:7990,currency:'brl',created:Math.floor(clock/1000),lines:{has_more:false,data:[{price:{id:config.priceId},subscription:'sub_'+customer,period:{start:Math.floor(clock/1000)-60,end:Math.floor(clock/1000)+86400*30}}]}};
  invoices.set(invoice.id,invoice);subs.set(invoice.subscription,{id:invoice.subscription,customer:{id:customer,name:'Buyer',email:'other-contact@example.invalid'},livemode:false,status:'active',latest_invoice:invoice,items:{data:[{price:{id:config.priceId,product:{name:'OmniPDV'},recurring:{interval:'month',interval_count:1}}}]}});return invoice;
 };
 const initial=addBuyer('cus_A','buyer@example.invalid');
 return {dir,calls,invoices,subs,initial,config,stripe,key,get emailOtp(){return emailOtp},get billing(){return billing},get auth(){return auth},get onboarding(){return onboarding},get licensing(){return licensing},addBuyer,setFail:value=>fail=value,advance:ms=>clock+=ms,now:()=>clock,
  async pay(customer='cus_A',eventId='evt_'+customer,type='invoice.paid'){await billing.receive({id:eventId,type,livemode:false,data:{object:{id:'in_'+customer}}});},
  async welcome(customer='cus_A'){await this.pay(customer);await billing.runQueue();const mail=calls.find(c=>c.payload.to===invoices.get('in_'+customer).customer_email&&c.payload.subject.startsWith('Bem-vindo')&&c.options.idempotencyKey==='omnipvd-welcome-sub_'+customer);assert.ok(mail);return {mail,token:new URL(mail.payload.text.match(/https:\/\/[^\s]+\/account\/login#[^\s]+/)[0]).hash.slice('#invite='.length)};},
  loginCode(){return [...calls].reverse().find(c=>c.payload.subject==='OmniPDV — código de acesso').payload.text.match(/\b\d{6}\b/)[0];},
  code(){const mail=[...calls].reverse().find(c=>c.payload.subject==='OmniPDV — código de verificação');assert.ok(mail);return mail.payload.text.match(/\b\d{8}\b/)[0];},
  async ownership(token){const started=await onboarding.start({claimToken:token});await billing.runQueue();const result=await onboarding.verify({claimToken:token,verificationId:started.verificationId,code:this.code()});return result.emailProof;},
  async register(token,emailProof){const flow=await auth.registrationOptions({claimToken:token,emailProof,displayName:'Verified buyer'});const device=authenticator();return auth.registrationVerify({claimToken:token,emailProof,flowToken:flow.flowToken,response:device.register(flow.options,config.origin)});},
  desktop(browserToken){const verifier=randomBytes(48).toString('base64url'),params={client_id:'omnipvd-desktop',response_type:'code',redirect_uri:'http://127.0.0.1:54321/omnipvd/callback',code_challenge_method:'S256',code_challenge:hash(verifier),state:randomBytes(32).toString('base64url'),installation_id:randomBytes(24).toString('base64url')};const result=auth.authorize(auth.browserSession(browserToken),params);return auth.exchange({client_id:'omnipvd-desktop',grant_type:'authorization_code',code:new URL(result.redirect_uri).searchParams.get('code'),code_verifier:verifier,redirect_uri:params.redirect_uri});},
  async reopen(){billing.close();await open();},
  async listen(){server=createApp(stripe,billing,{handle:createAuthHandler({auth,licensing,onboarding,emailOtp:emailOtpEnabled?emailOtp:null,db:billing.db,config,now:()=>clock})});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return `http://127.0.0.1:${server.address().port}`;},
  async close(){if(server)await new Promise(resolve=>server.close(resolve));billing.close();await rm(dir,{recursive:true,force:true});}
 };
}
