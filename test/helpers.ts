import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import type { TestContext } from 'node:test';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

export async function fixture(t: TestContext): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'nzt-test-')));
  t.after(async () => {
    t.mock.restoreAll();
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

export async function project(path: string, lockfile = 'package-lock.json'): Promise<string> {
  const modules = join(path, 'node_modules');
  await fs.mkdir(modules, { recursive: true });
  await fs.writeFile(join(path, 'package.json'), 'contents are intentionally not parsed');
  await fs.writeFile(join(path, lockfile), 'lock');
  await fs.writeFile(join(modules, 'dependency.txt'), 'disposable dependency');
  await fs.writeFile(join(path, 'keep.txt'), 'keep');
  return modules;
}

export async function exists(path: string): Promise<boolean> {
  try {
    await fs.lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export function runCli(args: string[], cwd: string) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', timeout: 15_000 });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`CLI terminated by ${result.signal}`);
  return result;
}

export function runTtyCli(args: string[], cwd: string, entry = cli, unexpectedFailure = false): string[] {
  // Child-local stream/timer mocks exercise the actual entry point without a PTY or sleeps.
  const script = `
    import assert from 'node:assert/strict';
    import { promises as fs } from 'node:fs';
    import { mock } from 'node:test';
    mock.timers.enable({ apis: ['setInterval'] });
    const interval = mock.method(globalThis, 'setInterval');
    const clear = mock.method(globalThis, 'clearInterval');
    const writes = [];
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    mock.method(process.stdout, 'write', (text) => { writes.push(text); return true; });
    const readdir = fs.readdir;
    mock.method(fs, 'readdir', async (...args) => {
      mock.timers.tick(80);
      if (${unexpectedFailure}) throw new Error('injected scan failure');
      return readdir(...args);
    });
    process.argv = [process.execPath, ${JSON.stringify(entry)}, ...${JSON.stringify(args)}];
    if (${unexpectedFailure}) {
      const stderrWrite = process.stderr.write;
      mock.method(process.stderr, 'write', function (text, ...args) {
        if (String(text).startsWith('error:')) throw new Error('unexpected reporter failure');
        return stderrWrite.call(this, text, ...args);
      });
      await assert.rejects(import(${JSON.stringify(pathToFileURL(entry).href)}), /unexpected reporter failure/);
    } else {
      await import(${JSON.stringify(pathToFileURL(entry).href)});
    }
    assert.equal(interval.mock.callCount(), 1);
    assert.equal(clear.mock.callCount(), 1);
    assert.equal(clear.mock.calls[0].arguments[0], interval.mock.calls[0].result);
    const finished = [...writes];
    mock.timers.tick(800);
    interval.mock.calls[0].arguments[0]();
    assert.deepEqual(writes, finished, 'entry point must stop all later writes');
    mock.restoreAll();
    mock.timers.reset();
    process.stdout.write(JSON.stringify(writes));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd, encoding: 'utf8', timeout: 15_000,
  });
  if (result.error) throw result.error;
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

export async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(path: string, prefix: string) {
    for (const entry of await fs.readdir(path, { withFileTypes: true })) {
      const key = `${prefix}${entry.name}`;
      const child = join(path, entry.name);
      if (entry.isSymbolicLink()) result[key] = `link:${await fs.readlink(child)}`;
      else if (entry.isDirectory()) {
        result[`${key}/`] = 'directory';
        await walk(child, `${key}/`);
      } else result[key] = `file:${(await fs.readFile(child)).toString('base64')}`;
    }
  }
  await walk(root, '');
  return result;
}