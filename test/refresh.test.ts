import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMain } from './helpers/cli.ts';
import { createTestRepo } from './helpers/git-fixture.ts';
import { startHttpFixture } from './helpers/http-fixture.ts';
import { branchCommit, worktreeList } from '../src/git.ts';
import { parseManifest, serializeManifest, type Manifest } from '../src/manifest.ts';
import { sha256 } from '../src/fsx.ts';
import { runRefresh } from '../src/refresh.ts';
import { acquireLock, releaseLock } from '../src/operation.ts';
import { ConflictError } from '../src/errors.ts';

const NO_CONFIG = path.join(os.tmpdir(), `wsg-refresh-noconfig-${process.pid}.yaml`);

async function runCli(
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

function readManifest(wsDir: string): Manifest {
  return parseManifest(fs.readFileSync(path.join(wsDir, 'workspace.yaml'), 'utf8'));
}

interface Fixture {
  repo: ReturnType<typeof createTestRepo>;
  root: string;
  wsDir: string;
  docDir: string;
  docPath: string;
  cleanup: () => void;
}

async function setupWorkspace(docContent: string, extra: { adapters?: string } = {}): Promise<Fixture> {
  const repo = createTestRepo({ prefix: 'wsg-refresh-repo-' });
  const root = mkTmp('wsg-refresh-root-');
  const wsDir = path.join(root, 'base');
  const docDir = mkTmp('wsg-refresh-doc-');
  const docPath = path.join(docDir, 'guide.md');
  fs.writeFileSync(docPath, docContent, 'utf8');

  const result = await runCli([
    '-p', 'refresh task', '--name', 'base', '--root', root,
    '--repo', repo.dir, '--doc', docPath, '--for', extra.adapters ?? 'agents',
  ]);
  assert.equal(result.exitCode, 0, result.stderr);

  return {
    repo, root, wsDir, docDir, docPath,
    cleanup: () => {
      repo.cleanup();
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(docDir, { recursive: true, force: true });
    },
  };
}

test('refresh updates a changed source document and regenerates context', async () => {
  const fx = await setupWorkspace('# Guide v1\n');
  try {
    fs.writeFileSync(fx.docPath, '# Guide v2\nchanged\n', 'utf8');
    const result = await runCli(['refresh'], { cwd: fx.wsDir });
    assert.equal(result.exitCode, 0, result.stderr);

    const manifest = readManifest(fx.wsDir);
    assert.equal(manifest.docs[0].sha256, sha256(Buffer.from('# Guide v2\nchanged\n')));
    assert.equal(
      fs.readFileSync(path.join(fx.wsDir, manifest.docs[0].path!), 'utf8'),
      '# Guide v2\nchanged\n'
    );
    const context = fs.readFileSync(path.join(fx.wsDir, 'docs', 'context.md'), 'utf8');
    assert.match(context, /docs\/guide\.md/);
  } finally {
    fx.cleanup();
  }
});

test('refresh preserves a user-edited snapshot when the source is unchanged', async () => {
  const fx = await setupWorkspace('# Guide v1\n');
  try {
    const snapshotPath = path.join(fx.wsDir, 'docs', 'guide.md');
    fs.writeFileSync(snapshotPath, '# USER EDIT\n', 'utf8');

    const result = await runCli(['refresh'], { cwd: fx.wsDir });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(fs.readFileSync(snapshotPath, 'utf8'), '# USER EDIT\n');
    assert.ok(!fs.existsSync(`${snapshotPath}.wsg-new`), 'no proposal when source is unchanged');

    const manifest = readManifest(fx.wsDir);
    assert.equal(manifest.docs[0].sha256, sha256(Buffer.from('# Guide v1\n')));
  } finally {
    fx.cleanup();
  }
});

test('refresh never silently overwrites an edited snapshot when the source also changed', async () => {
  const fx = await setupWorkspace('# Guide v1\n');
  try {
    const snapshotPath = path.join(fx.wsDir, 'docs', 'guide.md');
    fs.writeFileSync(snapshotPath, '# USER EDIT\n', 'utf8');
    fs.writeFileSync(fx.docPath, '# Guide v2\n', 'utf8');

    const result = await runCli(['refresh'], { cwd: fx.wsDir });
    assert.equal(result.exitCode, 3, result.stderr);
    assert.equal(fs.readFileSync(snapshotPath, 'utf8'), '# USER EDIT\n', 'user edit preserved');
    assert.equal(
      fs.readFileSync(`${snapshotPath}.wsg-new`, 'utf8'),
      '# Guide v2\n',
      'proposal holds new source bytes'
    );
    const manifest = readManifest(fx.wsDir);
    assert.equal(manifest.docs[0].sha256, sha256(Buffer.from('# Guide v1\n')));
  } finally {
    fx.cleanup();
  }
});

test('refresh preserves edited generated files and writes .wsg-new proposals', async () => {
  const fx = await setupWorkspace('# Guide v1\n');
  try {
    const contextPath = path.join(fx.wsDir, 'docs', 'context.md');
    fs.writeFileSync(contextPath, '# My Context\nkeep me\n', 'utf8');
    fs.writeFileSync(fx.docPath, '# Guide v2\n', 'utf8');

    const result = await runCli(['refresh'], { cwd: fx.wsDir });
    assert.equal(result.exitCode, 3, result.stderr);
    assert.equal(fs.readFileSync(contextPath, 'utf8'), '# My Context\nkeep me\n');
    assert.ok(fs.existsSync(`${contextPath}.wsg-new`), 'context proposal must exist');
    // The snapshot itself was untouched and updated.
    assert.equal(
      fs.readFileSync(path.join(fx.wsDir, 'docs', 'guide.md'), 'utf8'),
      '# Guide v2\n'
    );
  } finally {
    fx.cleanup();
  }
});

test('refresh preserves an edited adapter and writes a .wsg-new proposal', async () => {
  const fx = await setupWorkspace('# Guide v1\n');
  try {
    const adapterPath = path.join(fx.wsDir, 'AGENTS.md');
    const original = fs.readFileSync(adapterPath, 'utf8');
    fs.writeFileSync(adapterPath, `${original}\nMy local policy.\n`, 'utf8');
    fs.writeFileSync(fx.docPath, '# Guide v2\n', 'utf8');

    const result = await runCli(['refresh'], { cwd: fx.wsDir });
    assert.equal(result.exitCode, 3, result.stderr);
    assert.match(fs.readFileSync(adapterPath, 'utf8'), /My local policy\./);
    assert.ok(fs.existsSync(`${adapterPath}.wsg-new`), 'adapter proposal must exist');
  } finally {
    fx.cleanup();
  }
});

test('refresh retains the last snapshot and returns partial on a failed fetch', async () => {
  const repo = createTestRepo({ prefix: 'wsg-refresh-fetch-' });
  const root = mkTmp('wsg-refresh-fetch-root-');
  const wsDir = path.join(root, 'base');
  const server = await startHttpFixture();
  server.serve('/doc.md', '# Remote v1\n', { 'content-type': 'text/markdown' });

  try {
    await runCli(['-p', 'fetch task', '--name', 'base', '--root', root, '--repo', repo.dir]);
    const added = await runCli(['add', `${server.baseUrl}/doc.md`, '--workspace', wsDir], { cwd: wsDir });
    assert.equal(added.exitCode, 0, added.stderr);

    const before = readManifest(wsDir);
    const doc = before.docs.find((d) => d.source === `${server.baseUrl}/doc.md`)!;
    const snapshotPath = path.join(wsDir, doc.path!);
    const contentBefore = fs.readFileSync(snapshotPath, 'utf8');

    await server.close();

    const refreshed = await runCli(['refresh'], { cwd: wsDir });
    assert.equal(refreshed.exitCode, 3, refreshed.stderr);
    assert.equal(fs.readFileSync(snapshotPath, 'utf8'), contentBefore, 'snapshot retained');

    const after = readManifest(wsDir);
    const docAfter = after.docs.find((d) => d.source === `${server.baseUrl}/doc.md`)!;
    assert.equal(docAfter.mode, 'snapshot');
    assert.equal(docAfter.sha256, doc.sha256, 'manifest hash retained');
    assert.match(refreshed.stdout, /retained/);
  } finally {
    repo.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
    await server.close().catch(() => undefined);
  }
});

test('refresh upgrades a readable reference to a snapshot', async () => {
  const repo = createTestRepo({ prefix: 'wsg-refresh-upgrade-' });
  const root = mkTmp('wsg-refresh-upgrade-root-');
  const wsDir = path.join(root, 'base');
  const server = await startHttpFixture();
  server.serve('/wiki', 'Reference body\n', { 'content-type': 'text/plain' });

  try {
    await runCli(['-p', 'upgrade task', '--name', 'base', '--root', root, '--repo', repo.dir]);
    const added = await runCli(
      ['add', `${server.baseUrl}/wiki`, '--as', 'reference', '--workspace', wsDir],
      { cwd: wsDir }
    );
    assert.equal(added.exitCode, 0, added.stderr);
    let manifest = readManifest(wsDir);
    const ref = manifest.docs.find((d) => d.source === `${server.baseUrl}/wiki`)!;
    assert.equal(ref.mode, 'reference');

    const refreshed = await runCli(['refresh'], { cwd: wsDir });
    assert.equal(refreshed.exitCode, 0, refreshed.stderr);
    manifest = readManifest(wsDir);
    const upgraded = manifest.docs.find((d) => d.source === `${server.baseUrl}/wiki`)!;
    assert.equal(upgraded.mode, 'snapshot');
    assert.ok(upgraded.path);
    assert.equal(fs.readFileSync(path.join(wsDir, upgraded.path!), 'utf8'), 'Reference body\n');
  } finally {
    repo.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
    await server.close();
  }
});

test('refresh with a selector updates only the selected document', async () => {
  const repo = createTestRepo({ prefix: 'wsg-refresh-select-' });
  const root = mkTmp('wsg-refresh-select-root-');
  const wsDir = path.join(root, 'base');
  const docDir = mkTmp('wsg-refresh-select-docs-');
  const aPath = path.join(docDir, 'a.md');
  const bPath = path.join(docDir, 'b.md');
  fs.writeFileSync(aPath, 'A1\n', 'utf8');
  fs.writeFileSync(bPath, 'B1\n', 'utf8');

  try {
    await runCli([
      '-p', 'select task', '--name', 'base', '--root', root,
      '--repo', repo.dir, '--doc', aPath, '--doc', bPath,
    ]);
    fs.writeFileSync(aPath, 'A2\n', 'utf8');
    fs.writeFileSync(bPath, 'B2\n', 'utf8');

    const result = await runCli(['refresh', 'docs/a.md'], { cwd: wsDir });
    assert.equal(result.exitCode, 0, result.stderr);

    const manifest = readManifest(wsDir);
    const a = manifest.docs.find((d) => d.source === fs.realpathSync(aPath))!;
    const b = manifest.docs.find((d) => d.source === fs.realpathSync(bPath))!;
    assert.equal(a.sha256, sha256(Buffer.from('A2\n')));
    assert.equal(b.sha256, sha256(Buffer.from('B1\n')), 'unselected doc untouched');
    assert.equal(fs.readFileSync(path.join(wsDir, b.path!), 'utf8'), 'B1\n');
  } finally {
    repo.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(docDir, { recursive: true, force: true });
  }
});

test('refresh never rescouts, prunes, or changes repository revisions', async () => {
  const repo1 = createTestRepo({ prefix: 'wsg-refresh-repos1-' });
  const repo2 = createTestRepo({ prefix: 'wsg-refresh-repos2-' });
  const root = mkTmp('wsg-refresh-repos-root-');
  const wsDir = path.join(root, 'base');
  const docDir = mkTmp('wsg-refresh-repos-doc-');
  fs.writeFileSync(path.join(docDir, 'notes.md'), 'notes v1\n', 'utf8');

  try {
    await runCli([
      '-p', 'repos task', '--name', 'base', '--root', root,
      '--repo', repo1.dir, '--repo', repo2.dir, '--doc', path.join(docDir, 'notes.md'),
    ]);
    const before = readManifest(wsDir);
    const wt1 = worktreeList(repo1.dir);
    const wt2 = worktreeList(repo2.dir);
    const commit1 = branchCommit(repo1.dir, before.repos.find((r) => r.source === fs.realpathSync(repo1.dir))!.branch);
    const commit2 = branchCommit(repo2.dir, before.repos.find((r) => r.source === fs.realpathSync(repo2.dir))!.branch);

    fs.writeFileSync(path.join(docDir, 'notes.md'), 'notes v2\n', 'utf8');
    const result = await runCli(['refresh'], { cwd: wsDir });
    assert.equal(result.exitCode, 0, result.stderr);

    const after = readManifest(wsDir);
    assert.equal(after.repos.length, before.repos.length);
    assert.deepEqual(after.repos, before.repos, 'repos untouched');
    assert.deepEqual(worktreeList(repo1.dir), wt1);
    assert.deepEqual(worktreeList(repo2.dir), wt2);
    assert.equal(branchCommit(repo1.dir, after.repos.find((r) => r.source === fs.realpathSync(repo1.dir))!.branch), commit1);
    assert.equal(branchCommit(repo2.dir, after.repos.find((r) => r.source === fs.realpathSync(repo2.dir))!.branch), commit2);
    // Explicit attachments remain.
    assert.equal(after.docs.length, 1);
  } finally {
    repo1.cleanup();
    repo2.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(docDir, { recursive: true, force: true });
  }
});

test('refresh restores a deleted snapshot from an unchanged source', async () => {
  const fx = await setupWorkspace('# Guide v1\n');
  try {
    const snapshotPath = path.join(fx.wsDir, 'docs', 'guide.md');
    fs.rmSync(snapshotPath);
    const result = await runCli(['refresh'], { cwd: fx.wsDir });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(fs.readFileSync(snapshotPath, 'utf8'), '# Guide v1\n');
  } finally {
    fx.cleanup();
  }
});

test('refresh reports a failed reference fetch as a partial result', async () => {
  const repo = createTestRepo({ prefix: 'wsg-refresh-reffail-' });
  const root = mkTmp('wsg-refresh-reffail-root-');
  const wsDir = path.join(root, 'base');
  const server = await startHttpFixture();
  server.serve('/page', 'body\n', { 'content-type': 'text/plain' });

  try {
    await runCli(['-p', 'reffail task', '--name', 'base', '--root', root, '--repo', repo.dir]);
    const url = `${server.baseUrl}/page`;
    const added = await runCli(['add', url, '--as', 'reference', '--workspace', wsDir], { cwd: wsDir });
    assert.equal(added.exitCode, 0, added.stderr);

    await server.close();
    const refreshed = await runCli(['refresh'], { cwd: wsDir });
    assert.equal(refreshed.exitCode, 3, refreshed.stderr);
    const manifest = readManifest(wsDir);
    const doc = manifest.docs.find((d) => d.source === url)!;
    assert.equal(doc.mode, 'reference', 'reference retained, not removed');
  } finally {
    repo.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
    await server.close().catch(() => undefined);
  }
});

test('refresh reports an unknown selector as invalid input', async () => {
  const fx = await setupWorkspace('# Guide v1\n');
  try {
    const result = await runCli(['refresh', 'docs/nope.md'], { cwd: fx.wsDir });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /No document matches/);
  } finally {
    fx.cleanup();
  }
});

function quietIo(cwd: string) {
  return {
    stdout: { write: () => true },
    stderr: { write: () => true },
    env: { ...process.env, WSG_CONFIG: NO_CONFIG },
    cwd,
  };
}

test('refresh refuses to publish over a manifest changed during the fetch', async () => {
  const repo = createTestRepo({ prefix: 'wsg-refresh-race-' });
  const root = mkTmp('wsg-refresh-race-root-');
  const wsDir = path.join(root, 'base');
  const manifestPath = path.join(wsDir, 'workspace.yaml');
  const server = await startHttpFixture();
  server.serve('/doc', 'body\n', { 'content-type': 'text/plain' });

  try {
    await runCli(['-p', 'race task', '--name', 'base', '--root', root, '--repo', repo.dir]);
    await runCli(['add', `${server.baseUrl}/doc`, '--as', 'reference', '--workspace', wsDir], { cwd: wsDir });

    await assert.rejects(
      () =>
        runRefresh(
          {
            selectors: [],
            workspace: wsDir,
            fetchImpl: (async () => {
              const manifest = parseManifest(fs.readFileSync(manifestPath, 'utf8'));
              manifest.context.push('external edit');
              fs.writeFileSync(manifestPath, serializeManifest(manifest), 'utf8');
              return new Response('remote body\n', {
                status: 200,
                headers: { 'content-type': 'text/plain' },
              });
            }) as unknown as typeof fetch,
          },
          quietIo(wsDir)
        ),
      (err: unknown) => err instanceof ConflictError
    );

    const after = readManifest(wsDir);
    assert.deepEqual(after.context, ['external edit'], 'external manifest edit preserved');
  } finally {
    repo.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
    await server.close();
  }
});

test('refresh never overwrites an untracked user file when upgrading a reference', async () => {
  const repo = createTestRepo({ prefix: 'wsg-refresh-upgrade-collision-' });
  const root = mkTmp('wsg-refresh-upgrade-collision-root-');
  const wsDir = path.join(root, 'base');
  const server = await startHttpFixture();
  server.serve('/wiki', 'Reference body\n', { 'content-type': 'text/plain' });

  try {
    await runCli(['-p', 'upgrade collision', '--name', 'base', '--root', root, '--repo', repo.dir]);
    await runCli(['add', `${server.baseUrl}/wiki`, '--as', 'reference', '--workspace', wsDir], { cwd: wsDir });

    const userFile = path.join(wsDir, 'docs', 'wiki.txt');
    fs.writeFileSync(userFile, 'USER WIKI\n', 'utf8');

    const refreshed = await runCli(['refresh'], { cwd: wsDir });
    assert.equal(refreshed.exitCode, 0, refreshed.stderr);

    assert.equal(fs.readFileSync(userFile, 'utf8'), 'USER WIKI\n', 'user file untouched');
    const manifest = readManifest(wsDir);
    const upgraded = manifest.docs.find((d) => d.source === `${server.baseUrl}/wiki`)!;
    assert.equal(upgraded.mode, 'snapshot');
    assert.notEqual(upgraded.path, 'docs/wiki.txt');
    assert.match(upgraded.path!, /wiki-[0-9a-f]{6}\.txt$/);
    assert.equal(fs.readFileSync(path.join(wsDir, upgraded.path!), 'utf8'), 'Reference body\n');
  } finally {
    repo.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
    await server.close();
  }
});

test('refresh times out a stalled body, retains the snapshot, and releases the lock', async () => {
  const repo = createTestRepo({ prefix: 'wsg-refresh-stall-' });
  const root = mkTmp('wsg-refresh-stall-root-');
  const wsDir = path.join(root, 'base');
  const server = await startHttpFixture();
  server.serve('/doc.md', 'remote v1\n', { 'content-type': 'text/markdown' });

  try {
    await runCli(['-p', 'stall task', '--name', 'base', '--root', root, '--repo', repo.dir]);
    await runCli(['add', `${server.baseUrl}/doc.md`, '--workspace', wsDir], { cwd: wsDir });

    const before = readManifest(wsDir);
    const doc = before.docs.find((d) => d.source === `${server.baseUrl}/doc.md`)!;
    const snapshotPath = path.join(wsDir, doc.path!);

    // Headers only, then stall forever.
    server.set('/doc.md', (_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/markdown');
      res.write('partial');
    });

    const code = await runRefresh(
      { selectors: [], workspace: wsDir, fetchTimeoutMs: 50 },
      quietIo(wsDir)
    );
    assert.equal(code, 3);
    assert.equal(fs.readFileSync(snapshotPath, 'utf8'), 'remote v1\n', 'snapshot retained');

    // The exact-token lock must have been released.
    const lock = acquireLock(wsDir, { opId: 'post-stall-check' });
    releaseLock(wsDir, lock);
  } finally {
    repo.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
    await server.close();
  }
});

test('refresh regenerates context and adapters for a workspace with no documents', async () => {
  const repo = createTestRepo({ prefix: 'wsg-refresh-nodoc-' });
  const root = mkTmp('wsg-refresh-nodoc-root-');
  const wsDir = path.join(root, 'base');
  const repoName = path.basename(fs.realpathSync(repo.dir));

  try {
    await runCli(['-p', 'nodoc task', '--name', 'base', '--root', root, '--repo', repo.dir]);
    assert.equal(readManifest(wsDir).docs.length, 0);

    // Unedited: regeneration is a clean no-op success.
    const clean = await runCli(['refresh'], { cwd: wsDir });
    assert.equal(clean.exitCode, 0, clean.stderr);
    const contextPath = path.join(wsDir, 'docs', 'context.md');
    const adapterPath = path.join(wsDir, 'AGENTS.md');
    assert.match(fs.readFileSync(contextPath, 'utf8'), new RegExp(repoName));

    // A change to the saved manifest (context/roles) is reflected by refresh.
    const manifestPath = path.join(wsDir, 'workspace.yaml');
    const saved = parseManifest(fs.readFileSync(manifestPath, 'utf8'));
    saved.context.push('SAVED CONTEXT');
    fs.writeFileSync(manifestPath, serializeManifest(saved), 'utf8');
    const reflected = await runCli(['refresh'], { cwd: wsDir });
    assert.equal(reflected.exitCode, 0, reflected.stderr);
    assert.match(fs.readFileSync(contextPath, 'utf8'), /SAVED CONTEXT/);

    // Edited generated files are preserved with proposals.
    fs.writeFileSync(contextPath, '# USER CONTEXT\n', 'utf8');
    fs.writeFileSync(adapterPath, '# USER ADAPTER\n', 'utf8');
    const edited = await runCli(['refresh'], { cwd: wsDir });
    assert.equal(edited.exitCode, 3, edited.stderr);
    assert.equal(fs.readFileSync(contextPath, 'utf8'), '# USER CONTEXT\n');
    assert.equal(fs.readFileSync(adapterPath, 'utf8'), '# USER ADAPTER\n');
    assert.ok(fs.existsSync(`${contextPath}.wsg-new`));
    assert.ok(fs.existsSync(`${adapterPath}.wsg-new`));
  } finally {
    repo.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
