import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createAuth } from './service.mjs';
import { createAuthHandler } from './http.mjs';
import { createLicensing } from '../licensing/service.mjs';

function seconds(name,fallback,min,max) {
  const value=process.env[name]===undefined||process.env[name]===''?fallback:Number(process.env[name]);
  if(!Number.isSafeInteger(value)||value<min||value>max)throw new Error(`Configuração inválida: ${name}`);
  return value;
}
export async function authRuntime({stripe,billing,projectRoot,priceId}) {
  if(process.env.AUTH_ENABLED!=='true')return null;
  if(!stripe||!billing)throw new Error('Licenciamento requer Stripe e o banco persistente de billing.');
  const originUrl=new URL(process.env.AUTH_ORIGIN);
  const local=process.env.AUTH_ALLOW_LOCALHOST==='true' && originUrl.protocol==='http:' && ['localhost','127.0.0.1'].includes(originUrl.hostname);
  if((originUrl.protocol!=='https:'&&!local)||originUrl.origin!==process.env.AUTH_ORIGIN)throw new Error('AUTH_ORIGIN deve ser uma origem HTTPS (localhost somente em desenvolvimento).');
  const rpId=process.env.AUTH_RP_ID;
  if(rpId!==originUrl.hostname)throw new Error('AUTH_RP_ID deve ser o host exato da origem nesta fase.');
  const keyId=process.env.LICENSE_SIGNING_KEY_ID;
  if(!keyId||!/^[A-Za-z0-9_-]{1,64}$/.test(keyId))throw new Error('LICENSE_SIGNING_KEY_ID inválido.');
  const filename=await realpath(process.env.LICENSE_PRIVATE_KEY_PATH);
  const root=await realpath(projectRoot);
  if(filename===root||filename.startsWith(root+path.sep))throw new Error('Chave privada deve estar fora do checkout.');
  let previousPublicKeys=[];
  if(process.env.LICENSE_PREVIOUS_PUBLIC_KEYS_PATH){
    const publicFile=await realpath(process.env.LICENSE_PREVIOUS_PUBLIC_KEYS_PATH);
    if(publicFile===root||publicFile.startsWith(root+path.sep))throw new Error('Use arquivo público de rotação fora do checkout.');
    previousPublicKeys=JSON.parse(await readFile(publicFile,'utf8')).keys;
    if(!Array.isArray(previousPublicKeys))throw new Error('JWKS anterior inválido.');
  }
  const config={origin:originUrl.origin,rpId,secureCookies:!local,
    browserTtlMs:seconds('AUTH_BROWSER_TTL_SECONDS',43_200,300,86_400)*1000,
    sessionTtlMs:seconds('AUTH_SESSION_TTL_SECONDS',2_592_000,3600,2_592_000)*1000,
    accessTtlMs:seconds('AUTH_ACCESS_TTL_SECONDS',600,60,900)*1000};
  const auth=createAuth({db:billing.db,config});
  const licensing=await createLicensing({db:billing.db,stripe,privateKeyPem:await readFile(filename,'utf8'),
    config:{priceId,keyId,previousPublicKeys,issuer:originUrl.origin,audience:'omnipvd-desktop',offlineTtlSeconds:seconds('LICENSE_OFFLINE_TTL_SECONDS',14_400,60,14_400),recheckSeconds:seconds('LICENSE_RECHECK_SECONDS',900,30,3600)}});
  return {auth,licensing,handle:createAuthHandler({auth,licensing,db:billing.db,config})};
}
