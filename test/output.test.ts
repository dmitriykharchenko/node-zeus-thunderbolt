import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
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

function capture(t: TestContext, isTTY = false, verbose = false, dryRun = false) {
  const writes: { stream: string; text: string }[] = [];
  const reporter = createReporter({
    verbose, dryRun,
    stdout: { isTTY, write: (text) => writes.push({ stream: 'out', text }) },
    stderr: { write: (text) => writes.push({ stream: 'err', text }) },
  });
  t.after(() => reporter.dispose());
  const output = () => writes.filter((write) => write.stream === 'out').map((write) => write.text).join('');
  return { writes, reporter, output };
}

test('TTY refreshes one line and finishes it with exactly one newline', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { reporter, writes, output } = capture(t, true);
  assert.equal(output(), '⠋ Estimated freed: 0 B | 0 removed | 0 require --smite');
  const first = { ...zero, deleted: 1, deletedBytes: 100 };
  const last = { ...first, deleted: 2, deletedBytes: 300 };
  reporter.onEvent({ kind: 'deleted', path: '/fixture/a', bytes: 100 }, first);
  reporter.onEvent({ kind: 'deleted', path: '/fixture/b', bytes: 200 }, last);
  reporter.finish(last);
  assert.equal(writes.filter(({ text }) => text === '\r\x1b[2K').length, 3);
  assert.equal(output().split('\n').length, 2);
  assert.ok(output().endsWith('Estimated freed: 300 B | 2 removed | 0 require --smite\n'));
  assert.doesNotMatch(output(), /fixture/);
});

test('TTY clears progress before errors and resumes without corrupting the error line', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { reporter, writes, output } = capture(t, true);
  const first = { ...zero, deleted: 1, deletedBytes: 50 };
  reporter.onEvent({ kind: 'deleted', path: '/fixture/a', bytes: 50 }, first);
  reporter.onEvent({ kind: 'error', path: '/fixture/b', reason: 'EACCES' }, { ...first, errors: 1 });
  assert.deepEqual(writes.slice(-2), [
    { stream: 'out', text: '\r\x1b[2K' },
    { stream: 'err', text: 'error: "/fixture/b" — EACCES\n' },
  ]);
  const afterError = writes.length;
  t.mock.timers.tick(80);
  assert.deepEqual(writes.slice(afterError), [
    { stream: 'out', text: '⠙ Estimated freed: 50 B | 1 removed | 0 require --smite' },
  ], 'resume after the diagnostic newline without clearing its line');
  reporter.onEvent({ kind: 'error', path: '/fixture/c', reason: 'EIO' }, { ...first, errors: 2 });
  assert.deepEqual(writes.slice(-2), [
    { stream: 'out', text: '\r\x1b[2K' },
    { stream: 'err', text: 'error: "/fixture/c" — EIO\n' },
  ]);
  reporter.finish({ ...first, errors: 2 });
  assert.ok(output().endsWith('Estimated freed: 50 B | 1 removed | 0 require --smite\n'));
});

for (const isTTY of [false, true]) {
  test(`verbose reports paths, raw bytes, reasons and counts (TTY=${isTTY})`, (t) => {
    t.mock.method(globalThis, 'setInterval', () => assert.fail('verbose must not create a timer'));
    const { reporter, writes, output } = capture(t, isTTY, true, true);
    const summary = { ...zero, planned: 1, plannedBytes: 1536, skipped: 1, requiresSmite: 1, errors: 1 };
    reporter.onEvent({ kind: 'planned', path: '/fixture/with\nnewline', bytes: 1536 }, summary);
    reporter.onEvent({ kind: 'skipped', path: '/fixture/b', requiresSmite: true, reason: 'missing markers' }, summary);
    reporter.onEvent({ kind: 'error', path: '/fixture/c', reason: 'EIO' }, summary);
    reporter.finish(summary);
    assert.match(output(), /planned: "\/fixture\/with\\nnewline" — estimated 1.50 KiB \(1536 bytes\)/);
    assert.match(output(), /skipped:.*missing markers/);
    assert.match(output(), /Estimated would free: 1.50 KiB \| 1 planned \| 1 require --smite/);
    assert.match(output(), /0 deleted, 1 planned, 1 skipped, 1 errors/);
    assert.doesNotMatch(output(), /[\r\x1b⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]|error:/);
    assert.deepEqual(writes.filter(({ stream }) => stream === 'err'), [
      { stream: 'err', text: 'error: "/fixture/c" — EIO\n' },
    ]);
  });
}

test('piped dry-run progress is plain aggregate-only text and final zero state is always emitted', (t) => {
  t.mock.method(globalThis, 'setInterval', () => assert.fail('pipes must not create a timer'));
  const { reporter, output } = capture(t, false, false, true);
  reporter.onEvent({ kind: 'skipped', path: '/fixture/link', reason: 'symlink' }, { ...zero, skipped: 1 });
  assert.equal(output(), '');
  reporter.onEvent({ kind: 'skipped', path: '/fixture/a', requiresSmite: true }, { ...zero, requiresSmite: 1 });
  reporter.onEvent({ kind: 'planned', path: '/fixture/b', bytes: 7 }, { ...zero, planned: 1, plannedBytes: 7, requiresSmite: 1 });
  assert.equal(output(), 'Estimated would free: 0 B | 0 planned | 1 require --smite\n'
    + 'Estimated would free: 7 B | 1 planned | 1 require --smite\n');
  const summary = { ...zero, planned: 1, plannedBytes: 7, requiresSmite: 1 };
  reporter.finish(summary);
  assert.ok(output().endsWith('Estimated would free: 7 B | 1 planned | 1 require --smite\n'));
  const empty = capture(t);
  empty.reporter.finish(zero);
  assert.equal(empty.output(), 'Estimated freed: 0 B | 0 removed | 0 require --smite\n');
});

test('TTY cycles through Braille frames at 80 ms before any event and unrefs its timer', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const fakeInterval = globalThis.setInterval;
  const unref = t.mock.fn();
  const interval = t.mock.method(globalThis, 'setInterval', (...args) => {
    const timer = fakeInterval(...args);
    t.mock.method(timer, 'unref', unref);
    return timer;
  });
  const clear = t.mock.method(globalThis, 'clearInterval');
  const { reporter, writes } = capture(t, true);
  assert.equal(interval.mock.callCount(), 1);
  const timer = interval.mock.calls[0].result;
  assert.equal(unref.mock.callCount(), 1, 'animation must not keep the process alive');
  assert.equal(interval.mock.calls[0].arguments[1], 80);
  t.mock.timers.tick(79);
  assert.equal(writes.length, 1);
  t.mock.timers.tick(1);
  for (let i = 0; i < 9; i++) t.mock.timers.tick(80);
  assert.deepEqual(writes.filter(({ text }) => text !== '\r\x1b[2K').map(({ text }) => text),
    [...'⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⠋'].map((frame) => `${frame} Estimated freed: 0 B | 0 removed | 0 require --smite`));
  reporter.finish(zero);
  assert.equal(clear.mock.callCount(), 1);
  assert.equal(clear.mock.calls[0].arguments[0], timer);
  const finished = [...writes];
  t.mock.timers.tick(800);
  interval.mock.calls[0].arguments[0]();
  reporter.onEvent({ kind: 'deleted', path: '/late', bytes: 1 }, { ...zero, deleted: 1, deletedBytes: 1 });
  reporter.finish(zero);
  reporter.dispose();
  assert.deepEqual(writes, finished, 'no writes from ticks, late callbacks, events, or repeated cleanup');
});

for (const dryRun of [false, true]) {
  test(`TTY ticks retain current counters, including require-smite (dry-run=${dryRun})`, (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const { reporter, writes } = capture(t, true, false, dryRun);
    const summary = { ...zero, planned: 2, plannedBytes: 1536, deleted: 1, deletedBytes: 100, requiresSmite: 3 };
    reporter.onEvent({ kind: dryRun ? 'planned' : 'deleted', path: '/fixture/a', bytes: 100 }, summary);
    const totals = dryRun ? 'would free: 1.50 KiB | 2 planned' : 'freed: 100 B | 1 removed';
    for (const frame of '⠙⠹⠸') {
      t.mock.timers.tick(80);
      assert.equal(writes.at(-1)?.text, `${frame} Estimated ${totals} | 3 require --smite`);
    }
    reporter.finish(summary);
    assert.equal(writes.at(-1)?.text, `Estimated ${totals} | 3 require --smite\n`);
  });

  test(`a quick empty TTY scan ends with a static zero summary (dry-run=${dryRun})`, (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const { reporter, writes } = capture(t, true, false, dryRun);
    const message = `Estimated ${dryRun ? 'would free' : 'freed'}: 0 B | 0 ${dryRun ? 'planned' : 'removed'} | 0 require --smite`;
    reporter.finish(zero);
    t.mock.timers.tick(800);
    assert.deepEqual(writes, [
      { stream: 'out', text: `⠋ ${message}` },
      { stream: 'out', text: '\r\x1b[2K' },
      { stream: 'out', text: `${message}\n` },
    ]);
  });
}

test('dispose clears an interrupted line and stops all further output', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const clear = t.mock.method(globalThis, 'clearInterval');
  const { reporter, writes } = capture(t, true);
  t.mock.timers.tick(80);
  reporter.dispose();
  assert.equal(clear.mock.callCount(), 1);
  assert.equal(writes.at(-1)?.text, '\r\x1b[2K');
  const stopped = [...writes];
  t.mock.timers.tick(800);
  reporter.dispose();
  reporter.finish(zero);
  assert.deepEqual(writes, stopped);
});

for (const failure of ['initial', 'tick', 'finish', 'dispose']) {
  test(`output failure during ${failure} cannot leave an active timer`, (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const interval = t.mock.method(globalThis, 'setInterval');
    const clear = t.mock.method(globalThis, 'clearInterval');
    let fail = failure === 'initial';
    let writes = 0;
    const create = () => createReporter({
      stdout: { isTTY: true, write() { writes++; if (fail) throw new Error('broken output'); } },
      stderr: { write() {} },
    });
    if (failure === 'initial') {
      assert.throws(create, /broken output/);
      assert.equal(interval.mock.callCount(), 0);
    } else {
      const reporter = create();
      t.after(() => reporter.dispose());
      fail = true;
      assert.throws(() => {
        if (failure === 'tick') t.mock.timers.tick(80);
        else if (failure === 'finish') reporter.finish(zero);
        else reporter.dispose();
      }, /broken output/);
      assert.equal(clear.mock.callCount(), 1);
    }
    const stopped = writes;
    t.mock.timers.tick(800);
    assert.equal(writes, stopped);
  });
}