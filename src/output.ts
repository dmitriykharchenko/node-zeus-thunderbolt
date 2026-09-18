import type { PruneEvent, PruneSummary } from './prune.ts';

export function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let unit = 0;
  let value = bytes;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(2)} ${units[unit]}`;
}

type Output = { write: (text: string) => unknown; isTTY?: boolean };

export function createReporter(options: {
  dryRun?: boolean;
  verbose?: boolean;
  stdout: Output;
  stderr: Output;
}) {
  const { stdout, stderr, dryRun, verbose } = options;
  const animated = stdout.isTTY && !verbose;
  const frames = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
  let frame = 0;
  let latest: Readonly<PruneSummary> = {
    deleted: 0, planned: 0, skipped: 0, errors: 0,
    deletedBytes: 0, plannedBytes: 0, requiresSmite: 0,
  };
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  let activeLine = false;
  const stop = () => {
    stopped = true;
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };
  const clearProgress = () => {
    const wasActive = activeLine;
    activeLine = false;
    if (wasActive) stdout.write('\r\x1b[2K');
  };
  const progress = (summary: Readonly<PruneSummary>, final = false) => {
    const bytes = dryRun ? summary.plannedBytes : summary.deletedBytes;
    const count = dryRun ? summary.planned : summary.deleted;
    const message = `Estimated ${dryRun ? 'would free' : 'freed'}: ${formatBytes(bytes)}`
      + ` | ${count} ${dryRun ? 'planned' : 'removed'} | ${summary.requiresSmite} require --smite`;
    if (animated) {
      clearProgress();
      stdout.write((final ? '' : `${frames[frame]} `) + message + (final ? '\n' : ''));
      activeLine = !final;
    } else {
      stdout.write(`${message}\n`);
    }
  };
  if (animated) {
    progress(latest);
    timer = setInterval(() => {
      if (stopped) return;
      frame = (frame + 1) % frames.length;
      try {
        progress(latest);
      } catch (error) {
        stop();
        throw error;
      }
    }, 80);
    timer.unref();
  }
  return {
    onEvent(event: PruneEvent, summary: Readonly<PruneSummary>) {
      if (stopped) return;
      latest = summary;
      if (event.kind === 'error' || verbose) {
        clearProgress();
        const size = 'bytes' in event ? ` — estimated ${formatBytes(event.bytes)} (${event.bytes} bytes)` : '';
        const reason = event.reason ? ` — ${event.reason}` : '';
        const message = `${event.kind}: ${JSON.stringify(event.path)}${size}${reason}\n`;
        (event.kind === 'error' ? stderr : stdout).write(message);
      }
      if (!verbose && (event.kind === 'deleted' || event.kind === 'planned'
        || (event.kind === 'skipped' && event.requiresSmite))) progress(summary);
    },
    finish(summary: Readonly<PruneSummary>) {
      if (stopped) return;
      stop();
      progress(summary, true);
      if (verbose) {
        stdout.write(`Summary: ${summary.deleted} deleted, ${summary.planned} planned, `
          + `${summary.skipped} skipped, ${summary.errors} errors.\n`);
      }
    },
    dispose() {
      stop();
      clearProgress();
    },
  };
}