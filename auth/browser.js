/* Browser sessions use HttpOnly cookies. No access/refresh tokens in browser storage. */
const byId=id=>document.getElementById(id);
const params=new URLSearchParams(location.search);
let invite=new URLSearchParams(location.hash.slice(1)).get('invite')||'';
if(location.hash)history.replaceState(null,'',location.pathname+location.search);
if(invite){byId('claim-token').value=invite;byId('enrollment').open=true;}
let csrf='';
const message=text=>{byId('message').textContent=text;};
const labels={reauth_required:'Por segurança, saia e entre novamente com sua passkey antes de adicionar uma credencial ou vincular uma compra.',rate_limited:'Muitas tentativas. Aguarde um minuto.',invalid_claim:'Convite inválido, expirado ou já utilizado.',customer_already_linked:'Esta compra já está vinculada. Entre na conta existente.',invalid_session:'Entre novamente para continuar.',invalid_origin:'Origem de acesso inválida.',invalid_challenge:'A tentativa expirou. Inicie novamente.',license_unavailable:'Serviço temporariamente indisponível.'};
async function api(path,input){
 const response=await fetch(path,{method:input===undefined?'GET':'POST',credentials:'same-origin',headers:input===undefined?{}:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:input===undefined?undefined:JSON.stringify(input)});
 const data=await response.json();
 if(!response.ok)throw new Error(labels[data.error]||'Não foi possível concluir. Tente novamente ou procure o suporte.');
 return data;
}
async function busy(button,fn){button.disabled=true;try{await fn();}catch(error){message(error.name==='NotAllowedError'?'Operação cancelada ou passkey indisponível. Tente novamente.':error.message);}finally{button.disabled=false;}}
async function bootstrap(){
 try{
  const user=await api('/api/auth/session');csrf=user.csrf_token;
  byId('signed-out').hidden=true;byId('signed-in').hidden=false;byId('welcome').textContent=`Olá, ${user.display_name}.`;
  byId('consent').hidden=!params.has('client_id');
  byId('device-label').textContent=`Dispositivo: ${params.get('device_name')||'OmniPVD Windows'}`;
  if(invite)byId('link-token').value=invite;
  message('Conta autenticada. Você pode gerenciar suas sessões e autorizar o aplicativo.');
  const data=await api('/api/auth/sessions');byId('sessions').replaceChildren();
  for(const session of data.sessions){
   const li=document.createElement('li');const text=document.createElement('span');text.textContent=`${session.device_name} · ${session.kind==='browser'?'Navegador':'Aplicativo'} · ${session.revoked_at?'Revogada':new Date(session.expires_at)<=new Date()?'Expirada':'Ativa'}`;li.append(text);
   if(!session.revoked_at){const button=document.createElement('button');button.type='button';button.className='secondary';button.textContent='Revogar';button.addEventListener('click',()=>busy(button,async()=>{await api('/api/auth/sessions/revoke',{session_id:session.id});await bootstrap();}));li.append(button);}byId('sessions').append(li);
  }
 }catch{csrf='';byId('signed-in').hidden=true;byId('signed-out').hidden=false;}
}
byId('login').addEventListener('click',()=>busy(byId('login'),async()=>{
 const flow=await api('/api/auth/passkeys/login/options',{});
 const response=await SimpleWebAuthnBrowser.startAuthentication({optionsJSON:flow.options});
 await api('/api/auth/passkeys/login/verify',{flowToken:flow.flowToken,response});await bootstrap();
}));
byId('register').addEventListener('submit',event=>{event.preventDefault();const button=event.target.querySelector('button');busy(button,async()=>{
 const claimToken=byId('claim-token').value.trim();
 const flow=await api('/api/auth/passkeys/register/options',{claimToken,displayName:byId('display-name').value});
 const response=await SimpleWebAuthnBrowser.startRegistration({optionsJSON:flow.options});
 await api('/api/auth/passkeys/register/verify',{flowToken:flow.flowToken,claimToken,response});invite='';byId('claim-token').value='';await bootstrap();
});});
byId('add-passkey').addEventListener('click',()=>busy(byId('add-passkey'),async()=>{
 const flow=await api('/api/auth/passkeys/register/options',{});
 const response=await SimpleWebAuthnBrowser.startRegistration({optionsJSON:flow.options});
 await api('/api/auth/passkeys/register/verify',{flowToken:flow.flowToken,response});await bootstrap();message('Passkey adicionada.');
}));
byId('link').addEventListener('submit',event=>{event.preventDefault();busy(event.target.querySelector('button'),async()=>{await api('/api/account/claim',{claimToken:byId('link-token').value.trim()});byId('link-token').value='';invite='';message('Compra vinculada à sua conta.');});});
byId('approve').addEventListener('click',()=>busy(byId('approve'),async()=>{const result=await api('/api/auth/authorize',Object.fromEntries(params));location.assign(result.redirect_uri);}));
byId('logout').addEventListener('click',()=>busy(byId('logout'),async()=>{await api('/api/auth/logout',{});await bootstrap();message('Você saiu deste navegador.');}));
bootstrap();
