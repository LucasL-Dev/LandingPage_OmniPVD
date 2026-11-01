import { generateKeyPairSync,randomBytes,createHash,sign } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';
const b64=data=>Buffer.from(data).toString('base64url');
const sha=data=>createHash('sha256').update(data).digest();
export function authenticator() {
 const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),jwk=keys.publicKey.export({format:'jwk'}),credentialId=randomBytes(32);let counter=0;
 const cose=isoCBOR.encode(new Map([[1,2],[3,-7],[-1,1],[-2,new Uint8Array(Buffer.from(jwk.x,'base64url'))],[-3,new Uint8Array(Buffer.from(jwk.y,'base64url'))]]));
 let handle;
 return {
  register(options,origin) {
   handle=options.user.id;
   const client=Buffer.from(JSON.stringify({type:'webauthn.create',challenge:options.challenge,origin,crossOrigin:false}));
   const length=Buffer.alloc(2);length.writeUInt16BE(credentialId.length);
   const authData=Buffer.concat([sha(options.rp.id),Buffer.from([0x45]),Buffer.alloc(4),Buffer.alloc(16),length,credentialId,cose]);
   return {id:b64(credentialId),rawId:b64(credentialId),type:'public-key',authenticatorAttachment:'platform',clientExtensionResults:{},response:{clientDataJSON:b64(client),attestationObject:b64(isoCBOR.encode(new Map([['fmt','none'],['authData',new Uint8Array(authData)],['attStmt',new Map()]]))),transports:['internal']}};
  },
  login(options,origin) {
   const client=Buffer.from(JSON.stringify({type:'webauthn.get',challenge:options.challenge,origin,crossOrigin:false}));
   const count=Buffer.alloc(4);count.writeUInt32BE(++counter);
   const authData=Buffer.concat([sha(options.rpId),Buffer.from([0x05]),count]);
   return {id:b64(credentialId),rawId:b64(credentialId),type:'public-key',authenticatorAttachment:'platform',clientExtensionResults:{},response:{clientDataJSON:b64(client),authenticatorData:b64(authData),signature:b64(sign('sha256',Buffer.concat([authData,sha(client)]),keys.privateKey)),userHandle:handle}};
  },
 };
}
