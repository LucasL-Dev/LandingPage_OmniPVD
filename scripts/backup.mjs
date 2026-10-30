import { DatabaseSync, backup } from 'node:sqlite';
import { stat, mkdir, chmod, rename, open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export async function backupDatabase(source, directory) {
  if(!source||!directory||!path.isAbsolute(source)||!path.isAbsolute(directory))throw Error('Use caminhos absolutos.');
  if(!(await stat(source)).isFile())throw Error('Banco de origem deve existir.');
  await mkdir(directory,{recursive:true,mode:0o700});
  const destination=path.join(directory,`billing-${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID()}.sqlite`);
  const temporary=destination+'.partial';const db=new DatabaseSync(source,{readOnly:true});
  try { await backup(db,temporary); } finally {db.close();}
  await chmod(temporary,0o600);
  const check=new DatabaseSync(temporary,{readOnly:true});
  try {if(check.prepare('PRAGMA quick_check').all().some(r=>Object.values(r)[0]!=='ok'))throw Error('Backup não passou na integridade.');}finally{check.close();}
  const handle=await open(temporary,'r');try{await handle.sync();}finally{await handle.close();}
  await rename(temporary,destination);
  if(process.platform!=='win32'){const dir=await open(directory,'r');try{await dir.sync();}finally{await dir.close();}}
  return destination;
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try {await backupDatabase(process.env.BILLING_DB_PATH,process.env.BACKUP_DIR);console.log('backup_completed');}
  catch{console.error('backup_failed: verifique origem existente, permissões e espaço privado.');process.exitCode=1;}
}
