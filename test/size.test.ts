import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { basename, join, sep } from 'node:path';
import { test } from 'node:test';
import { prune } from '../src/prune.ts';
import type { PruneEvent, PruneSummary } from '../src/prune.ts';
import { exists, fixture, project, snapshot } from './helpers.ts';

test('counts deterministic nested regular bytes once per candidate, including zero-size trees', async (t) => {
  const root = await fixture(t);
  const a = await project(join(root, 'a'));
  const b = await project(join(root, 'b'));
  await fs.writeFile(join(a, 'dependency.txt'), Buffer.alloc(1024));
  await fs.writeFile(join(b, 'dependency.txt'), Buffer.alloc(7));
  const nested = join(a, 'dep', 'node_modules', 'nested');
  await fs.mkdir(nested, { recursive: true });
  await fs.writeFile(join(nested, 'file'), Buffer.alloc(3));
  await fs.writeFile(join(nested, 'empty'), '');
  const empty = await project(join(root, 'empty'));
  await fs.writeFile(join(empty, 'dependency.txt'), '');
  const before = await snapshot(root);
  const events: PruneEvent[] = [];
  const states: Readonly<PruneSummary>[] = [];
  const preview = await prune(root, { dryRun: true, onEvent(event, summary) {
    events.push(event);
    states.push(summary);
  } });
  assert.deepEqual(preview, {
    deleted: 0, planned: 3, skipped: 0, errors: 0,
    deletedBytes: 0, plannedBytes: 1034, requiresSmite: 0,
  });
  assert.deepEqual(events.filter((event) => 'bytes' in event).map((event) => event.bytes).sort((x, y) => x - y), [0, 7, 1027]);
  assert.deepEqual(states.map((state) => state.planned), [1, 2, 3]);
  assert.equal(states[0].planned, 1, 'event summaries are snapshots, not a shared mutable reference');
  assert.deepEqual(await snapshot(root), before);
  const readFile = t.mock.method(fs, 'readFile', () => { throw new Error('measurement must not read file contents'); });
  const removal = await prune(root);
  assert.equal(removal.deleted, 3);
  assert.equal(removal.deletedBytes, 1034);
  assert.equal(removal.plannedBytes, 0);
  assert.equal(removal.errors, 0);
  assert.equal(readFile.mock.callCount(), 0);
  assert.equal(await exists(a), false);
  assert.equal(await exists(b), false);
});

test('counts hardlink names but ignores internal links, cycles, external targets and nonregular files', async (t) => {
  const root = await fixture(t);
  const scan = join(root, 'scan');
  const modules = await project(scan);
  const external = await project(join(root, 'external'));
  await fs.writeFile(join(modules, 'dependency.txt'), Buffer.alloc(13));
  await fs.link(join(modules, 'dependency.txt'), join(modules, 'hardlink'));
  await fs.symlink(external, join(modules, 'external-dir'));
  await fs.symlink(join(external, 'dependency.txt'), join(modules, 'external-file'));
  await fs.symlink(modules, join(modules, 'cycle'));
  await fs.symlink(join(root, 'absent'), join(modules, 'broken'));
  const special = join(modules, 'nonregular');
  await fs.writeFile(special, Buffer.alloc(99));
  const before = await snapshot(external);
  const lstat = fs.lstat.bind(fs);
  const readdir = fs.readdir.bind(fs);
  t.mock.method(fs, 'lstat', async (path: string) => {
    assert.ok(!path.startsWith(external), `followed external link: ${path}`);
    const stat = await lstat(path);
    if (path === special) stat.isFile = () => false;
    return stat;
  });
  t.mock.method(fs, 'readdir', async (path: string, options: never) => {
    assert.ok(!path.startsWith(external), `read external link: ${path}`);
    return readdir(path, options);
  });
  assert.equal((await prune(scan, { dryRun: true })).plannedBytes, 26);
  const result = await prune(scan);
  assert.equal(result.deletedBytes, 26);
  assert.equal(result.deleted, 1);
  assert.equal(result.errors, 0);
  t.mock.restoreAll();
  assert.deepEqual(await snapshot(external), before);
});

test('smite never checks markers for accounting and always has zero additional opportunities', async (t) => {
  const root = await fixture(t);
  const modules = join(root, 'node_modules');
  await fs.mkdir(modules);
  await fs.writeFile(join(modules, 'bytes'), Buffer.alloc(9));
  const lstat = fs.lstat.bind(fs);
  t.mock.method(fs, 'lstat', async (path: string) => {
    if (basename(path) === 'package.json') throw new Error('marker must not be checked in smite mode');
    return lstat(path);
  });
  for (const dryRun of [true, false]) {
    const result = await prune(root, { smite: true, dryRun });
    assert.equal(result.errors, 0);
    assert.equal(result.requiresSmite, 0);
    assert.equal(dryRun ? result.plannedBytes : result.deletedBytes, 9);
    assert.equal(dryRun ? result.planned : result.deleted, 1);
  }
});

for (const dryRun of [true, false]) {
  test(`measurement read/stat failures preserve candidates and continue siblings (dryRun=${dryRun})`, async (t) => {
    const root = await fixture(t);
    const readFailure = await project(join(root, 'read-failure'));
    const statFailure = await project(join(root, 'stat-failure'));
    const good = await project(join(root, 'good'));
    const beforeRead = await snapshot(readFailure);
    const beforeStat = await snapshot(statFailure);
    const readdir = fs.readdir.bind(fs);
    const lstat = fs.lstat.bind(fs);
    const rm = fs.rm.bind(fs);
    const denied = () => Object.assign(new Error('EACCES: injected size failure'), { code: 'EACCES' });
    t.mock.method(fs, 'readdir', async (path: string, options: never) => {
      if (path === readFailure) throw denied();
      return readdir(path, options);
    });
    t.mock.method(fs, 'lstat', async (path: string) => {
      if (path === join(statFailure, 'dependency.txt')) throw denied();
      return lstat(path);
    });
    t.mock.method(fs, 'rm', async (path: string, options: Parameters<typeof fs.rm>[1]) => {
      assert.equal(path, good, 'measurement failures must never reach removal');
      return rm(path, options);
    });
    const events: PruneEvent[] = [];
    const result = await prune(root, { dryRun, onEvent: (event) => events.push(event) });
    assert.equal(result.errors, 2);
    assert.equal(result.requiresSmite, 0);
    assert.equal(dryRun ? result.plannedBytes : result.deletedBytes, 21);
    assert.equal(dryRun ? result.planned : result.deleted, 1);
    assert.equal(events.filter((event) => event.kind === 'error' && event.reason?.includes('EACCES')).length, 2);
    t.mock.restoreAll();
    assert.deepEqual(await snapshot(readFailure), beforeRead);
    assert.deepEqual(await snapshot(statFailure), beforeStat);
    assert.equal(await exists(good), dryRun);
  });
}

test('partial removal failures contribute no freed bytes or successful removal count', async (t) => {
  const root = await fixture(t);
  const bad = await project(join(root, 'bad'));
  await fs.writeFile(join(bad, 'another-file'), Buffer.alloc(100));
  const good = await project(join(root, 'good'));
  const rm = fs.rm.bind(fs);
  t.mock.method(fs, 'rm', async (path: string, options: Parameters<typeof fs.rm>[1]) => {
    if (path === bad) {
      await fs.unlink(join(bad, 'dependency.txt'));
      throw new Error('injected partial rm failure');
    }
    return rm(path, options);
  });
  const result = await prune(root);
  assert.equal(result.errors, 1);
  assert.equal(result.deleted, 1);
  assert.equal(result.deletedBytes, 21);
  assert.equal(result.requiresSmite, 0);
  assert.equal(await exists(bad), true);
  assert.equal(await exists(good), false);
});

for (const replaceAncestor of [false, true]) {
  test(`fresh post-measurement checks reject ${replaceAncestor ? 'ancestor' : 'candidate'} replacement`, async (t) => {
    const root = await fixture(t);
    const scan = join(root, 'scan');
    const parent = join(scan, 'project');
    const modules = await project(parent);
    const externalParent = join(root, 'external');
    const external = await project(externalParent);
    const before = await snapshot(externalParent);
    const lstat = fs.lstat.bind(fs);
    let markerChecks = 0;
    t.mock.method(fs, 'lstat', async (path: string) => {
      const stat = await lstat(path);
      if (path === join(parent, 'package.json') && ++markerChecks === 2) {
        const replaced = replaceAncestor ? parent : modules;
        await fs.rename(replaced, `${replaced}-moved`);
        await fs.symlink(replaceAncestor ? externalParent : external, replaced);
      }
      return stat;
    });
    const rm = t.mock.method(fs, 'rm', () => { throw new Error('unsafe removal attempted'); });
    const result = await prune(scan);
    assert.equal(markerChecks, 2, 'swap occurs after measurement at the second eligibility check');
    assert.equal(result.errors, 1);
    assert.equal(result.deletedBytes, 0);
    assert.equal(result.deleted, 0);
    assert.equal(result.requiresSmite, 0);
    assert.equal(rm.mock.callCount(), 0);
    assert.deepEqual(await snapshot(externalParent), before);
  });
}

test('size traversal rejects an internal directory swapped after lstat, before it is read', async (t) => {
  const root = await fixture(t);
  const scan = join(root, 'scan');
  const modules = await project(scan);
  const nested = join(modules, 'nested');
  await fs.mkdir(nested);
  const outside = await project(join(root, 'outside'));
  const lstat = fs.lstat.bind(fs);
  const readdir = fs.readdir.bind(fs);
  let swapped = false;
  t.mock.method(fs, 'lstat', async (path: string) => {
    const stat = await lstat(path);
    if (path === nested && !swapped) {
      swapped = true;
      await fs.rename(nested, `${nested}-moved`);
      await fs.symlink(outside, nested);
    }
    return stat;
  });
  t.mock.method(fs, 'readdir', async (path: string, options: never) => {
    assert.notEqual(path, nested, 'changed directory must never be read');
    return readdir(path, options);
  });
  const result = await prune(scan);
  assert.equal(result.errors, 1);
  assert.equal(result.deleted, 0);
  assert.equal(result.deletedBytes, 0);
  assert.equal(await exists(modules), true);
  assert.equal(await exists(join(outside, 'dependency.txt')), true);
});

test('smite still performs a fresh safety check after the size traversal finishes', async (t) => {
  const root = await fixture(t);
  const scan = join(root, 'scan');
  const modules = await project(scan);
  const outside = await project(join(root, 'outside'));
  const lstat = fs.lstat.bind(fs);
  const realpath = fs.realpath.bind(fs);
  let measured = false;
  let swapped = false;
  t.mock.method(fs, 'lstat', async (path: string) => {
    const stat = await lstat(path);
    if (path === join(modules, 'dependency.txt')) measured = true;
    return stat;
  });
  t.mock.method(fs, 'realpath', async (path: string) => {
    const canonical = await realpath(path);
    // Return the old value from measurement's final check, then swap the path.
    // Only the separate, post-measurement validation can detect this change.
    if (path === modules && measured && !swapped) {
      swapped = true;
      await fs.rename(modules, `${modules}-moved`);
      await fs.symlink(outside, modules);
    }
    return canonical;
  });
  const rm = t.mock.method(fs, 'rm', () => { throw new Error('unsafe removal attempted'); });
  const result = await prune(scan, { smite: true });
  assert.equal(swapped, true);
  assert.equal(result.errors, 1);
  assert.equal(result.deleted, 0);
  assert.equal(result.deletedBytes, 0);
  assert.equal(result.requiresSmite, 0);
  assert.equal(rm.mock.callCount(), 0);
  assert.equal(await exists(join(outside, 'dependency.txt')), true);
  assert.equal(await exists(`${modules}-moved`), true);
});

test('markers lost during measurement skip removal without counting measured bytes', async (t) => {
  const root = await fixture(t);
  const modules = await project(root);
  const readdir = fs.readdir.bind(fs);
  t.mock.method(fs, 'readdir', async (path: string, options: never) => {
    const entries = await readdir(path, options);
    if (path === modules) await fs.unlink(join(root, 'package.json'));
    return entries;
  });
  const result = await prune(root);
  assert.equal(result.deletedBytes, 0);
  assert.equal(result.skipped, 1);
  assert.equal(result.requiresSmite, 1);
  assert.equal(result.errors, 0);
  assert.equal(await exists(modules), true);
});

test('unsafe, errored, symlink and file candidates are not additional smite opportunities', async (t) => {
  const root = await fixture(t);
  const modules = await project(join(root, 'unsafe'));
  const badMarker = await project(join(root, 'bad-marker'));
  const unmarked = join(root, 'unmarked', 'node_modules');
  await fs.mkdir(unmarked, { recursive: true });
  await fs.symlink(unmarked, join(root, 'link'));
  await fs.mkdir(join(root, 'file'));
  await fs.writeFile(join(root, 'file', 'node_modules'), 'file');
  const lstat = fs.lstat.bind(fs);
  let checks = 0;
  t.mock.method(fs, 'lstat', async (path: string) => {
    if (path === join(badMarker, '..', 'package.json')) throw new Error('marker read failure');
    if (path === modules && ++checks === 2) {
      await fs.rename(modules, `${modules}-moved`);
      await fs.symlink(unmarked, modules);
    }
    assert.ok(!path.startsWith(unmarked + sep), 'ineligible tree must never be measured');
    return lstat(path);
  });
  const result = await prune(root);
  assert.equal(result.errors, 2);
  assert.equal(result.requiresSmite, 1);
  assert.equal(result.deletedBytes, 0);
  assert.equal(result.deleted, 0);
});