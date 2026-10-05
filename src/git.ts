import { spawnSync } from 'node:child_process';
import { UsageError } from './errors.ts';

export interface RunGitOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string | Buffer;
}

export function runGit(args: string[], options: RunGitOptions = {}): string {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    ...options.env,
  };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;

  if (process.env.WSG_DEBUG) {
    console.error(`[wsg git] git ${args.join(' ')}`);
  }

  const result = spawnSync('git', args, {
    cwd: options.cwd,
    env,
    input: options.input,
    encoding: 'utf8',
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const err = new Error(
      `git command failed (exit ${result.status}): git ${args.join(' ')}\n${result.stderr || result.stdout}`
    );
    Object.assign(err, {
      status: result.status,
      stderr: result.stderr,
      stdout: result.stdout,
    });
    throw err;
  }

  return result.stdout;
}

export function checkBranchName(name: string): boolean {
  if (!name || typeof name !== 'string') {
    return false;
  }
  if (name.includes('\0') || name.includes('\n')) {
    return false;
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
  };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;

  const result = spawnSync('git', ['check-ref-format', '--branch', name], {
    env,
    encoding: 'utf8',
  });

  return result.status === 0;
}
