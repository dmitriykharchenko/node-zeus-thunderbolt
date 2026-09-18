#!/usr/bin/env node
import metadata from '../package.json' with { type: 'json' };
import { prune } from './prune.ts';

const help = `Usage: node-modules-prune [--smite] [--dry-run] <directory>

Recursively remove node_modules when its immediate parent has regular files
named package.json and package-lock.json, npm-shrinkwrap.json, yarn.lock,
pnpm-lock.yaml, bun.lock, or bun.lockb. Dependency trees are never scanned.

  --smite     Remove node_modules even without manifest/lockfile markers
  --dry-run   Show what would be removed without deleting anything
  --help      Show this help
  --version   Show the version
  --          End options (for paths beginning with a dash)

Deletion is permanent. Preview with --dry-run first. Directory symlinks and
symlink candidates are skipped. Do not change the tree while pruning.
Filesystem roots and starting paths inside node_modules are refused.`;

function parseArguments(args: string[]) {
  const flags = new Set<string>();
  const paths: string[] = [];
  let optionsEnded = false;
  for (const arg of args) {
    if (!optionsEnded && arg === '--') {
      optionsEnded = true;
    } else if (!optionsEnded && arg.startsWith('-')) {
      if (!['--smite', '--dry-run', '--help', '--version'].includes(arg)) {
        throw new Error(`Unknown option: ${JSON.stringify(arg)}`);
      }
      if (flags.has(arg)) throw new Error(`Repeated option: ${arg}`);
      flags.add(arg);
    } else {
      paths.push(arg);
    }
  }
  if (flags.has('--help') || flags.has('--version')) {
    if (flags.size !== 1 || paths.length !== 0) {
      throw new Error('--help and --version must be used on their own');
    }
    return { info: flags.has('--help') ? help : metadata.version };
  }
  if (paths.length !== 1 || paths[0].length === 0) {
    throw new Error('Exactly one nonempty directory path is required');
  }
  return { path: paths[0], smite: flags.has('--smite'), dryRun: flags.has('--dry-run') };
}

async function main() {
  let args: ReturnType<typeof parseArguments>;
  try {
    args = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(`Error: ${(error as Error).message}\nRun node-modules-prune --help for usage.`);
    process.exitCode = 2;
    return;
  }
  if ('info' in args) {
    console.log(args.info);
    return;
  }
  const summary = await prune(args.path, {
    smite: args.smite,
    dryRun: args.dryRun,
    onEvent(event) {
      const message = `${event.kind}: ${JSON.stringify(event.path)}${event.reason ? ` — ${event.reason}` : ''}`;
      if (event.kind === 'error') console.error(message);
      else console.log(message);
    },
  });
  console.log(`Summary: ${summary.deleted} deleted, ${summary.planned} planned, ${summary.skipped} skipped, ${summary.errors} errors.`);
  process.exitCode = summary.errors > 0 ? 1 : 0;
}

await main();