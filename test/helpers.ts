import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import type { TestContext } from 'node:test';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

export async function fixture(t: TestContext): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'node-modules-prune-test-')));
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