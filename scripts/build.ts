import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const root = new URL('../', import.meta.url);
await mkdir(new URL('dist/', root), { recursive: true });

for (const name of ['cli', 'prune', 'output']) {
  const source = await readFile(new URL(`src/${name}.ts`, root), 'utf8');
  // These modules use static relative imports; JSON and node: imports stay intact.
  const javascript = stripTypeScriptTypes(source, { mode: 'strip' })
    .replace(/(from\s+['"]\.\.?\/[^'"]+)\.ts(['"])/g, '$1.js$2');
  await writeFile(new URL(`dist/${name}.js`, root), javascript);
}

// Stripping preserves the source shebang; npm can now expose it as an executable.
await chmod(new URL('dist/cli.js', root), 0o755);