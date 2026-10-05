import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runMain } from './helpers/cli.ts';
import { createTestRepo } from './helpers/git-fixture.ts';
import { startHttpFixture } from './helpers/http-fixture.ts';
import { runGit, branchExists, branchCommit, worktreeList } from '../src/git.ts';
import { parseManifest } from '../src/manifest.ts';
import { readOperation } from '../src/operation.ts';
import { sha256 } from '../src/fsx.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI_PATH = path.join(REPO_ROOT, 'src', 'cli.ts');
const NO_CONFIG = path.join(os.tmpdir(), `wsg-add-noconfig-${process.pid}.yaml`);

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(
  args: string[],
  options: { cwd?: string; env?: Record<string, string | undefined> } = {}
): CliResult {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WSG_CONFIG: NO_CONFIG,
    ...options.env,
  };
  const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: options.cwd ?? REPO_ROOT,
    env,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

async function runCliInProcess(
  args: string[],
  options: { cwd?: string } = {}
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return runMain(args, {
    env: { ...process.env, WSG_CONFIG: NO_CONFIG },
    cwd: options.cwd,
  });
}

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function readManifest(wsDir: string) {
  return parseManifest(fs.readFileSync(path.join(wsDir, 'workspace.yaml'), 'utf8'));
}

test('add attaches a fourth repo without touching existing worktrees or branches', async () => {
  const repo1 = createTestRepo({ prefix: 'wsg-add-r1-' });
  const repo2 = createTestRepo({ prefix: 'wsg-add-r2-' });
  const repo3 = createTestRepo({ prefix: 'wsg-add-r3-' });
  const repo4 = createTestRepo({ prefix: 'wsg-add-r4-' });
  const root = mkTmp('wsg-add-root-');
  const wsDir = path.join(root, 'base');

  try {
    const created = await runCliInProcess([
      'create', 'base task', '--name', 'base', '--root', root,
      '--repo', repo1.dir, '--repo', repo2.dir, '--repo', repo3.dir,
    ]);
    assert.equal(created.exitCode, 0, created.stderr);

    const before = readManifest(wsDir);
    const beforeWts = new Map<string, ReturnType<typeof worktreeList>>();
    const beforeCommits = new Map<string, string | null>();
    for (const repo of before.repos) {
      beforeWts.set(repo.source, worktreeList(repo.source));
      beforeCommits.set(repo.branch, branchCommit(repo.source, repo.branch));
    }

    const added = await runCliInProcess([
      'add', repo4.dir, '--workspace', wsDir,
    ]);
    assert.equal(added.exitCode, 0, added.stderr);

    const after = readManifest(wsDir);
    assert.equal(after.repos.length, 4);

    // The new repo has a worktree and a branch at HEAD.
    const newRepo = after.repos.find((r) => r.source === fs.realpathSync(repo4.dir));
    assert.ok(newRepo, 'fourth repo must be recorded');
    assert.ok(branchExists(repo4.dir, newRepo!.branch));
    assert.equal(branchCommit(repo4.dir, newRepo!.branch), repo4.headCommit);
    assert.ok(fs.existsSync(path.join(wsDir, newRepo!.path)));

    // Existing worktrees, branches, and commits are untouched.
    for (const repo of before.repos) {
      assert.deepEqual(worktreeList(repo.source), beforeWts.get(repo.source));
      assert.equal(branchCommit(repo.source, repo.branch), beforeCommits.get(repo.branch));
    }
    assert.ok(!fs.existsSync(path.join(wsDir, 'docs', 'context.md.wsg-new')));
  } finally {
    for (const r of [repo1, repo2, repo3, repo4]) r.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('re-adding the same repo is a no-op and does not rewrite the manifest', async () => {
  const repo = createTestRepo({ prefix: 'wsg-add-noop-' });
  const root = mkTmp('wsg-add-noop-root-');
  const wsDir = path.join(root, 'base');

  try {
    const created = await runCliInProcess([
      'create', 'noop task', '--name', 'base', '--root', root, '--repo', repo.dir,
    ]);
    assert.equal(created.exitCode, 0, created.stderr);

    const manifestBefore = fs.readFileSync(path.join(wsDir, 'workspace.yaml'), 'utf8');
    const wtsBefore = worktreeList(repo.dir);

    const again = await runCliInProcess(['add', repo.dir, '--workspace', wsDir]);
    assert.equal(again.exitCode, 0, again.stderr);
    assert.match(again.stdout, /Nothing to add/);

    const manifestAfter = fs.readFileSync(path.join(wsDir, 'workspace.yaml'), 'utf8');
    assert.equal(manifestAfter, manifestBefore);
    assert.deepEqual(worktreeList(repo.dir), wtsBefore);
  } finally {
    repo.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('add resolves caller-relative paths against the current directory', async () => {
  const repo = createTestRepo({ prefix: 'wsg-add-relrepo-' });
  const root = mkTmp('wsg-add-rel-root-');
  const wsDir = path.join(root, 'base');
  const docDir = mkTmp('wsg-add-rel-doc-');
  const docPath = path.join(docDir, 'notes.md');
  fs.writeFileSync(docPath, '# Relative Notes\n', 'utf8');

  try {
    await runCliInProcess(['create', 'relative task', '--name', 'base', '--root', root, '--repo', repo.dir]);

    // Run from the document directory so `./notes.md` resolves there.
    const added = await runCliInProcess(
      ['add', './notes.md', '--workspace', wsDir],
      { cwd: docDir }
    );
    assert.equal(added.exitCode, 0, added.stderr);

    const manifest = readManifest(wsDir);
    const doc = manifest.docs.find((d) => d.source === fs.realpathSync(docPath));
    assert.ok(doc, 'document must be attached with a canonical source');
    assert.equal(doc!.mode, 'snapshot');
    assert.ok(fs.existsSync(path.join(wsDir, doc!.path!)));
  } finally {
    repo.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(docDir, { recursive: true, force: true });
  }
});

test('add resolves caller-relative repo paths and handles spaces in names', async () => {
  const parent = mkTmp('wsg add spaces -');
  const repo = createTestRepo({ prefix: 'wsg-add-spaced-src-' });
  const spacedRepo = path.join(parent, 'my repo');
  fs.renameSync(repo.dir, spacedRepo);
  const root = mkTmp('wsg-add-spaced-root-');
  const wsDir = path.join(root, 'base');

  try {
    const baseRepo = createTestRepo({ prefix: 'wsg-add-spaced-base-' });
    await runCliInProcess(['create', 'spaces task', '--name', 'base', '--root', root, '--repo', baseRepo.dir]);

    const added = await runCliInProcess(
      ['add', 'my repo', '--workspace', wsDir],
      { cwd: parent }
    );
    assert.equal(added.exitCode, 0, added.stderr);

    const manifest = readManifest(wsDir);
    const entry = manifest.repos.find((r) => r.source === fs.realpathSync(spacedRepo));
    assert.ok(entry, 'spaced repo must be attached');
    assert.ok(fs.existsSync(path.join(wsDir, entry!.path)), 'worktree must exist');
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('add deterministically avoids document and script filename collisions', async () => {
  const repo = createTestRepo({ prefix: 'wsg-add-collide-' });
  const root = mkTmp('wsg-add-collide-root-');
  const wsDir = path.join(root, 'base');
  const docDirA = mkTmp('wsg-add-collide-a-');
  const docDirB = mkTmp('wsg-add-collide-b-');
  fs.writeFileSync(path.join(docDirA, 'notes.md'), 'A\n', 'utf8');
  fs.writeFileSync(path.join(docDirB, 'notes.md'), 'B\n', 'utf8');
  const scriptA = path.join(docDirA, 'run.sh');
  const scriptB = path.join(docDirB, 'run.sh');
  fs.writeFileSync(scriptA, '#!/bin/sh\necho A\n', 'utf8');
  fs.writeFileSync(scriptB, '#!/bin/sh\necho B\n', 'utf8');

  try {
    await runCliInProcess(['create', 'collide task', '--name', 'base', '--root', root, '--repo', repo.dir]);

    const first = await runCliInProcess(['add', path.join(docDirA, 'notes.md'), '--workspace', wsDir]);
    assert.equal(first.exitCode, 0, first.stderr);
    const second = await runCliInProcess(['add', path.join(docDirB, 'notes.md'), '--workspace', wsDir]);
    assert.equal(second.exitCode, 0, second.stderr);

    const s1 = await runCliInProcess(['add', scriptA, '--as', 'script', '--workspace', wsDir]);
    assert.equal(s1.exitCode, 0, s1.stderr);
    const s2 = await runCliInProcess(['add', scriptB, '--as', 'script', '--workspace', wsDir]);
    assert.equal(s2.exitCode, 0, s2.stderr);

    const manifest = readManifest(wsDir);
    const docPaths = manifest.docs.filter((d) => d.mode === 'snapshot').map((d) => d.path!).sort();
    assert.equal(docPaths.length, 2);
    assert.notEqual(docPaths[0], docPaths[1]);
    assert.ok(docPaths.includes('docs/notes.md'), `expected plain notes.md in ${docPaths.join(', ')}`);
    assert.ok(
      docPaths.some((p) => /notes-[0-9a-f]{6}\.md$/.test(p)),
      `expected a deterministic collision suffix in ${docPaths.join(', ')}`
    );
    const scriptPaths = manifest.scripts.map((s) => s.path).sort();
    assert.equal(scriptPaths.length, 2);
    assert.notEqual(scriptPaths[0], scriptPaths[1]);
    assert.ok(scriptPaths.includes('scripts/run.sh'), `expected plain run.sh in ${scriptPaths.join(', ')}`);
    assert.ok(
      scriptPaths.some((p) => /run-[0-9a-f]{6}\.sh$/.test(p)),
      `expected a deterministic collision suffix in ${scriptPaths.join(', ')}`
    );
  } finally {
    repo.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(docDirA, { recursive: true, force: true });
    fs.rmSync(docDirB, { recursive: true, force: true });
  }
});

test('add --as script copies the script and never executes it', async () => {
  const repo = createTestRepo({ prefix: 'wsg-add-script-' });
  const root = mkTmp('wsg-add-script-root-');
  const wsDir = path.join(root, 'base');
  const scriptDir = mkTmp('wsg-add-script-src-');
  const marker = path.join(scriptDir, 'EXECUTED');
  const scriptPath = path.join(scriptDir, 'reproduce.sh');
  fs.writeFileSync(scriptPath, `#!/bin/sh\ntouch "${marker}"\n`, 'utf8');

  try {
    await runCliInProcess(['create', 'script task', '--name', 'base', '--root', root, '--repo', repo.dir]);
    const added = await runCliInProcess(['add', scriptPath, '--as', 'script', '--workspace', wsDir]);
    assert.equal(added.exitCode, 0, added.stderr);

    const manifest = readManifest(wsDir);
    assert.equal(manifest.scripts.length, 1);
    assert.equal(manifest.scripts[0].source, fs.realpathSync(scriptPath));
    assert.match(manifest.scripts[0].path, /^scripts\//);
    const copied = fs.readFileSync(path.join(wsDir, manifest.scripts[0].path), 'utf8');
    assert.equal(copied, fs.readFileSync(scriptPath, 'utf8'));
    assert.ok(!fs.existsSync(marker), 'attached script must never execute');

    const context = fs.readFileSync(path.join(wsDir, 'docs', 'context.md'), 'utf8');
    assert.match(context, /## Scripts \(attached, not executed\)/);
  } finally {
    repo.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(scriptDir, { recursive: true, force: true });
  }
});

test('add snapshots accessible public text and falls back to references', async () => {
  const repo = createTestRepo({ prefix: 'wsg-add-url-' });
  const root = mkTmp('wsg-add-url-root-');
  const wsDir = path.join(root, 'base');
  const server = await startHttpFixture();
  server.serve('/guide.md', '# Guide\nUseful text.\n', { 'content-type': 'text/markdown' });
  server.serve('/image.png', Buffer.from([0x89, 0x50]), { 'content-type': 'image/png' });
  server.serve('/missing', 'nope', { 'content-type': 'text/plain' }, 404);

  try {
    await runCliInProcess(['create', 'url task', '--name', 'base', '--root', root, '--repo', repo.dir]);

    const snap = await runCliInProcess(['add', `${server.baseUrl}/guide.md`, '--workspace', wsDir]);
    assert.equal(snap.exitCode, 0, snap.stderr);
    const ref = await runCliInProcess(['add', `${server.baseUrl}/missing`, '--workspace', wsDir]);
    assert.equal(ref.exitCode, 0, ref.stderr);
    const binary = await runCliInProcess(['add', `${server.baseUrl}/image.png`, '--workspace', wsDir]);
    assert.equal(binary.exitCode, 0, binary.stderr);
    const forced = await runCliInProcess([
      'add', `${server.baseUrl}/guide.md?ref=1`, '--as', 'reference', '--workspace', wsDir,
    ]);
    assert.equal(forced.exitCode, 0, forced.stderr);

    const manifest = readManifest(wsDir);
    const snapshot = manifest.docs.find((d) => d.source === `${server.baseUrl}/guide.md`);
    assert.ok(snapshot);
    assert.equal(snapshot!.mode, 'snapshot');
    assert.equal(
      fs.readFileSync(path.join(wsDir, snapshot!.path!), 'utf8'),
      '# Guide\nUseful text.\n'
    );
    const missing = manifest.docs.find((d) => d.source === `${server.baseUrl}/missing`);
    assert.equal(missing!.mode, 'reference');
    const nonText = manifest.docs.find((d) => d.source === `${server.baseUrl}/image.png`);
    assert.equal(nonText!.mode, 'reference');
    const forcedRef = manifest.docs.find((d) => d.source === `${server.baseUrl}/guide.md?ref=1`);
    assert.equal(forcedRef!.mode, 'reference');
  } finally {
    repo.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
    await server.close();
  }
});

test('add rejects a conflicting branch before any mutation', async () => {
  const baseRepo = createTestRepo({ prefix: 'wsg-add-pf-base-' });
  const newRepo = createTestRepo({ prefix: 'wsg-add-pf-new-' });
  const root = mkTmp('wsg-add-pf-root-');
  const wsDir = path.join(root, 'base');

  try {
    await runCliInProcess(['create', 'preflight task', '--name', 'base', '--root', root, '--repo', baseRepo.dir]);

    const entryName = path.basename(fs.realpathSync(newRepo.dir));
    const branch = `wsg/base/${entryName}`;
    runGit(['-C', newRepo.dir, 'branch', branch]);

    const result = await runCliInProcess(['add', newRepo.dir, '--workspace', wsDir]);
    assert.equal(result.exitCode, 2, result.stderr);
    assert.ok(!fs.existsSync(path.join(wsDir, entryName)), 'no worktree may be created on conflict');
    const manifest = readManifest(wsDir);
    assert.equal(manifest.repos.length, 1);
  } finally {
    baseRepo.cleanup();
    newRepo.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('add refuses to run while another process holds the writer lock', async () => {
  const repo = createTestRepo({ prefix: 'wsg-add-lock-' });
  const extra = createTestRepo({ prefix: 'wsg-add-lock-extra-' });
  const root = mkTmp('wsg-add-lock-root-');
  const wsDir = path.join(root, 'base');

  try {
    await runCliInProcess(['create', 'lock task', '--name', 'base', '--root', root, '--repo', repo.dir]);

    // Hold the lock in this process, then attempt an add in a subprocess.
    const { acquireLock, releaseLock } = await import('../src/operation.ts');
    const lock = acquireLock(wsDir, { opId: 'held-by-test' });
    try {
      const result = runCli(['add', extra.dir, '--workspace', wsDir]);
      assert.equal(result.status, 2, `expected conflict, got ${result.status}: ${result.stderr}`);
      assert.match(result.stderr, /lock/i);
      assert.ok(!fs.existsSync(path.join(wsDir, path.basename(extra.dir))));
    } finally {
      releaseLock(wsDir, lock);
    }
  } finally {
    repo.cleanup();
    extra.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('interrupted add resumes without duplicating the worktree', async () => {
  const baseRepo = createTestRepo({ prefix: 'wsg-add-resume-base-' });
  const newRepo = createTestRepo({ prefix: 'wsg-add-resume-new-' });
  const root = mkTmp('wsg-add-resume-root-');
  const wsDir = path.join(root, 'base');

  try {
    const created = runCli(['create', 'resume task', '--name', 'base', '--root', root, '--repo', baseRepo.dir]);
    assert.equal(created.status, 0, created.stderr);

    const interrupted = runCli(
      ['add', newRepo.dir, '--workspace', wsDir],
      { env: { WSG_FAULT: 'after-worktree:1' } }
    );
    assert.equal(interrupted.status, 70, interrupted.stderr);

    const entryName = path.basename(fs.realpathSync(newRepo.dir));
    assert.ok(fs.existsSync(path.join(wsDir, entryName)), 'worktree must exist after crash');
    assert.equal(worktreeList(newRepo.dir).filter((w) => w.branch === `wsg/base/${entryName}`).length, 1);

    const resumed = runCli(['add', newRepo.dir, '--workspace', wsDir, '--resume']);
    assert.equal(resumed.status, 0, resumed.stderr);

    const manifest = readManifest(wsDir);
    assert.equal(manifest.repos.length, 2);
    assert.equal(
      worktreeList(newRepo.dir).filter((w) => w.branch === `wsg/base/${entryName}`).length,
      1,
      'resume must not duplicate the worktree'
    );
    const op = readOperation(wsDir);
    assert.equal(op?.operation?.command, 'add');
    assert.equal(op?.operation?.status, 'complete');
  } finally {
    baseRepo.cleanup();
    newRepo.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('add appends explicit attachments and leaves repos untouched', async () => {
  const repo = createTestRepo({ prefix: 'wsg-add-append-' });
  const root = mkTmp('wsg-add-append-root-');
  const wsDir = path.join(root, 'base');
  const docDir = mkTmp('wsg-add-append-doc-');
  fs.writeFileSync(path.join(docDir, 'a.md'), 'A\n', 'utf8');
  fs.writeFileSync(path.join(docDir, 'b.md'), 'B\n', 'utf8');

  try {
    await runCliInProcess(['create', 'append task', '--name', 'base', '--root', root, '--repo', repo.dir]);
    const wtBefore = worktreeList(repo.dir);
    await runCliInProcess(['add', path.join(docDir, 'a.md'), '--workspace', wsDir]);
    await runCliInProcess(['add', path.join(docDir, 'b.md'), '--workspace', wsDir]);
    const manifest = readManifest(wsDir);
    assert.equal(manifest.repos.length, 1);
    assert.equal(manifest.docs.length, 2);
    assert.deepEqual(worktreeList(repo.dir), wtBefore);
    assert.equal(manifest.docs[0].sha256, sha256(Buffer.from('A\n')));
    assert.equal(manifest.docs[1].sha256, sha256(Buffer.from('B\n')));
  } finally {
    repo.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(docDir, { recursive: true, force: true });
  }
});

test('re-adding the same document is a no-op and canonical sources dedupe by realpath', async () => {
  const repo = createTestRepo({ prefix: 'wsg-add-docdedupe-' });
  const root = mkTmp('wsg-add-docdedupe-root-');
  const wsDir = path.join(root, 'base');
  const docDir = mkTmp('wsg-add-docdedupe-docs-');
  const docPath = path.join(docDir, 'notes.md');
  const aliasPath = path.join(docDir, 'alias.md');
  fs.writeFileSync(docPath, '# Notes\n', 'utf8');
  fs.symlinkSync(docPath, aliasPath);

  try {
    await runCliInProcess(['create', 'dedupe task', '--name', 'base', '--root', root, '--repo', repo.dir]);

    const first = await runCliInProcess(['add', docPath, '--workspace', wsDir]);
    assert.equal(first.exitCode, 0, first.stderr);
    const before = fs.readFileSync(path.join(wsDir, 'workspace.yaml'), 'utf8');

    // Same path again is a no-op.
    const again = await runCliInProcess(['add', docPath, '--workspace', wsDir]);
    assert.equal(again.exitCode, 0, again.stderr);
    assert.match(again.stdout, /Nothing to add/);
    assert.equal(fs.readFileSync(path.join(wsDir, 'workspace.yaml'), 'utf8'), before);

    // A symlink alias canonicalizes to the same source and is also a no-op.
    const alias = await runCliInProcess(['add', aliasPath, '--workspace', wsDir]);
    assert.equal(alias.exitCode, 0, alias.stderr);
    assert.match(alias.stdout, /Nothing to add/);

    const manifest = readManifest(wsDir);
    assert.equal(manifest.docs.length, 1);
    assert.equal(manifest.docs[0].source, fs.realpathSync(docPath));
  } finally {
    repo.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(docDir, { recursive: true, force: true });
  }
});

test('add uses deterministic suffixes for reserved names like context.md', async () => {
  const repo = createTestRepo({ prefix: 'wsg-add-reserved-' });
  const root = mkTmp('wsg-add-reserved-root-');
  const wsDir = path.join(root, 'base');
  const docDir = mkTmp('wsg-add-reserved-docs-');
  fs.writeFileSync(path.join(docDir, 'context.md'), '# Supplied context notes\n', 'utf8');

  try {
    await runCliInProcess(['create', 'reserved task', '--name', 'base', '--root', root, '--repo', repo.dir]);
    const added = await runCliInProcess(['add', path.join(docDir, 'context.md'), '--workspace', wsDir]);
    assert.equal(added.exitCode, 0, added.stderr);

    const manifest = readManifest(wsDir);
    assert.equal(manifest.docs.length, 1);
    assert.match(manifest.docs[0].path!, /^docs\/context-[0-9a-f]{6}\.md$/);
    assert.ok(fs.existsSync(path.join(wsDir, 'docs', 'context.md')), 'generated context remains');
    assert.ok(fs.existsSync(path.join(wsDir, manifest.docs[0].path!)), 'supplied doc preserved');
  } finally {
    repo.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(docDir, { recursive: true, force: true });
  }
});

test('interrupted add of a document resumes without losing the snapshot', async () => {
  const repo = createTestRepo({ prefix: 'wsg-add-resdoc-' });
  const root = mkTmp('wsg-add-resdoc-root-');
  const wsDir = path.join(root, 'base');
  const docDir = mkTmp('wsg-add-resdoc-docs-');
  const docPath = path.join(docDir, 'notes.md');
  fs.writeFileSync(docPath, '# Persisted\n', 'utf8');

  try {
    const created = runCli(['create', 'resdoc task', '--name', 'base', '--root', root, '--repo', repo.dir]);
    assert.equal(created.status, 0, created.stderr);

    const interrupted = runCli(
      ['add', docPath, '--workspace', wsDir],
      { env: { WSG_FAULT: 'after-generate:1' } }
    );
    assert.equal(interrupted.status, 70, interrupted.stderr);

    const resumed = runCli(['add', docPath, '--workspace', wsDir, '--resume']);
    assert.equal(resumed.status, 0, resumed.stderr);

    const manifest = readManifest(wsDir);
    assert.equal(manifest.docs.length, 1);
    assert.equal(manifest.docs[0].sha256, sha256(Buffer.from('# Persisted\n')));
    assert.equal(
      fs.readFileSync(path.join(wsDir, manifest.docs[0].path!), 'utf8'),
      '# Persisted\n'
    );
  } finally {
    repo.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(docDir, { recursive: true, force: true });
  }
});
