import { createPrivateKey, createPublicKey } from 'node:crypto';
import { readFile } from 'node:fs/promises';
const [filename,kid]=process.argv.slice(2);
try {
 if(!filename||!kid||!/^[A-Za-z0-9_-]{1,64}$/.test(kid))throw Error();
 const key=createPrivateKey(await readFile(filename));if(key.asymmetricKeyType!=='ed25519')throw Error();
 console.log(JSON.stringify({keys:[{...createPublicKey(key).export({format:'jwk'}),kid,alg:'EdDSA',use:'sig'}]},null,2));
}catch{console.error('public_key_export_failed');process.exitCode=1;}
