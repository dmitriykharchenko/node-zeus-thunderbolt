import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createReporter, formatBytes } from '../src/output.ts';
import type { PruneSummary } from '../src/prune.ts';

const zero: PruneSummary = {
  deleted: 0, planned: 0, skipped: 0, errors: 0,
  deletedBytes: 0, plannedBytes: 0, requiresSmite: 0,
};

test('binary size formatting covers zero and every unit boundary through TiB', () => {
  for (const [bytes, expected] of [
    [0, '0 B'], [1, '1 B'], [1023, '1023 B'], [1024, '1.00 KiB'],
    [1536, '1.50 KiB'], [1023 * 1024, '1023.00 KiB'],
    [1024 ** 2, '1.00 MiB'], [1024 ** 3, '1.00 GiB'],
    [1024 ** 4, '1.00 TiB'], [1.5 * 1024 ** 4, '1.50 TiB'],
    [1024 ** 5, '1024.00 TiB'],
  ] as const) assert.equal(formatBytes(bytes), expected);
});

function capture(isTTY = false, verbose = false, dryRun = false) {
  const writes: { stream: string; text: string }[] = [];
  const reporter = createReporter({
    verbose, dryRun,
    stdout: { isTTY, write: (text) => writes.push({ stream: 'out', text }) },
    stderr: { write: (text) => writes.push({ stream: 'err', text }) },
  });
  const output = () => writes.filter((write) => write.stream === 'out').map((write) => write.text).join('');
  return { writes, reporter, output };
}

test('TTY refreshes one line and finishes it with exactly one newline', () => {
  const { reporter, writes, output } = capture(true);
  const first = { ...zero, deleted: 1, deletedBytes: 100 };
  const last = { ...first, deleted: 2, deletedBytes: 300 };
  reporter.onEvent({ kind: 'deleted', path: '/fixture/a', bytes: 100 }, first);
  reporter.onEvent({ kind: 'deleted', path: '/fixture/b', bytes: 200 }, last);
  reporter.finish(last);
  assert.equal(writes.filter(({ text }) => text === '\r\x1b[2K').length, 2);
  assert.equal(output().split('\n').length, 2);
  assert.ok(output().endsWith('Estimated freed: 300 B | 2 removed | 0 require --smite\n'));
  assert.doesNotMatch(output(), /fixture/);
});

test('TTY clears progress before errors and resumes without corrupting the error line', () => {
  const { reporter, writes, output } = capture(true);
  const first = { ...zero, deleted: 1, deletedBytes: 50 };
  reporter.onEvent({ kind: 'deleted', path: '/fixture/a', bytes: 50 }, first);
  reporter.onEvent({ kind: 'error', path: '/fixture/b', reason: 'EACCES' }, { ...first, errors: 1 });
  assert.deepEqual(writes.slice(-2), [
    { stream: 'out', text: '\r\x1b[2K' },
    { stream: 'err', text: 'error: "/fixture/b" — EACCES\n' },
  ]);
  reporter.finish({ ...first, errors: 1 });
  assert.ok(output().endsWith('Estimated freed: 50 B | 1 removed | 0 require --smite\n'));
});

for (const isTTY of [false, true]) {
  test(`verbose reports paths, raw bytes, reasons and counts (TTY=${isTTY})`, () => {
    const { reporter, writes, output } = capture(isTTY, true, true);
    const summary = { ...zero, planned: 1, plannedBytes: 1536, skipped: 1, requiresSmite: 1, errors: 1 };
    reporter.onEvent({ kind: 'planned', path: '/fixture/with\nnewline', bytes: 1536 }, summary);
    reporter.onEvent({ kind: 'skipped', path: '/fixture/b', requiresSmite: true, reason: 'missing markers' }, summary);
    reporter.onEvent({ kind: 'error', path: '/fixture/c', reason: 'EIO' }, summary);
    reporter.finish(summary);
    assert.match(output(), /planned: "\/fixture\/with\\nnewline" — estimated 1.50 KiB \(1536 bytes\)/);
    assert.match(output(), /skipped:.*missing markers/);
    assert.match(output(), /Estimated would free: 1.50 KiB \| 1 planned \| 1 require --smite/);
    assert.match(output(), /0 deleted, 1 planned, 1 skipped, 1 errors/);
    assert.doesNotMatch(output(), /[\r\x1b]|error:/);
    assert.deepEqual(writes.filter(({ stream }) => stream === 'err'), [
      { stream: 'err', text: 'error: "/fixture/c" — EIO\n' },
    ]);
  });
}

test('piped dry-run progress is plain aggregate-only text and final zero state is always emitted', () => {
  const { reporter, output } = capture(false, false, true);
  reporter.onEvent({ kind: 'skipped', path: '/fixture/link', reason: 'symlink' }, { ...zero, skipped: 1 });
  assert.equal(output(), '');
  reporter.onEvent({ kind: 'skipped', path: '/fixture/a', requiresSmite: true }, { ...zero, requiresSmite: 1 });
  reporter.onEvent({ kind: 'planned', path: '/fixture/b', bytes: 7 }, { ...zero, planned: 1, plannedBytes: 7, requiresSmite: 1 });
  assert.equal(output(), 'Estimated would free: 0 B | 0 planned | 1 require --smite\n'
    + 'Estimated would free: 7 B | 1 planned | 1 require --smite\n');
  const empty = capture(true);
  empty.reporter.finish(zero);
  assert.equal(empty.output(), 'Estimated freed: 0 B | 0 removed | 0 require --smite\n');
});