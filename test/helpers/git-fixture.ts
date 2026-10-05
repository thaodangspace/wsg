import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runGit } from '../../src/git.ts';

export interface TestRepoOptions {
  prefix?: string;
  bare?: boolean;
  unborn?: boolean;
  dirty?: boolean;
  branch?: string;
  files?: Record<string, string>;
  submodules?: boolean;
  lfs?: boolean;
}

export interface TestRepo {
  dir: string;
  headCommit: string;
  headBranch: string;
  cleanup: () => void;
}

export function createTestRepo(options: TestRepoOptions = {}): TestRepo {
  const prefix = options.prefix ?? 'wsg-repo-';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));

  const cleanup = () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  };

  if (options.bare) {
    runGit(['init', '--bare', dir]);
    return {
      dir,
      headCommit: '',
      headBranch: '',
      cleanup,
    };
  }

  const branch = options.branch ?? 'main';
  runGit(['init', '-b', branch, dir]);
  runGit(['-C', dir, 'config', 'user.name', 'WSG Test']);
  runGit(['-C', dir, 'config', 'user.email', 'test@example.com']);

  if (options.unborn) {
    return {
      dir,
      headCommit: '',
      headBranch: branch,
      cleanup,
    };
  }

  const initialFiles: Record<string, string> = {
    'README.md': '# Test Repo\n',
    ...(options.files ?? {}),
  };

  if (options.submodules) {
    initialFiles['.gitmodules'] =
      '[submodule "dep"]\n\tpath = dep\n\turl = https://example.com/dep.git\n';
  }

  if (options.lfs) {
    initialFiles['.gitattributes'] =
      '*.bin filter=lfs diff=lfs merge=lfs -text\n';
  }

  for (const [relPath, content] of Object.entries(initialFiles)) {
    const fullPath = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf8');
  }

  runGit(['-C', dir, 'add', '.']);
  runGit(['-C', dir, 'commit', '-m', 'Initial commit']);

  const headCommit = runGit(['-C', dir, 'rev-parse', 'HEAD']).trim();

  if (options.dirty) {
    fs.writeFileSync(path.join(dir, 'dirty.txt'), 'uncommitted changes\n', 'utf8');
  }

  return {
    dir,
    headCommit,
    headBranch: branch,
    cleanup,
  };
}

/**
 * Helper to add a submodule entry to an existing test repo's .gitmodules.
 */
export function addTestSubmodule(repoDir: string, name: string = 'dep', url: string = 'https://example.com/dep.git'): void {
  const gitmodulesPath = path.join(repoDir, '.gitmodules');
  const entry = `[submodule "${name}"]\n\tpath = ${name}\n\turl = ${url}\n`;
  fs.appendFileSync(gitmodulesPath, entry, 'utf8');
}

/**
 * Helper to add a Git LFS filter entry to an existing test repo's .gitattributes.
 */
export function addTestLfsFilter(repoDir: string, pattern: string = '*.bin'): void {
  const gitattributesPath = path.join(repoDir, '.gitattributes');
  const entry = `${pattern} filter=lfs diff=lfs merge=lfs -text\n`;
  fs.appendFileSync(gitattributesPath, entry, 'utf8');
}

