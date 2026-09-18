import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import metadata from '../package.json' with { type: 'json' };
import { exists, fixture, project, runTtyCli, snapshot } from './helpers.ts';

const repository = fileURLToPath(new URL('../', import.meta.url));
const packageFiles = ['README.md', 'dist/cli.js', 'dist/output.js', 'dist/prune.js', 'package.json'];

function run(command: string, args: string[], cwd: string, expectedStatus = 0) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8', timeout: 60_000,
    shell: process.platform === 'win32' && command.endsWith('.cmd'),
    env: { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}` },
  });
  if (result.error) throw result.error;
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, expectedStatus, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}

function npm(args: string[], cwd: string) {
  // Reuse npm's own CLI path when invoked by npm test, including on Windows.
  const npmCli = process.env.npm_execpath;
  const command = npmCli ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return run(command, npmCli ? [npmCli, ...args] : args, cwd);
}

test('packed npm distribution works under node_modules without sources or install-time builds', async (t) => {
  const root = await fixture(t);
  const staging = join(root, 'package source');
  const consumer = join(root, 'consumer');
  await fs.mkdir(staging);
  await fs.mkdir(consumer);
  for (const name of ['package.json', 'README.md', 'src', 'scripts']) {
    await fs.cp(join(repository, name), join(staging, name), { recursive: true });
  }
  await fs.writeFile(join(staging, 'unrelated.txt'), 'must not ship');
  await fs.mkdir(join(staging, 'test'));
  await fs.writeFile(join(staging, 'test', 'excluded.test.ts'), 'must not ship');
  await fs.mkdir(join(staging, 'dist'));
  await fs.writeFile(join(staging, 'dist', 'stale.js'), 'must not ship');
  assert.equal(await exists(join(staging, 'dist', 'cli.js')), false);

  const packed = npm(['pack', '--json', '--ignore-scripts=false', '--offline', '--loglevel=error'], staging);
  const [artifact] = JSON.parse(packed.stdout);
  assert.equal(artifact.name, 'node-zeus-thunderbolt');
  assert.equal(artifact.version, metadata.version);
  assert.deepEqual(artifact.files.map((file: { path: string }) => file.path).sort(), packageFiles);
  const tarball = join(staging, artifact.filename);
  assert.equal(await exists(tarball), true);

  await fs.writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'nzt-smoke-consumer', private: true }));
  npm(['install', tarball, '--offline', '--no-audit', '--no-fund', '--package-lock=false',
    '--ignore-scripts=false', '--foreground-scripts'], consumer);

  const installed = join(consumer, 'node_modules', 'node-zeus-thunderbolt');
  const installedTree = await snapshot(installed);
  assert.deepEqual(Object.keys(installedTree).filter((name) => !name.endsWith('/')).sort(), packageFiles);
  const installedMetadata = JSON.parse(await fs.readFile(join(installed, 'package.json'), 'utf8'));
  assert.deepEqual(installedMetadata.bin, { nzt: 'dist/cli.js' });
  assert.equal(installedMetadata.engines.node, '>=23.6.0');
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) {
    assert.equal(installedMetadata.scripts[hook], undefined, `Unexpected install hook: ${hook}`);
  }
  const javascript = await fs.readFile(join(installed, 'dist', 'cli.js'), 'utf8');
  assert.ok(javascript.startsWith('#!/usr/bin/env node\n'));
  assert.match(javascript, /from ['"]\.\/prune\.js['"]/);
  assert.match(javascript, /from ['"]\.\/output\.js['"]/);
  assert.doesNotMatch(javascript, /from ['"]\.\/\w+\.ts['"]/);
  if (process.platform !== 'win32') {
    assert.notEqual((await fs.stat(join(installed, 'dist', 'cli.js'))).mode & 0o111, 0);
  }
  const bin = join(consumer, 'node_modules', '.bin', process.platform === 'win32' ? 'nzt.cmd' : 'nzt');

  await t.test('installed bin resolves help and package version from an unrelated working directory', () => {
    const help = run(bin, ['--help'], root).stdout;
    assert.match(help, /Usage: nzt/);
    assert.match(help, /--verbose/);
    assert.match(help, /Braille spinner/);
    assert.equal(run(bin, ['--version'], root).stdout.trim(), metadata.version);
  });

  await t.test('installed command always reports errors on stderr and exits nonzero', () => {
    const missing = join(root, 'missing');
    for (const flags of [[], ['--verbose']]) {
      const result = run(bin, [...flags, '--dry-run', missing], root, 1);
      assert.match(result.stderr, /error:.*ENOENT/);
      assert.ok(result.stderr.includes(JSON.stringify(missing)));
      assert.match(result.stdout, /Estimated would free: 0 B \| 0 planned \| 0 require --smite/);
      assert.doesNotMatch(result.stdout, /[\r\x1b]|error:/);
    }
  });

  const target = join(root, 'projects with spaces');
  const eligible = await project(join(target, 'nested', 'eligible'));
  const second = await project(join(target, 'second'));
  await fs.writeFile(join(eligible, 'dependency.txt'), Buffer.alloc(1024));
  await fs.writeFile(join(second, 'dependency.txt'), Buffer.alloc(512));
  const unmarked = join(target, 'unmarked', 'node_modules');
  await fs.mkdir(unmarked, { recursive: true });
  await fs.writeFile(join(unmarked, 'keep-until-smite.txt'), 'disposable dependency');

  await t.test('installed dry-run leaves every fixture unchanged', async () => {
    const before = await snapshot(target);
    const preview = run(bin, ['--dry-run', target], root);
    assert.match(preview.stdout, /Estimated would free: 1.50 KiB \| 2 planned \| 1 require --smite/);
    assert.doesNotMatch(preview.stdout, /[\r\x1b⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]|planned:|skipped:|node_modules/);
    assert.equal(preview.stdout.trim().split('\n').length, 4);
    assert.match(preview.stdout, /\| 1 planned \|/);
    assert.deepEqual(await snapshot(target), before);
  });

  await t.test('installed verbose preview reports candidate sizes and skip reasons', async () => {
    const before = await snapshot(target);
    const preview = run(bin, ['--verbose', '--dry-run', target], root);
    assert.ok(preview.stdout.includes(`planned: ${JSON.stringify(eligible)} — estimated 1.00 KiB (1024 bytes)`));
    assert.ok(preview.stdout.includes(`skipped: ${JSON.stringify(unmarked)}`));
    assert.match(preview.stdout, /requires regular package.json/);
    assert.match(preview.stdout, /0 deleted, 2 planned, 1 skipped, 0 errors/);
    assert.doesNotMatch(preview.stdout, /[\r\x1b⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
    assert.deepEqual(await snapshot(target), before);
  });

  await t.test('installed normal mode removes only eligible node_modules', async () => {
    const normal = run(bin, [target], root);
    assert.match(normal.stdout, /Estimated freed: 1.50 KiB \| 2 removed \| 1 require --smite/);
    assert.doesNotMatch(normal.stdout, /[\r\x1b]|deleted:|skipped:|node_modules/);
    assert.equal(await exists(eligible), false);
    assert.equal(await exists(second), false);
    assert.equal(await exists(unmarked), true);
    assert.equal(await fs.readFile(join(dirname(eligible), 'keep.txt'), 'utf8'), 'keep');
  });

  await t.test('installed smite preview is nonmutating and smite removes unmarked candidates', async () => {
    const before = await snapshot(target);
    assert.match(run(bin, ['--smite', '--dry-run', target], root).stdout,
      /Estimated would free: 21 B \| 1 planned \| 0 require --smite/);
    assert.deepEqual(await snapshot(target), before);
    const removal = run(bin, ['--smite', '--verbose', target], root);
    assert.match(removal.stdout, /Estimated freed: 21 B \| 1 removed \| 0 require --smite/);
    assert.match(removal.stdout, /1 deleted, 0 planned, 0 skipped, 0 errors/);
    assert.equal(await exists(unmarked), false);
    assert.equal(await fs.readFile(join(dirname(eligible), 'keep.txt'), 'utf8'), 'keep');
  });
  await t.test('installed entry point animates TTY scans and finishes without a spinner', async () => {
    const ttyTarget = join(root, 'tty-project');
    const modules = await project(ttyTarget);
    const before = await snapshot(ttyTarget);
    const writes = runTtyCli(['--dry-run', ttyTarget], root, join(installed, 'dist', 'cli.js'));
    for (const frame of '⠋⠙⠹') {
      assert.ok(writes.includes(`${frame} Estimated would free: 0 B | 0 planned | 0 require --smite`));
    }
    assert.equal(writes.at(-1), 'Estimated would free: 21 B | 1 planned | 0 require --smite\n');
    assert.equal(await exists(modules), true);
    assert.deepEqual(await snapshot(ttyTarget), before);
  });
  assert.deepEqual(await snapshot(installed), installedTree);
});