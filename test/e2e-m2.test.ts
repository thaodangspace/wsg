import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTestRepo } from './helpers/git-fixture.ts';
import { runGit, branchExists } from '../src/git.ts';
import { parseManifest } from '../src/manifest.ts';
import { sha256 } from '../src/fsx.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI_PATH = path.join(REPO_ROOT, 'src', 'cli.ts');
const NO_CONFIG_PATH = path.join(
  os.tmpdir(),
  `wsg-test-e2e-noconfig-${process.pid}.yaml`
);

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

interface CliOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  removeOpenAI?: boolean;
}

function runCli(args: string[], options: CliOptions = {}): CliResult {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WSG_CONFIG: NO_CONFIG_PATH,
    ...options.env,
  };
  if (options.removeOpenAI) {
    delete env.OPENAI_API_KEY;
  }

  const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: options.cwd ?? REPO_ROOT,
    env,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

interface SourceSnapshot {
  status: string;
  head: string;
  branch: string;
}

function snapshotSource(dir: string): SourceSnapshot {
  return {
    status: runGit(['-C', dir, 'status', '--porcelain']),
    head: runGit(['-C', dir, 'rev-parse', 'HEAD']).trim(),
    branch: runGit(['-C', dir, 'symbolic-ref', '--short', 'HEAD']).trim(),
  };
}

test('M2 e2e: complete workspace lifecycle with sources untouched and storage-independent reads', () => {
  const repoA = createTestRepo({
    prefix: 'wsg-e2e-a-',
    files: {
      'package.json': JSON.stringify({
        name: 'repo-a',
        scripts: { postinstall: 'node install.js', test: 'sh test.sh' },
      }),
    },
  });
  const repoB = createTestRepo({ prefix: 'wsg-e2e-b-', dirty: true });

  // Give repository B a source path containing a space and non-ASCII bytes.
  const spacedParent = mkTmp('wsg e2e 空间 dir-');
  const spacedSource = path.join(spacedParent, 'repo-beta');
  fs.renameSync(repoB.dir, spacedSource);

  const docDir = mkTmp('wsg-e2e-doc-');
  const docPath = path.join(docDir, 'migration guide.md');
  const docContent = '# Migration Guide\nMove mono to modular.\n';
  fs.writeFileSync(docPath, docContent, 'utf8');

  const root = mkTmp('wsg-e2e-root-');
  const wsDir = path.join(root, 'e2e');
  const wsDir2 = path.join(root, 'e2e2');

  const beforeA = snapshotSource(repoA.dir);
  const beforeB = snapshotSource(spacedSource);
  const dirtyFile = path.join(spacedSource, 'dirty.txt');
  const dirtyBefore = fs.readFileSync(dirtyFile, 'utf8');

  try {
    const created = runCli(
      [
        '-p',
        'port EMR mono to modular',
        '--name',
        'e2e',
        '--root',
        root,
        '--repo',
        repoA.dir,
        '--repo',
        spacedSource,
        '--doc',
        docPath,
        '--for',
        'agents,claude',
      ],
      { removeOpenAI: true }
    );
    assert.equal(created.status, 0, `create failed: ${created.stderr}`);

    // --- Workspace contents are usable.
    const manifestPath = path.join(wsDir, 'workspace.yaml');
    const manifest = parseManifest(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.name, 'e2e');
    assert.equal(manifest.repos.length, 2);
    assert.equal(manifest.docs.length, 1);

    for (const repo of manifest.repos) {
      assert.ok(
        branchExists(repo.source, repo.branch),
        `branch ${repo.branch} must exist in ${repo.source}`
      );
      assert.ok(
        fs.existsSync(path.join(wsDir, repo.path)),
        `worktree ${repo.path} must exist`
      );
    }

    const snapshotPath = path.join(wsDir, 'docs', 'migration guide.md');
    assert.ok(fs.existsSync(snapshotPath), 'document snapshot must exist');
    assert.equal(sha256(fs.readFileSync(snapshotPath)), sha256(Buffer.from(docContent)));
    assert.equal(manifest.docs[0].sha256, sha256(Buffer.from(docContent)));

    const contextPath = path.join(wsDir, 'docs', 'context.md');
    const contextBefore = fs.readFileSync(contextPath, 'utf8');
    assert.match(contextBefore, /port EMR mono to modular/);
    for (const repo of manifest.repos) {
      assert.match(contextBefore, new RegExp(repo.name));
    }
    assert.ok(fs.existsSync(path.join(wsDir, 'AGENTS.md')));
    assert.ok(fs.existsSync(path.join(wsDir, 'CLAUDE.md')));
    assert.ok(fs.existsSync(path.join(wsDir, 'README.md')));

    // --- Source checkouts and dirty files are unchanged.
    assert.deepEqual(snapshotSource(repoA.dir), beforeA);
    assert.deepEqual(snapshotSource(spacedSource), beforeB);
    assert.equal(fs.readFileSync(dirtyFile, 'utf8'), dirtyBefore);

    // --- Remove runtime storage: explain and docs/context.md stay usable.
    fs.rmSync(path.join(wsDir, '.wsg'), { recursive: true, force: true });
    assert.ok(!fs.existsSync(path.join(wsDir, '.wsg')));

    const worktreeEntry = manifest.repos[0];
    const nested = path.join(wsDir, worktreeEntry.path, 'nested');
    fs.mkdirSync(nested, { recursive: true });

    const explained = runCli(['explain'], {
      cwd: nested,
      removeOpenAI: true,
    });
    assert.equal(explained.status, 0, `explain failed: ${explained.stderr}`);
    assert.match(explained.stdout, /Workspace: e2e/);
    assert.match(explained.stdout, /port EMR mono to modular/);
    for (const repo of manifest.repos) {
      assert.match(explained.stdout, new RegExp(repo.name));
    }

    const contextAfter = fs.readFileSync(contextPath, 'utf8');
    assert.equal(contextAfter, contextBefore, 'context must remain readable');

    // --- A second create from the same sources gets distinct branches.
    const second = runCli(
      [
        '-p',
        'port EMR mono to modular',
        '--name',
        'e2e2',
        '--root',
        root,
        '--repo',
        repoA.dir,
        '--repo',
        spacedSource,
        '--doc',
        docPath,
        '--for',
        'agents',
      ],
      { removeOpenAI: true }
    );
    assert.equal(second.status, 0, `second create failed: ${second.stderr}`);

    const manifest2 = parseManifest(
      fs.readFileSync(path.join(wsDir2, 'workspace.yaml'), 'utf8')
    );
    for (const repo of manifest2.repos) {
      const firstBranch = `wsg/e2e/${repo.name}`;
      assert.ok(
        branchExists(repo.source, repo.branch),
        `second branch ${repo.branch} must exist`
      );
      assert.ok(
        branchExists(repo.source, firstBranch),
        `first branch ${firstBranch} must still exist`
      );
      assert.notEqual(repo.branch, firstBranch, 'branches must be distinct');
    }
  } finally {
    repoA.cleanup();
    fs.rmSync(spacedParent, { recursive: true, force: true });
    fs.rmSync(docDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('M2 e2e: create executes no project npm/node/sh command', () => {
  const repo = createTestRepo({
    prefix: 'wsg-e2e-shim-',
    files: {
      'package.json': JSON.stringify({
        name: 'evil',
        scripts: { postinstall: 'node install.js', test: 'sh evil.sh' },
      }),
      'install.js':
        "require('fs').writeFileSync(require('path').join(__dirname, '.executed-node'), 'x');\n",
      'evil.sh': '#!/bin/sh\ntouch .executed-sh\n',
    },
  });

  const shimDir = mkTmp('wsg-e2e-shim-bin-');
  const logPath = path.join(mkTmp('wsg-e2e-shim-log-'), 'calls.log');
  for (const name of ['npm', 'node', 'sh']) {
    const shimPath = path.join(shimDir, name);
    fs.writeFileSync(
      shimPath,
      `#!/bin/sh\nprintf '%s %s\\n' "${name}" "$*" >> "${logPath}"\nexit 0\n`,
      { mode: 0o755 }
    );
    fs.chmodSync(shimPath, 0o755);
  }

  const root = mkTmp('wsg-e2e-shim-root-');

  try {
    const result = runCli(
      ['-p', 'shim task', '--name', 'shim', '--root', root, '--repo', repo.dir],
      {
        removeOpenAI: true,
        env: { PATH: `${shimDir}:${process.env.PATH ?? ''}` },
      }
    );
    assert.equal(result.status, 0, `create failed: ${result.stderr}`);

    const recorded = fs.existsSync(logPath)
      ? fs.readFileSync(logPath, 'utf8')
      : '';
    assert.equal(
      recorded,
      '',
      `no project command may run; shims recorded:\n${recorded}`
    );
    assert.ok(
      !fs.existsSync(path.join(repo.dir, '.executed-node')),
      'node project script must not run'
    );
    assert.ok(
      !fs.existsSync(path.join(repo.dir, '.executed-sh')),
      'sh project script must not run'
    );
  } finally {
    repo.cleanup();
    fs.rmSync(shimDir, { recursive: true, force: true });
    fs.rmSync(path.dirname(logPath), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
