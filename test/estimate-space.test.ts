import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join, sep } from 'node:path';
import { test } from 'node:test';
import { prune } from '../src/prune.ts';
import type { PruneEvent } from '../src/prune.ts';
import { exists, fixture, project, snapshot } from './helpers.ts';

for (const estimateSpace of [undefined, false]) {
  for (const smite of [false, true]) {
    for (const dryRun of [false, true]) {
      test(`no size traversal with estimateSpace=${estimateSpace}, smite=${smite}, dryRun=${dryRun}`, async (t) => {
        const root = await fixture(t);
        const modules = await project(join(root, 'project'));
        await project(join(modules, 'nested-project'));
        if (smite) await fs.unlink(join(root, 'project', 'package.json'));
        const before = await snapshot(root);
        const readdir = fs.readdir.bind(fs);
        const lstat = fs.lstat.bind(fs);
        const rm = fs.rm.bind(fs);
        let sizeReads = 0;
        let sizeStats = 0;
        t.mock.method(fs, 'readdir', async (path: string, options: never) => {
          if (path === modules || path.startsWith(modules + sep)) {
            sizeReads++;
            throw new Error('size-only readdir failure');
          }
          return readdir(path, options);
        });
        t.mock.method(fs, 'lstat', async (path: string) => {
          if (path.startsWith(modules + sep)) {
            sizeStats++;
            throw new Error('size-only lstat failure');
          }
          return lstat(path);
        });
        const remove = t.mock.method(fs, 'rm', async (path: string, options: Parameters<typeof fs.rm>[1]) => {
          assert.equal(path, modules);
          assert.deepEqual(options, { recursive: true, force: false });
          return rm(path, options);
        });
        const reads = t.mock.method(fs, 'readFile', () => { throw new Error('must not read dependency contents'); });
        const events: PruneEvent[] = [];
        const result = await prune(root, { estimateSpace, smite, dryRun, onEvent: (event) => events.push(event) });
        assert.deepEqual([sizeReads, sizeStats, reads.mock.callCount()], [0, 0, 0]);
        assert.equal(remove.mock.callCount(), dryRun ? 0 : 1);
        assert.deepEqual(result, {
          deleted: dryRun ? 0 : 1, planned: dryRun ? 1 : 0, skipped: 0, errors: 0,
          deletedBytes: null, plannedBytes: null, requiresSmite: 0,
        });
        assert.deepEqual(events, [{ kind: dryRun ? 'planned' : 'deleted', path: modules, bytes: null }]);
        t.mock.restoreAll();
        assert.equal(await exists(modules), dryRun);
        if (dryRun) assert.deepEqual(await snapshot(root), before);
      });
    }
  }
}

test('an explicit candidate root is unread without opt-in; opt-in traverses and distinguishes measured zero', async (t) => {
  const root = await fixture(t);
  const modules = await project(root);
  const nested = join(modules, 'nested');
  await fs.mkdir(nested);
  await fs.writeFile(join(modules, 'dependency.txt'), '');
  await fs.writeFile(join(nested, 'empty'), '');
  const readdir = t.mock.method(fs, 'readdir');
  const lstat = t.mock.method(fs, 'lstat');
  const events: PruneEvent[] = [];
  const disabled = await prune(modules, { dryRun: true, onEvent: (event) => events.push(event) });
  assert.equal(readdir.mock.callCount(), 0);
  assert.equal(lstat.mock.calls.some(({ arguments: [path] }) => String(path).startsWith(modules + sep)), false);
  assert.equal(disabled.plannedBytes, null);
  const enabled = await prune(modules, { dryRun: true, estimateSpace: true, onEvent: (event) => events.push(event) });
  assert.deepEqual(readdir.mock.calls.map(({ arguments: [path] }) => path), [modules, nested]);
  assert.ok(lstat.mock.calls.some(({ arguments: [path] }) => path === join(nested, 'empty')));
  assert.equal(enabled.plannedBytes, 0);
  assert.equal(enabled.errors, 0);
  assert.deepEqual(events, [
    { kind: 'planned', path: modules, bytes: null },
    { kind: 'planned', path: modules, bytes: 0 },
  ]);
});

for (const dryRun of [false, true]) {
  test(`default pre-action marker recheck remains in place (dryRun=${dryRun})`, async (t) => {
    const root = await fixture(t);
    const modules = await project(root);
    const lstat = fs.lstat.bind(fs);
    let markerChecks = 0;
    t.mock.method(fs, 'lstat', async (path: string) => {
      if (path === join(root, 'package.json') && ++markerChecks === 2) await fs.unlink(path);
      return lstat(path);
    });
    const remove = t.mock.method(fs, 'rm', () => assert.fail('markers lost before action'));
    const result = await prune(root, { dryRun });
    assert.equal(markerChecks, 2);
    assert.equal(result.requiresSmite, 1);
    assert.equal(result.errors, 0);
    assert.equal(result.deleted + result.planned, 0);
    assert.equal(remove.mock.callCount(), 0);
    assert.equal(await exists(modules), true);
  });

  for (const smite of [false, true]) {
    test(`default final safety check rejects a changed candidate (smite=${smite}, dryRun=${dryRun})`, async (t) => {
      const root = await fixture(t);
      const scan = join(root, 'scan');
      const modules = await project(scan);
      const outside = await project(join(root, 'outside'));
      const before = await snapshot(outside);
      const realpath = fs.realpath.bind(fs);
      let checks = 0;
      t.mock.method(fs, 'realpath', async (path: string) => {
        const canonical = await realpath(path);
        if (path === modules && ++checks === 2) {
          await fs.rename(modules, `${modules}-moved`);
          await fs.symlink(outside, modules);
        }
        return canonical;
      });
      const remove = t.mock.method(fs, 'rm', () => assert.fail('unsafe removal attempted'));
      const result = await prune(scan, { smite, dryRun });
      assert.equal(checks, 2);
      assert.equal(result.errors, 1);
      assert.equal(result.deleted + result.planned, 0);
      assert.equal(result.requiresSmite, 0);
      assert.equal(remove.mock.callCount(), 0);
      assert.deepEqual(await snapshot(outside), before);
    });
  }
}