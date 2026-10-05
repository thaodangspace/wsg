export type FaultPointName = 'after-lock' | 'after-worktree' | 'after-generate';

const faultCounters: Record<string, number> = {};

/**
 * Resets in-memory fault counters (useful for unit tests within the same process).
 */
export function resetFaultCounters(): void {
  for (const key of Object.keys(faultCounters)) {
    delete faultCounters[key];
  }
}

/**
 * Checks the WSG_FAULT environment variable and exits with code 70 on the target hit count.
 *
 * Format:
 *   WSG_FAULT=<name>[:<n>]
 *   - <name>: 'after-lock', 'after-worktree', 'after-generate'
 *   - <n>: positive integer hit count (default: 1)
 */
export function faultPoint(
  name: FaultPointName | string,
  env: Record<string, string | undefined> = process.env
): void {
  const faultEnv = env.WSG_FAULT;
  if (!faultEnv) {
    return;
  }

  const colonIdx = faultEnv.indexOf(':');
  const targetName = colonIdx === -1 ? faultEnv : faultEnv.slice(0, colonIdx);
  const countStr = colonIdx === -1 ? undefined : faultEnv.slice(colonIdx + 1);

  if (targetName !== name) {
    return;
  }

  let targetCount = 1;
  if (countStr !== undefined && countStr.length > 0) {
    const parsed = parseInt(countStr, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      targetCount = parsed;
    }
  }

  const currentCount = (faultCounters[name] ?? 0) + 1;
  faultCounters[name] = currentCount;

  if (currentCount === targetCount) {
    process.exit(70);
  }
}
