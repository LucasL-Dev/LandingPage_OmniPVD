import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import { buildLanding } from './build-landing.mjs';
import { DEFAULT_API_ORIGIN } from '../config/origins.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export async function packageLanding({ outputDir, zipPath = path.join(root, 'omnipdv-landing.zip'), apiOrigin = DEFAULT_API_ORIGIN } = {}) {
  const result = await buildLanding({ outputDir, apiOrigin });
  const entries = {};
  for (const name of result.files) entries[name] = [new Uint8Array(await readFile(path.join(result.outputDir, name))), { mtime: new Date(1980, 0, 1), level: 6 }];
  await writeFile(zipPath, zipSync(entries));
  return { ...result, zipPath };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await packageLanding({ apiOrigin: process.env.LANDING_API_ORIGIN || DEFAULT_API_ORIGIN });
  console.log('ZIP gerado: omnipdv-landing.zip. index.html está diretamente na raiz.');
}
