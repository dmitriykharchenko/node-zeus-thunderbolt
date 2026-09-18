import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { lockfiles, prune } from '../src/prune.ts';
import type { PruneEvent } from '../src/prune.ts';
import { exists, fixture, project, snapshot } from './helpers.ts';

for (const lockfile of lockfiles) {
  test(`accepts a regular ${lockfile} and preserves the project`, async (t) => {
    const root = await fixture(t);
    const modules = await project(root, lockfile);
    const events: PruneEvent[] = [];
    const result = await prune(root, { onEvent: (event) => events.push(event) });
    assert.deepEqual(result, { deleted: 1, planned: 0, skipped: 0, errors: 0 });
    assert.deepEqual(events, [{ kind: 'deleted', path: modules }]);
    assert.equal(await exists(modules), false);
    assert.equal(await fs.readFile(join(root, 'keep.txt'), 'utf8'), 'keep');
    assert.equal(await exists(join(root, 'package.json')), true);
    assert.equal(await exists(join(root, lockfile)), true);
  });
}

test('discovers deep and hidden projects and deletes only exact node_modules candidates', async (t) => {
  const root = await fixture(t);
  const deep = join(root, ...Array.from({ length: 45 }, (_, i) => `level${i}`));
  const candidates = [await project(deep), await project(join(root, '.hidden', 'project'))];
  await fs.mkdir(join(root, 'node_modules-backup'));
  await fs.writeFile(join(root, 'node_modules-backup', 'keep'), 'keep');
  const remove = fs.rm.bind(fs);
  const removed: string[] = [];
  t.mock.method(fs, 'rm', async (path: string, options: Parameters<typeof fs.rm>[1]) => {
    assert.equal(basename(path), 'node_modules');
    assert.ok(candidates.includes(path));
    removed.push(path);
    return remove(path, options);
  });
  assert.equal((await prune(root)).deleted, 2);
  assert.deepEqual(removed.sort(), candidates.sort());
  assert.equal(await fs.readFile(join(root, 'node_modules-backup', 'keep'), 'utf8'), 'keep');
});

test('requires both markers in the immediate parent and never scans skipped dependency trees', async (t) => {
  const root = await fixture(t);
  await fs.writeFile(join(root, 'package.json'), '{}');
  await fs.writeFile(join(root, 'yarn.lock'), 'lock');
  for (const name of ['neither', 'manifest-only', 'lock-only']) {
    const parent = join(root, name);
    await fs.mkdir(join(parent, 'node_modules'), { recursive: true });
    if (name === 'manifest-only') await fs.writeFile(join(parent, 'package.json'), '{}');
    if (name === 'lock-only') await fs.writeFile(join(parent, 'yarn.lock'), 'lock');
    await project(join(parent, 'node_modules', 'nested-project'));
  }
  const before = await snapshot(root);
  const readDirectory = fs.readdir.bind(fs);
  t.mock.method(fs, 'readdir', async (path: string, options: never) => {
    assert.ok(!path.split('/').includes('node_modules'), `entered dependency tree: ${path}`);
    return readDirectory(path, options);
  });
  assert.deepEqual(await prune(root), { deleted: 0, planned: 0, skipped: 3, errors: 0 });
  t.mock.restoreAll();
  assert.deepEqual(await snapshot(root), before);
});

test('directories and symlinks do not count as regular marker files', async (t) => {
  const root = await fixture(t);
  const target = join(root, 'marker-target');
  await fs.writeFile(target, '{}');
  for (const name of ['manifest-directory', 'lock-directory', 'manifest-link', 'lock-link']) {
    const parent = join(root, name);
    await fs.mkdir(join(parent, 'node_modules'), { recursive: true });
    const invalid = name.startsWith('manifest') ? 'package.json' : 'yarn.lock';
    const valid = invalid === 'package.json' ? 'yarn.lock' : 'package.json';
    await fs.writeFile(join(parent, valid), '{}');
    if (name.endsWith('directory')) await fs.mkdir(join(parent, invalid));
    else await fs.symlink(target, join(parent, invalid));
  }
  const before = await snapshot(root);
  const result = await prune(root);
  assert.equal(result.deleted, 0);
  assert.equal(result.errors, 0);
  assert.deepEqual(await snapshot(root), before);
});

test('smite bypasses only markers and dry-run leaves a byte-identical tree', async (t) => {
  const root = await fixture(t);
  await fs.mkdir(join(root, 'unmarked', 'node_modules'), { recursive: true });
  await project(join(root, 'marked'));
  await fs.writeFile(join(root, 'keep'), 'untouched');
  const before = await snapshot(root);
  assert.deepEqual(await prune(root, { dryRun: true }), { deleted: 0, planned: 1, skipped: 1, errors: 0 });
  assert.deepEqual(await snapshot(root), before);
  assert.deepEqual(await prune(root, { smite: true, dryRun: true }), { deleted: 0, planned: 2, skipped: 0, errors: 0 });
  assert.deepEqual(await snapshot(root), before);
  assert.deepEqual(await prune(root, { smite: true }), { deleted: 2, planned: 0, skipped: 0, errors: 0 });
  assert.equal(await fs.readFile(join(root, 'keep'), 'utf8'), 'untouched');
});

test('never follows symlink directories or removes symlink/file candidates, even with smite', async (t) => {
  const root = await fixture(t);
  const scan = join(root, 'scan');
  const outside = join(root, 'outside');
  await fs.mkdir(scan);
  const outsideModules = await project(outside);
  await fs.symlink(outside, join(scan, 'linked-project'));
  await fs.symlink(scan, join(scan, 'cycle'));
  await fs.symlink(outsideModules, join(scan, 'node_modules'));
  await fs.symlink(join(root, 'missing'), join(scan, 'broken-link'));
  await fs.mkdir(join(scan, 'not-a-directory'));
  await fs.writeFile(join(scan, 'not-a-directory', 'node_modules'), 'ordinary file');
  const before = await snapshot(root);
  const result = await prune(scan, { smite: true });
  assert.equal(result.errors, 0);
  assert.equal(result.deleted, 0);
  assert.equal(result.skipped, 5);
  assert.deepEqual(await snapshot(root), before);
});

test('recursive deletion unlinks internal symlinks without touching their targets', async (t) => {
  const root = await fixture(t);
  const scan = join(root, 'scan');
  const modules = await project(scan);
  const outside = join(root, 'outside');
  await project(outside);
  await fs.symlink(outside, join(modules, 'linked-dependency'));
  const before = await snapshot(outside);
  assert.equal((await prune(scan)).deleted, 1);
  assert.deepEqual(await snapshot(outside), before);
});

test('an explicit node_modules root is a candidate, not a tree to descend into', async (t) => {
  const root = await fixture(t);
  const modules = await project(root);
  assert.equal((await prune(modules, { dryRun: true })).planned, 1);
  assert.equal((await prune(modules)).deleted, 1);
  assert.equal(await exists(root), true);
});

test('a file, missing path, symlink root, and dependency descendant fail without deletion', async (t) => {
  const root = await fixture(t);
  const modules = await project(root);
  const nested = join(modules, 'nested');
  await project(nested);
  await fs.symlink(root, join(root, 'root-link'));
  const before = await snapshot(root);
  for (const path of [join(root, 'keep.txt'), join(root, 'missing'), join(root, 'root-link'), nested]) {
    assert.equal((await prune(path, { smite: true })).errors, 1);
  }
  assert.deepEqual(await snapshot(root), before);
});

test('read, marker, and removal failures are visible and accessible siblings still get pruned', async (t) => {
  const root = await fixture(t);
  const good = await project(join(root, 'good'));
  const readFailure = join(root, 'unreadable');
  const markerFailure = join(root, 'bad-marker');
  const removalFailure = await project(join(root, 'unremovable'));
  await project(readFailure);
  await project(markerFailure);
  const readdir = fs.readdir.bind(fs);
  const lstat = fs.lstat.bind(fs);
  const rm = fs.rm.bind(fs);
  const denied = () => Object.assign(new Error('EACCES: permission denied (injected)'), { code: 'EACCES' });
  t.mock.method(fs, 'readdir', async (path: string, options: never) => {
    if (path === readFailure) throw denied();
    return readdir(path, options);
  });
  t.mock.method(fs, 'lstat', async (path: string) => {
    if (path === join(markerFailure, 'package.json')) throw denied();
    return lstat(path);
  });
  t.mock.method(fs, 'rm', async (path: string, options: Parameters<typeof fs.rm>[1]) => {
    if (path === removalFailure) throw denied();
    return rm(path, options);
  });
  const events: PruneEvent[] = [];
  const result = await prune(root, { onEvent: (event) => events.push(event) });
  assert.deepEqual(result, { deleted: 1, planned: 0, skipped: 0, errors: 3 });
  assert.equal(events.filter((event) => event.kind === 'error' && event.reason?.includes('EACCES')).length, 3);
  assert.equal(await exists(good), false);
  assert.equal(await exists(removalFailure), true);
  assert.equal(await exists(join(readFailure, 'node_modules')), true);
  assert.equal(await exists(join(markerFailure, 'node_modules')), true);
});

test('a candidate swapped for a symlink before removal is preserved and reported', async (t) => {
  const root = await fixture(t);
  const modules = await project(join(root, 'scan'));
  const outside = await project(join(root, 'outside'));
  const lstat = fs.lstat.bind(fs);
  let candidateChecks = 0;
  t.mock.method(fs, 'lstat', async (path: string) => {
    if (path === modules && ++candidateChecks === 3) {
      await fs.rename(modules, `${modules}-moved`);
      await fs.symlink(outside, modules);
    }
    return lstat(path);
  });
  const result = await prune(join(root, 'scan'));
  assert.equal(result.errors, 1);
  assert.equal(result.deleted, 0);
  assert.equal((await lstat(modules)).isSymbolicLink(), true);
  assert.equal(await exists(join(outside, 'dependency.txt')), true);
  assert.equal(await exists(`${modules}-moved`), true);
});

test('a candidate ancestor replaced with a symlink is rejected before removal', async (t) => {
  const root = await fixture(t);
  const scan = join(root, 'scan');
  const parent = join(scan, 'project');
  await project(parent);
  const outside = join(root, 'outside');
  await project(outside);
  const before = await snapshot(outside);
  const lstat = fs.lstat.bind(fs);
  t.mock.method(fs, 'lstat', async (path: string) => {
    const stat = await lstat(path);
    if (path === join(parent, 'package.json')) {
      await fs.rename(parent, `${parent}-moved`);
      await fs.symlink(outside, parent);
    }
    return stat;
  });
  const result = await prune(scan);
  assert.equal(result.errors, 1);
  assert.equal(result.deleted, 0);
  assert.deepEqual(await snapshot(outside), before);
  assert.equal(await exists(join(`${parent}-moved`, 'node_modules')), true);
});