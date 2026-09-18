import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join, parse } from 'node:path';
import { test } from 'node:test';
import metadata from '../package.json' with { type: 'json' };
import { exists, fixture, project, runCli, snapshot } from './helpers.ts';

test('help and version work without a path and do not mutate files', async (t) => {
  const root = await fixture(t);
  await project(root);
  const before = await snapshot(root);
  const help = runCli(['--help'], root);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage: node-modules-prune/);
  for (const flag of ['--smite', '--dry-run', '--help', '--version']) assert.ok(help.stdout.includes(flag));
  const version = runCli(['--version'], root);
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), metadata.version);
  assert.deepEqual(await snapshot(root), before);
});

test('invalid arguments fail before deleting an otherwise eligible candidate', async (t) => {
  const root = await fixture(t);
  await project(root);
  const before = await snapshot(root);
  const invalid = [
    [], [''], ['--smite'], [root, root], [root, '--wat'], ['--dry-run=true', root],
    ['--help', '--version'], [root, '--help'], ['--smite', '--smite', root],
    [root, '--dry-run', '--dry-run'], ['--version', root],
  ];
  for (const args of invalid) {
    const result = runCli(args, root);
    assert.equal(result.status, 2, JSON.stringify(args));
    assert.match(result.stderr, /Error:.*\nRun node-modules-prune --help/);
  }
  assert.deepEqual(await snapshot(root), before);
});

test('invalid starting paths are reported with a nonzero status and no mutations', async (t) => {
  const root = await fixture(t);
  await project(root);
  await fs.symlink(root, join(root, 'linked'));
  const before = await snapshot(root);
  for (const path of [join(root, 'missing'), join(root, 'keep.txt'), join(root, 'linked')]) {
    const result = runCli(['--smite', path], root);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /error:/);
    assert.match(result.stdout, /0 deleted, 0 planned, 0 skipped, 1 errors/);
  }
  // Never request real pruning of a filesystem root, even in a rejection test.
  const filesystemRoot = runCli(['--dry-run', parse(root).root], root);
  assert.equal(filesystemRoot.status, 1);
  assert.match(filesystemRoot.stderr, /Refusing to scan a filesystem root/);
  assert.deepEqual(await snapshot(root), before);
});

test('relative paths with spaces, dry-run output, skipped paths, and deletion summaries', async (t) => {
  const root = await fixture(t);
  const path = join(root, 'folder with spaces');
  const modules = await project(join(path, 'project'));
  const skipped = join(path, 'unmarked', 'node_modules');
  await fs.mkdir(skipped, { recursive: true });
  const before = await snapshot(root);
  const preview = runCli(['folder with spaces', '--dry-run'], root);
  assert.equal(preview.status, 0, preview.stderr);
  assert.ok(preview.stdout.includes(`planned: ${JSON.stringify(modules)}`));
  assert.ok(preview.stdout.includes(`skipped: ${JSON.stringify(skipped)}`));
  assert.match(preview.stdout, /0 deleted, 1 planned, 1 skipped, 0 errors/);
  assert.deepEqual(await snapshot(root), before);
  const deletion = runCli(['folder with spaces'], root);
  assert.equal(deletion.status, 0, deletion.stderr);
  assert.ok(deletion.stdout.includes(`deleted: ${JSON.stringify(modules)}`));
  assert.match(deletion.stdout, /1 deleted, 0 planned, 1 skipped, 0 errors/);
  assert.equal(await exists(modules), false);
  assert.equal(await exists(skipped), true);
  assert.equal(await fs.readFile(join(path, 'project', 'keep.txt'), 'utf8'), 'keep');
});

test('smite honors dry-run and -- permits paths beginning with a dash', async (t) => {
  const root = await fixture(t);
  const modules = join(root, '--project', 'node_modules');
  await fs.mkdir(modules, { recursive: true });
  const preview = runCli(['--smite', '--dry-run', '--', '--project'], root);
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /0 deleted, 1 planned/);
  assert.equal(await exists(modules), true);
  const deletion = runCli(['--smite', '--', '--project'], root);
  assert.equal(deletion.status, 0, deletion.stderr);
  assert.match(deletion.stdout, /1 deleted, 0 planned/);
  assert.equal(await exists(modules), false);
});

test('an empty scan succeeds with a zero summary', async (t) => {
  const root = await fixture(t);
  const result = runCli([root], root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /0 deleted, 0 planned, 0 skipped, 0 errors/);
});

test('a real permissions failure exits nonzero but does not stop accessible siblings', async (t) => {
  if (process.platform === 'win32' || process.getuid?.() === 0) {
    t.skip('POSIX permissions cannot be tested as root or on Windows');
    return;
  }
  const root = await fixture(t);
  const blocked = join(root, 'blocked');
  const blockedModules = await project(blocked);
  const goodModules = await project(join(root, 'good'));
  await fs.chmod(blocked, 0o000);
  let result: ReturnType<typeof runCli>;
  try {
    result = runCli([root], root);
  } finally {
    await fs.chmod(blocked, 0o700);
  }
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /EACCES/);
  assert.match(result.stdout, /1 deleted, 0 planned, 0 skipped, 1 errors/);
  assert.equal(await exists(blockedModules), true);
  assert.equal(await exists(goodModules), false);
});