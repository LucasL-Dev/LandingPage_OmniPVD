import { readFile } from 'node:fs/promises';
import { ApiError, check, hash, rateLimit, validateAuthorization } from './common.mjs';

export function createAuthHandler({auth,licensing,db,config,now=()=>Date.now()}) {
  const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'}).end(JSON.stringify(data));};
  const cookie=token=>`omnipvd_browser=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(config.browserTtlMs/1000)}${config.secureCookies?'; Secure':''}`;
  const browser=req=>{
    const token=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('omnipvd_browser='))?.slice('omnipvd_browser='.length);
    return auth.browserSession(token);
  };
  const desktop=req=>auth.accessSession(/^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization||'')?.[1]);
  async function body(req) {
    check(req.headers['content-type']?.split(';')[0]==='application/json',415,'json_required');
    let length=0;const chunks=[];
    for await(const chunk of req){length+=chunk.length;check(length<=32*1024,413,'body_too_large');chunks.push(chunk);}
    let result;try{result=JSON.parse(Buffer.concat(chunks).toString());}catch{throw new ApiError(400,'invalid_json');}
    check(result && typeof result==='object' && !Array.isArray(result));return result;
  }
  const csrf=(req,session)=>auth.verifyCsrf(session,req.headers['x-csrf-token']);
  return async function handle(req,res,url) {
    const pathname=url.pathname;
    if (!(pathname.startsWith('/api/auth/') || pathname==='/api/account/claim' || pathname==='/api/license/status' || pathname==='/account/login' || pathname.startsWith('/account/assets/') || pathname==='/.well-known/omnipvd-license-keys.json')) return false;
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('Permissions-Policy','publickey-credentials-get=(self), publickey-credentials-create=(self)');
    try {
      // Socket IP only: untrusted X-Forwarded-For never bypasses the limiter.
      rateLimit(db,`ip:${req.socket.remoteAddress}`,180,now());
      if(req.method==='GET' && pathname==='/account/login') {
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}).end(await readFile(new URL('./page.html',import.meta.url)));return true;
      }
      const assets={
        '/account/assets/app.js':[new URL('./browser.js',import.meta.url),'text/javascript; charset=utf-8'],
        '/account/assets/style.css':[new URL('./style.css',import.meta.url),'text/css; charset=utf-8'],
        '/account/assets/webauthn.js':[new URL('../node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js',import.meta.url),'text/javascript; charset=utf-8'],
      };
      if(req.method==='GET' && assets[pathname]) {
        const [file,type]=assets[pathname];res.writeHead(200,{'Content-Type':type}).end(await readFile(file));return true;
      }
      if(pathname==='/.well-known/omnipvd-license-keys.json' && req.method==='GET'){json(res,200,licensing.jwks);return true;}
      if(pathname==='/api/license/status' && req.method==='GET') {
        check(!url.search,400,'unexpected_parameters');
        const session=desktop(req);rateLimit(db,`license:${session.account_id}`,30,now());
        json(res,200,await licensing.status(session));return true;
      }
      if(pathname==='/api/auth/authorize' && req.method==='GET') {
        const params=validateAuthorization(Object.fromEntries(url.searchParams));
        const redirect=new URL('/account/login',config.origin);
        for(const [key,value]of Object.entries(params))redirect.searchParams.set(key,value);
        res.writeHead(302,{Location:redirect.href}).end();return true;
      }
      if(pathname==='/api/auth/session' && req.method==='GET') {
        const session=browser(req);
        json(res,200,{display_name:db.prepare('SELECT display_name FROM auth_accounts WHERE id=?').get(session.account_id).display_name,csrf_token:auth.csrf(session)});return true;
      }
      if(pathname==='/api/auth/sessions' && req.method==='GET') {
        const session=req.headers.authorization?desktop(req):browser(req);
        json(res,200,{sessions:auth.sessions(session)});return true;
      }
      check(req.method==='POST',405,'method_not_allowed');
      // Browser writes require an exact Origin. Native token/logout requests may omit it.
      if(req.headers.origin)check(req.headers.origin===config.origin,403,'invalid_origin');
      else check(['/api/auth/token','/api/auth/logout'].includes(pathname),403,'origin_required');
      const input=await body(req);
      if(pathname==='/api/auth/token') {
        rateLimit(db,`token:${req.socket.remoteAddress}`,30,now());
        json(res,200,auth.exchange(input));return true;
      }
      if(pathname==='/api/auth/passkeys/register/options') {
        rateLimit(db,`enroll:${req.socket.remoteAddress}`,10,now());
        let session=null;
        if(!input.claimToken){session=browser(req);csrf(req,session);}
        json(res,200,await auth.registrationOptions(input,session));return true;
      }
      if(pathname==='/api/auth/passkeys/register/verify') {
        let session=null;
        if(!input.claimToken){session=browser(req);csrf(req,session);}
        const result=await auth.registrationVerify(input,session);
        res.setHeader('Set-Cookie',cookie(result.browserToken));json(res,200,{ok:true});return true;
      }
      if(pathname==='/api/auth/passkeys/login/options') {
        rateLimit(db,`login:${req.socket.remoteAddress}`,15,now());
        json(res,200,await auth.loginOptions());return true;
      }
      if(pathname==='/api/auth/passkeys/login/verify') {
        rateLimit(db,`verify:${req.socket.remoteAddress}`,15,now());
        const result=await auth.loginVerify(input);res.setHeader('Set-Cookie',cookie(result.browserToken));json(res,200,{ok:true});return true;
      }
      if(pathname==='/api/auth/logout') {
        const session=req.headers.authorization?desktop(req):browser(req);
        if(session.kind==='browser'){check(req.headers.origin===config.origin,403,'origin_required');csrf(req,session);res.setHeader('Set-Cookie',`omnipvd_browser=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${config.secureCookies?'; Secure':''}`);}
        auth.revoke(session);json(res,200,{ok:true});return true;
      }
      const session=browser(req);csrf(req,session);rateLimit(db,`account:${session.account_id}`,30,now());
      if(pathname==='/api/account/claim'){auth.requireRecent(session);auth.linkClaim(session.account_id,input.claimToken);json(res,200,{ok:true});return true;}
      if(pathname==='/api/auth/authorize'){json(res,200,auth.authorize(session,input));return true;}
      if(pathname==='/api/auth/sessions/revoke'){check(typeof input.session_id==='string');auth.revoke(session,input.session_id);json(res,200,{ok:true});return true;}
      throw new ApiError(404,'not_found');
    } catch(error) {
      const status=error instanceof ApiError?error.status:503;
      if(status===429)res.setHeader('Retry-After','60');
      if(status===405)res.setHeader('Allow','GET, POST');
      json(res,status,{error:error instanceof ApiError?error.code:'temporarily_unavailable'});return true;
    }
  };
}
