import { generateKeyPairSync } from 'node:crypto';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const destination=process.argv[2];
if(!destination||!path.isAbsolute(destination))throw new Error('Informe um caminho absoluto privado fora do checkout.');
await mkdir(path.dirname(destination),{recursive:true,mode:0o700});
const directory=await realpath(path.dirname(destination)),root=await realpath(fileURLToPath(new URL('../',import.meta.url)));
if(directory===root||directory.startsWith(root+path.sep))throw new Error('A chave não pode estar dentro do checkout.');
const keys=generateKeyPairSync('ed25519');
await writeFile(destination,keys.privateKey.export({format:'pem',type:'pkcs8'}),{flag:'wx',mode:0o600});
console.log('Chave privada criada no caminho informado, sem sobrescrever arquivos. Não envie esse arquivo ao Git.');
console.log('Chave pública para distribuir ao aplicativo (não é segredo):');
console.log(JSON.stringify(keys.publicKey.export({format:'jwk'})));
