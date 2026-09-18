import { promises as fs } from 'node:fs';
import type { Stats } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

export const lockfiles = [
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock',
  'pnpm-lock.yaml', 'bun.lock', 'bun.lockb',
] as const;

export type PruneEvent = {
  path: string;
  reason?: string;
} & (
  | { kind: 'deleted' | 'planned'; bytes: number | null }
  | { kind: 'skipped'; requiresSmite?: boolean }
  | { kind: 'error' }
);

export type PruneSummary = {
  deleted: number;
  planned: number;
  skipped: number;
  errors: number;
  deletedBytes: number | null;
  plannedBytes: number | null;
  requiresSmite: number;
};

export type PruneOptions = {
  smite?: boolean;
  dryRun?: boolean;
  estimateSpace?: boolean;
  onEvent?: (event: PruneEvent, summary: Readonly<PruneSummary>) => void;
};

type Directory = { path: string; stat: Stats; parent?: Directory };

function sameDirectory(actual: Stats, expected: Stats): boolean {
  return actual.isDirectory() && !actual.isSymbolicLink()
    && actual.dev === expected.dev && actual.ino === expected.ino;
}

async function regularFile(path: string): Promise<boolean> {
  try {
    return (await fs.lstat(path)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function eligible(parent: string): Promise<boolean> {
  if (!await regularFile(join(parent, 'package.json'))) return false;
  for (const name of lockfiles) {
    if (await regularFile(join(parent, name))) return true;
  }
  return false;
}

// Recheck the discovered path and ancestors before reading or removing it.
// Path-based filesystem APIs cannot make this atomic against concurrent renames.
async function assertUnchanged(directory: Directory): Promise<void> {
  const ancestors: Directory[] = [];
  for (let current: Directory | undefined = directory; current; current = current.parent) {
    ancestors.push(current);
  }
  for (const current of ancestors.reverse()) {
    if (!sameDirectory(await fs.lstat(current.path), current.stat)) {
      throw new Error(`Directory changed during scan: ${current.path}; retry with a stable tree`);
    }
  }
  if (await fs.realpath(directory.path) !== directory.path) {
    throw new Error('Directory path now resolves through a symlink; refusing to continue');
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// This is size traversal only, never discovery of nested pruning candidates.
async function measureBytes(candidate: Directory): Promise<number> {
  const pending = [candidate];
  let bytes = 0;
  while (pending.length > 0) {
    const directory = pending.pop()!;
    await assertUnchanged(directory);
    const entries = await fs.readdir(directory.path, { withFileTypes: true });
    for (const entry of entries) {
      await assertUnchanged(directory);
      const path = join(directory.path, entry.name);
      const stat = await fs.lstat(path);
      if (entry.isDirectory() && (!stat.isDirectory() || stat.isSymbolicLink())) {
        throw new Error(`Directory changed during size scan: ${path}; retry with a stable tree`);
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) pending.push({ path, stat, parent: directory });
      else if (stat.isFile()) bytes += stat.size;
    }
    await assertUnchanged(directory);
  }
  return bytes;
}

export async function prune(input: string, options: PruneOptions = {}): Promise<PruneSummary> {
  const summary: PruneSummary = {
    deleted: 0, planned: 0, skipped: 0, errors: 0,
    deletedBytes: options.estimateSpace ? 0 : null,
    plannedBytes: options.estimateSpace ? 0 : null, requiresSmite: 0,
  };
  const emit = (event: PruneEvent) => {
    if (event.kind === 'error') summary.errors++;
    else summary[event.kind]++;
    if (event.kind === 'deleted' && event.bytes !== null && summary.deletedBytes !== null) {
      summary.deletedBytes += event.bytes;
    }
    if (event.kind === 'planned' && event.bytes !== null && summary.plannedBytes !== null) {
      summary.plannedBytes += event.bytes;
    }
    if (event.kind === 'skipped' && event.requiresSmite) summary.requiresSmite++;
    options.onEvent?.(event, { ...summary });
  };

  let root: Directory;
  try {
    const path = resolve(input);
    const stat = await fs.lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('Starting path must be a real directory, not a file or symlink');
    }
    const canonical = await fs.realpath(path);
    if (dirname(canonical) === canonical) {
      throw new Error('Refusing to scan a filesystem root; choose a project directory');
    }
    for (let parent = dirname(canonical); dirname(parent) !== parent; parent = dirname(parent)) {
      if (basename(parent) === 'node_modules') {
        throw new Error('Starting path is inside node_modules; choose a project directory');
      }
    }
    root = { path: canonical, stat };
    await assertUnchanged(root);
  } catch (error) {
    emit({ kind: 'error', path: resolve(input), reason: errorMessage(error) });
    return summary;
  }

  const pending: Directory[] = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    try {
      await assertUnchanged(directory);
      if (basename(directory.path) === 'node_modules') {
        const withinRoot = relative(root.path, directory.path);
        if (withinRoot === '..' || withinRoot.startsWith(`..${sep}`)) {
          throw new Error('Candidate escaped the starting directory');
        }
        const skipMissingMarkers = () => emit({
          kind: 'skipped', path: directory.path, requiresSmite: true,
          reason: 'requires regular package.json and a recognized lockfile in its parent',
        });
        const canPrune = options.smite || await eligible(dirname(directory.path));
        await assertUnchanged(directory);
        if (!canPrune) {
          skipMissingMarkers();
          continue;
        }
        const bytes = options.estimateSpace ? await measureBytes(directory) : null;
        // Refresh marker and path safety before acting, including after optional measurement.
        const stillEligible = options.smite || await eligible(dirname(directory.path));
        await assertUnchanged(directory);
        if (!stillEligible) {
          skipMissingMarkers();
          continue;
        }
        if (options.dryRun) {
          emit({ kind: 'planned', path: directory.path, bytes });
        } else {
          await fs.rm(directory.path, { recursive: true, force: false });
          emit({ kind: 'deleted', path: directory.path, bytes });
        }
        continue;
      }

      const entries = await fs.readdir(directory.path, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink() && entry.name !== 'node_modules') continue;
        const path = join(directory.path, entry.name);
        try {
          const stat = await fs.lstat(path);
          if (stat.isSymbolicLink()) {
            emit({ kind: 'skipped', path, reason: 'symlink (not followed or removed)' });
          } else if (stat.isDirectory()) {
            pending.push({ path, stat, parent: directory });
          } else if (entry.name === 'node_modules') {
            emit({ kind: 'skipped', path, reason: 'not a directory' });
          }
        } catch (error) {
          emit({ kind: 'error', path, reason: errorMessage(error) });
        }
      }
    } catch (error) {
      emit({ kind: 'error', path: directory.path, reason: errorMessage(error) });
    }
  }
  return summary;
}