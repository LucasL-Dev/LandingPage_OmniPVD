import { readFile, writeFile, mkdir, rm, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANDING_FILES } from './landing-files.mjs';
import { DEFAULT_API_ORIGIN, validateOrigin } from '../config/origins.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export async function buildLanding({ outputDir = path.join(root, 'dist-landing'), apiOrigin = DEFAULT_API_ORIGIN } = {}) {
  apiOrigin = validateOrigin(apiOrigin, 'LANDING_API_ORIGIN');
  const sourceRoot = await realpath(root);
  const target = path.resolve(outputDir);
  // Callers/tests use a dedicated generated directory; never delete the source checkout.
  if (target === path.resolve(root) || sourceRoot.startsWith(target + path.sep) || target === path.parse(target).root) throw new Error('Diretório de build inválido.');
  const contents = new Map();
  for (const name of LANDING_FILES) {
    const source = path.join(root, name);
    const info = await lstat(source);
    const actual = await realpath(source);
    if (!info.isFile() || info.isSymbolicLink() || !actual.startsWith(sourceRoot + path.sep)) throw new Error(`Origem pública inválida: ${name}`);
    const data = name === 'landing-config.js'
      ? Buffer.from(`// Configuração pública gerada. Nenhum segredo pertence a este arquivo.\nglobalThis.OMNIPDV_PUBLIC_CONFIG = Object.freeze({ apiOrigin: ${JSON.stringify(apiOrigin)} });\n`)
      : await readFile(source);
    contents.set(name, data);
  }
  // A closed manifest replaces previous generated output, including stale/unwanted files.
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  for (const [name, data] of contents) {
    const filename = path.join(target, name);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, data);
  }
  return { outputDir: target, files: [...contents.keys()] };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildLanding({ apiOrigin: process.env.LANDING_API_ORIGIN || DEFAULT_API_ORIGIN });
  console.log(`Landing gerada em dist-landing/: ${result.files.length} arquivos públicos.`);
}
