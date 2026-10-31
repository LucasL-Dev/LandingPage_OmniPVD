import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { LANDING_FILES } from './landing-files.mjs';

const root=fileURLToPath(new URL('../dist-landing/',import.meta.url));
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png'};
http.createServer(async(req,res)=>{
  const name=new URL(req.url,'http://localhost').pathname.slice(1)||'index.html';
  if(!['GET','HEAD'].includes(req.method)||!LANDING_FILES.includes(name)){res.writeHead(404).end();return;}
  try{const data=await readFile(path.join(root,name));res.writeHead(200,{'Content-Type':types[path.extname(name)],'Cache-Control':'no-store'}).end(req.method==='HEAD'?undefined:data);}
  catch{res.writeHead(404).end('Execute npm run build:landing primeiro.');}
}).listen(4173,'127.0.0.1',()=>console.log('Preview estático: porta 4173; não executa backend.'));
