import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join, parse } from 'node:path';
import { test } from 'node:test';
import metadata from '../package.json' with { type: 'json' };
import { exists, fixture, project, runCli, runTtyCli, snapshot } from './helpers.ts';

test('help and version work without a path and do not mutate files', async (t) => {
  const root = await fixture(t);
  await project(root);
  const before = await snapshot(root);
  const help = runCli(['--help'], root);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage: nzt/);
  for (const flag of ['--smite', '--dry-run', '--verbose', '--help', '--version']) assert.ok(help.stdout.includes(flag));
  assert.match(help.stdout, /logical regular-file bytes/);
  assert.match(help.stdout, /Braille spinner/);
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
    ['--verbose'], ['--verbose=true', root], ['--verbose', '--verbose', root],
    ['--verbose', '--help'], ['--verbose', '--version'],
  ];
  for (const args of invalid) {
    const result = runCli(args, root);
    assert.equal(result.status, 2, JSON.stringify(args));
    assert.match(result.stderr, /Error:.*\nRun nzt --help/);
  }
  assert.deepEqual(await snapshot(root), before);
});

test('invalid starting paths are reported with a nonzero status and no mutations', async (t) => {
  const root = await fixture(t);
  await project(root);
  await fs.symlink(root, join(root, 'linked'));
  const before = await snapshot(root);
  for (const verbose of [[], ['--verbose']]) {
    for (const path of [join(root, 'missing'), join(root, 'keep.txt'), join(root, 'linked')]) {
      const result = runCli(['--smite', ...verbose, path], root);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /error:/);
      assert.ok(result.stderr.includes(JSON.stringify(path)));
      assert.match(result.stdout, /Estimated freed: 0 B \| 0 removed \| 0 require --smite/);
      if (verbose.length) assert.match(result.stdout, /0 deleted, 0 planned, 0 skipped, 1 errors/);
    }
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
  const preview = runCli(['folder with spaces', '--dry-run', '--verbose'], root);
  assert.equal(preview.status, 0, preview.stderr);
  assert.ok(preview.stdout.includes(`planned: ${JSON.stringify(modules)}`));
  assert.ok(preview.stdout.includes(`skipped: ${JSON.stringify(skipped)}`));
  assert.match(preview.stdout, /0 deleted, 1 planned, 1 skipped, 0 errors/);
  assert.match(preview.stdout, /estimated 21 B \(21 bytes\)/);
  assert.match(preview.stdout, /requires regular package.json/);
  assert.match(preview.stdout, /Estimated would free: 21 B \| 1 planned \| 1 require --smite/);
  assert.deepEqual(await snapshot(root), before);
  const deletion = runCli(['--verbose', 'folder with spaces'], root);
  assert.equal(deletion.status, 0, deletion.stderr);
  assert.ok(deletion.stdout.includes(`deleted: ${JSON.stringify(modules)}`));
  assert.match(deletion.stdout, /1 deleted, 0 planned, 1 skipped, 0 errors/);
  assert.match(deletion.stdout, /Estimated freed: 21 B \| 1 removed \| 1 require --smite/);
  assert.equal(await exists(modules), false);
  assert.equal(await exists(skipped), true);
  assert.equal(await fs.readFile(join(path, 'project', 'keep.txt'), 'utf8'), 'keep');
});

test('smite honors dry-run and -- permits paths beginning with a dash', async (t) => {
  const root = await fixture(t);
  const modules = join(root, '--project', 'node_modules');
  await fs.mkdir(modules, { recursive: true });
  const preview = runCli(['--smite', '--dry-run', '--verbose', '--', '--project'], root);
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /0 deleted, 1 planned/);
  assert.match(preview.stdout, /Estimated would free: 0 B \| 1 planned \| 0 require --smite/);
  assert.equal(await exists(modules), true);
  const deletion = runCli(['--smite', '--', '--project'], root);
  assert.equal(deletion.status, 0, deletion.stderr);
  assert.match(deletion.stdout, /Estimated freed: 0 B \| 1 removed \| 0 require --smite/);
  assert.equal(await exists(modules), false);
});

test('an empty scan succeeds with a zero summary', async (t) => {
  const root = await fixture(t);
  const result = runCli([root], root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'Estimated freed: 0 B | 0 removed | 0 require --smite\n');
  const preview = runCli(['--dry-run', root], root);
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(preview.stdout, 'Estimated would free: 0 B | 0 planned | 0 require --smite\n');
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
  assert.match(result.stdout, /Estimated freed: 21 B \| 1 removed \| 0 require --smite/);
  assert.equal(await exists(blockedModules), true);
  assert.equal(await exists(goodModules), false);
});

test('default pipes contain only increasing aggregate updates, never paths or terminal controls', async (t) => {
  const root = await fixture(t);
  const a = await project(join(root, 'a'));
  const b = await project(join(root, 'b'));
  await fs.writeFile(join(a, 'dependency.txt'), Buffer.alloc(100));
  await fs.writeFile(join(b, 'dependency.txt'), Buffer.alloc(200));
  for (const name of ['unmarked-a', 'unmarked-b']) {
    await fs.mkdir(join(root, name, 'node_modules'), { recursive: true });
  }
  await fs.symlink(a, join(root, 'link'));
  await fs.mkdir(join(root, 'file-candidate'));
  await fs.writeFile(join(root, 'file-candidate', 'node_modules'), 'not a directory');
  const before = await snapshot(root);
  for (const dryRun of [true, false]) {
    const result = runCli([...(dryRun ? ['--dry-run'] : []), root], root);
    assert.equal(result.status, 0, result.stderr);
    // Native TypeScript emits this runtime warning on the supported Node 23.6.0.
    assert.equal(result.stderr.replace(
      /\(node:\d+\) ExperimentalWarning: Type Stripping is an experimental feature and might change at any time\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\n/,
      '',
    ), '');
    assert.doesNotMatch(result.stdout, /[\r\x1b⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]|node_modules|skipped:|Summary:/);
    assert.ok(!result.stdout.includes(root));
    const lines = result.stdout.trim().split('\n');
    assert.equal(lines.length, 5, 'four candidates update progress before the final state');
    const totals = lines.map((line) => {
      const match = /^Estimated (?:would free|freed): (\d+) B \| (\d+) (?:planned|removed) \| (\d+) require --smite$/.exec(line);
      assert.ok(match, line);
      return match.slice(1).map(Number);
    });
    for (let i = 1; i < totals.length; i++) {
      for (let j = 0; j < 3; j++) assert.ok(totals[i][j] >= totals[i - 1][j]);
    }
    assert.deepEqual(totals.at(-1), [300, 2, 2]);
    assert.ok(totals.some(([, count]) => count === 1));
    if (dryRun) assert.deepEqual(await snapshot(root), before);
  }
});

test('size-read errors remain visible in both output modes and leave the failing tree intact', async (t) => {
  if (process.platform === 'win32' || process.getuid?.() === 0) {
    t.skip('POSIX permissions cannot be tested as root or on Windows');
    return;
  }
  for (const verbose of [false, true]) {
    for (const dryRun of [false, true]) {
      const root = await fixture(t);
      const blocked = await project(join(root, 'blocked'));
      const unreadable = join(blocked, 'unreadable');
      await fs.mkdir(unreadable);
      await fs.writeFile(join(unreadable, 'file'), Buffer.alloc(1000));
      const good = await project(join(root, 'good'));
      const before = await snapshot(blocked);
      await fs.chmod(unreadable, 0o000);
      let result: ReturnType<typeof runCli>;
      try {
        result = runCli([...(verbose ? ['--verbose'] : []), ...(dryRun ? ['--dry-run'] : []), root], root);
      } finally {
        await fs.chmod(unreadable, 0o700);
      }
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /error:.*EACCES/);
      assert.ok(result.stderr.includes(JSON.stringify(blocked)));
      assert.match(result.stdout, /Estimated (?:would free|freed): 21 B \| 1 (?:planned|removed) \| 0 require --smite/);
      assert.doesNotMatch(result.stdout, /[\r\x1b]|error:/);
      if (verbose) assert.match(result.stdout, /0 skipped, 1 errors/);
      else assert.ok(!result.stdout.includes(root));
      assert.deepEqual(await snapshot(blocked), before);
      assert.equal(await exists(good), dryRun);
    }
  }
});

for (const smite of [false, true]) {
  for (const dryRun of [false, true]) {
    test(`TTY spinner runs during scanning and measuring (smite=${smite}, dry-run=${dryRun})`, async (t) => {
      const root = await fixture(t);
      const modules = smite ? join(root, 'node_modules') : await project(root);
      if (smite) {
        await fs.mkdir(modules);
        await fs.writeFile(join(modules, 'dependency.txt'), 'disposable dependency');
      }
      const before = await snapshot(root);
      const args = [...(smite ? ['--smite'] : []), ...(dryRun ? ['--dry-run'] : []), root];
      const writes = runTtyCli(args, root);
      const verb = dryRun ? 'would free' : 'freed';
      const count = dryRun ? 'planned' : 'removed';
      for (const frame of '⠋⠙⠹') {
        assert.ok(writes.includes(`${frame} Estimated ${verb}: 0 B | 0 ${count} | 0 require --smite`));
      }
      assert.equal(writes.at(-1), `Estimated ${verb}: 21 B | 1 ${count} | 0 require --smite\n`);
      assert.equal(writes.join('').split('\n').length, 2);
      if (dryRun) assert.deepEqual(await snapshot(root), before);
      assert.equal(await exists(modules), dryRun);
    });
  }
}

test('CLI finally disposes progress when reporting an unexpected failure throws', async (t) => {
  const root = await fixture(t);
  await project(root);
  const before = await snapshot(root);
  const writes = runTtyCli(['--dry-run', root], root, undefined, true);
  assert.match(writes[0], /^⠋ Estimated would free: 0 B/);
  assert.equal(writes.at(-1), '\r\x1b[2K');
  assert.equal(writes.some((text) => text.endsWith('\n')), false, 'do not claim a completed summary');
  assert.deepEqual(await snapshot(root), before);
});