import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMain } from './helpers/cli.ts';
import { createTestRepo } from './helpers/git-fixture.ts';
import { runGit, branchCommit, branchExists, worktreeList } from '../src/git.ts';
import { parseManifest } from '../src/manifest.ts';
import { readOperation } from '../src/operation.ts';
import { sha256 } from '../src/fsx.ts';
import { ExplicitScout } from '../src/scout.ts';

test('ExplicitScout returns selection when repos are provided', async () => {
  const scout = new ExplicitScout();
  const res = await scout.scout({
    request: 'test request',
    repos: ['/path/to/repo'],
    docs: ['/path/to/doc.md'],
  });
  assert.equal(res.kind, 'selection');
  if (res.kind === 'selection') {
    assert.equal(res.repos.length, 1);
    assert.equal(res.repos[0].source, '/path/to/repo');
    assert.equal(res.repos[0].reason, 'Explicit repository supplied by the user.');
    assert.equal(res.docs.length, 1);
  }
});

test('ExplicitScout returns none when no repos are provided', async () => {
  const scout = new ExplicitScout();
  const res = await scout.scout({
    request: 'test request',
    repos: [],
  });
  assert.equal(res.kind, 'none');
  if (res.kind === 'none') {
    assert.match(res.reason, /No repositories specified/);
  }
});

test('Happy path: 2 repos, 1 doc, --context, --for agents,claude', async () => {
  const repo1 = createTestRepo({ prefix: 'wsg-hp1-' });
  const repo2 = createTestRepo({ prefix: 'wsg-hp2-' });
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-root-'));
  const tmpDocDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-doc-'));
  const docPath = path.join(tmpDocDir, 'guide.md');
  const docContent = '# Migration Guide\nFollow these steps.\n';
  fs.writeFileSync(docPath, docContent, 'utf8');

  try {
    const result = await runMain([
      'create',
      'port EMR architecture',
      '--name',
      'port-emr',
      '--root',
      tmpRoot,
      '--repo',
      repo1.dir,
      '--repo',
      repo2.dir,
      '--doc',
      docPath,
      '--context',
      'Targeting modern Node.js and TypeScript',
      '--for',
      'agents,claude',
    ]);

    assert.equal(result.exitCode, 0, `Expected exit 0, got ${result.exitCode}: ${result.stderr}`);
    const wsDir = path.join(tmpRoot, 'port-emr');
    assert.ok(fs.existsSync(wsDir), 'Workspace directory must exist');

    // 1. Worktrees on wsg/<name>/<entry> at source HEAD
    const repo1Base = path.basename(repo1.dir);
    const repo2Base = path.basename(repo2.dir);

    const branch1 = `wsg/port-emr/${repo1Base}`;
    const branch2 = `wsg/port-emr/${repo2Base}`;

    assert.ok(branchExists(repo1.dir, branch1), `Branch ${branch1} must exist in repo1`);
    assert.ok(branchExists(repo2.dir, branch2), `Branch ${branch2} must exist in repo2`);

    assert.equal(branchCommit(repo1.dir, branch1), repo1.headCommit);
    assert.equal(branchCommit(repo2.dir, branch2), repo2.headCommit);

    const wt1List = worktreeList(repo1.dir);
    const wt2List = worktreeList(repo2.dir);
    assert.ok(
      wt1List.some(
        (wt) =>
          wt.branch === branch1 &&
          wt.worktree === fs.realpathSync(path.join(wsDir, repo1Base))
      ),
      'Worktree 1 must be registered in git worktree list'
    );
    assert.ok(
      wt2List.some(
        (wt) =>
          wt.branch === branch2 &&
          wt.worktree === fs.realpathSync(path.join(wsDir, repo2Base))
      ),
      'Worktree 2 must be registered in git worktree list'
    );

    // 2. Doc sha matches and snapshot file exists
    const snapshotPath = path.join(wsDir, 'docs', 'guide.md');
    assert.ok(fs.existsSync(snapshotPath), 'Snapshot document must exist');
    const actualDocSha = sha256(fs.readFileSync(snapshotPath));
    const expectedDocSha = sha256(Buffer.from(docContent, 'utf8'));
    assert.equal(actualDocSha, expectedDocSha);

    // 3. Manifest parses with added_by: user, intent: unspecified, evidence: [], FR5 reason
    const manifestPath = path.join(wsDir, 'workspace.yaml');
    assert.ok(fs.existsSync(manifestPath), 'workspace.yaml must exist');
    const manifestYaml = fs.readFileSync(manifestPath, 'utf8');
    const manifest = parseManifest(manifestYaml);

    assert.equal(manifest.name, 'port-emr');
    assert.equal(manifest.request.trim(), 'port EMR architecture');
    assert.deepEqual(manifest.context, ['Targeting modern Node.js and TypeScript']);
    assert.deepEqual(manifest.adapters, ['agents', 'claude']);
    assert.equal(manifest.repos.length, 2);

    for (const repo of manifest.repos) {
      assert.equal(repo.added_by, 'user');
      assert.equal(repo.intent, 'unspecified');
      assert.deepEqual(repo.evidence, []);
      assert.equal(repo.reason, 'Explicit repository supplied by the user.');
    }

    assert.equal(manifest.docs.length, 1);
    assert.equal(manifest.docs[0].mode, 'snapshot');
    assert.equal(manifest.docs[0].added_by, 'user');
    assert.equal(manifest.docs[0].sha256, expectedDocSha);
    assert.equal(manifest.docs[0].path, 'docs/guide.md');

    // 4. Both adapters exist
    assert.ok(fs.existsSync(path.join(wsDir, 'AGENTS.md')), 'AGENTS.md must exist');
    assert.ok(fs.existsSync(path.join(wsDir, 'CLAUDE.md')), 'CLAUDE.md must exist');
    assert.ok(fs.existsSync(path.join(wsDir, 'README.md')), 'README.md must exist');
    assert.ok(fs.existsSync(path.join(wsDir, 'docs', 'context.md')), 'docs/context.md must exist');

    // 5. Journal complete, owned has 4 files
    const opFile = readOperation(wsDir);
    assert.ok(opFile, 'Operation journal must exist');
    assert.ok(opFile.operation, 'Operation record must exist');
    assert.equal(opFile.operation.status, 'complete');
    assert.equal(opFile.operation.command, 'create');

    const ownedKeys = Object.keys(opFile.owned).sort();
    assert.deepEqual(ownedKeys, ['AGENTS.md', 'CLAUDE.md', 'README.md', 'docs/context.md'].sort());
    for (const key of ownedKeys) {
      assert.match(opFile.owned[key].sha256, /^[0-9a-f]{64}$/);
    }
  } finally {
    repo1.cleanup();
    repo2.cleanup();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(tmpDocDir, { recursive: true, force: true });
  }
});

test('Dirty source: stderr warning, source branch/content unchanged', async () => {
  const repo = createTestRepo({ prefix: 'wsg-dirty-', dirty: true });
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-root-'));

  try {
    const dirtyFilePath = path.join(repo.dir, 'dirty.txt');
    const dirtyFileContentBefore = fs.readFileSync(dirtyFilePath, 'utf8');
    const branchBefore = repo.headBranch;
    const commitBefore = repo.headCommit;

    const result = await runMain([
      'create',
      'task with dirty source',
      '--name',
      'dirty-ws',
      '--root',
      tmpRoot,
      '--repo',
      repo.dir,
    ]);

    assert.equal(result.exitCode, 0);
    assert.match(result.stderr, /warning: source repository .* has uncommitted changes/);

    // Source repo branch, commit, and dirty file are completely unchanged
    const branchAfter = runGit(['-C', repo.dir, 'symbolic-ref', '--short', 'HEAD']).trim();
    const commitAfter = runGit(['-C', repo.dir, 'rev-parse', 'HEAD']).trim();
    const dirtyFileContentAfter = fs.readFileSync(dirtyFilePath, 'utf8');

    assert.equal(branchAfter, branchBefore);
    assert.equal(commitAfter, commitBefore);
    assert.equal(dirtyFileContentAfter, dirtyFileContentBefore);

    // Dirty file is NOT present in the worktree
    const wsDir = path.join(tmpRoot, 'dirty-ws');
    const repoEntry = path.basename(repo.dir);
    const wtDirtyFile = path.join(wsDir, repoEntry, 'dirty.txt');
    assert.equal(fs.existsSync(wtDirtyFile), false, 'Uncommitted changes must not be copied to worktree');
  } finally {
    repo.cleanup();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Duplicate spelling of same source -> one entry', async () => {
  const repo = createTestRepo({ prefix: 'wsg-dupe-' });
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-root-'));

  try {
    const absPath = repo.dir;
    // Relative path representation
    const parentDir = path.dirname(repo.dir);
    const baseName = path.basename(repo.dir);
    const relSpelling = path.join(parentDir, '.', baseName);

    const result = await runMain(
      ['create', 'dupe test', '--name', 'dupe-ws', '--root', tmpRoot, '--repo', absPath, '--repo', relSpelling],
      { cwd: parentDir }
    );

    assert.equal(result.exitCode, 0);
    const wsDir = path.join(tmpRoot, 'dupe-ws');
    const manifest = parseManifest(fs.readFileSync(path.join(wsDir, 'workspace.yaml'), 'utf8'));

    assert.equal(manifest.repos.length, 1, 'Duplicate spellings of same source must produce only one repo entry');
  } finally {
    repo.cleanup();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Two app repos -> app, app-<6hex>, mapping printed before mutation', async () => {
  const parent1 = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-app1-'));
  const parent2 = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-app2-'));
  const appDir1 = path.join(parent1, 'app');
  const appDir2 = path.join(parent2, 'app');

  fs.mkdirSync(appDir1);
  fs.mkdirSync(appDir2);

  runGit(['init', '-b', 'main', appDir1]);
  runGit(['-C', appDir1, 'config', 'user.name', 'App1']);
  runGit(['-C', appDir1, 'config', 'user.email', 'app1@example.com']);
  fs.writeFileSync(path.join(appDir1, 'README.md'), '# App 1\n');
  runGit(['-C', appDir1, 'add', '.']);
  runGit(['-C', appDir1, 'commit', '-m', 'Init 1']);

  runGit(['init', '-b', 'main', appDir2]);
  runGit(['-C', appDir2, 'config', 'user.name', 'App2']);
  runGit(['-C', appDir2, 'config', 'user.email', 'app2@example.com']);
  fs.writeFileSync(path.join(appDir2, 'README.md'), '# App 2\n');
  runGit(['-C', appDir2, 'add', '.']);
  runGit(['-C', appDir2, 'commit', '-m', 'Init 2']);

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-root-'));

  try {
    const result = await runMain([
      'create',
      'two app repos test',
      '--name',
      'two-apps',
      '--root',
      tmpRoot,
      '--repo',
      appDir1,
      '--repo',
      appDir2,
    ]);

    assert.equal(result.exitCode, 0, result.stderr);

    // Mapping printed in stdout before mutation
    assert.match(result.stdout, /app/);
    assert.match(result.stdout, /app-[0-9a-f]{6}/);

    const wsDir = path.join(tmpRoot, 'two-apps');
    const manifest = parseManifest(fs.readFileSync(path.join(wsDir, 'workspace.yaml'), 'utf8'));

    assert.equal(manifest.repos.length, 2);
    const names = manifest.repos.map((r) => r.name);
    assert.ok(names.includes('app'));
    assert.ok(names.some((n) => /^app-[0-9a-f]{6}$/.test(n)));

    // Directories exist on disk
    for (const name of names) {
      assert.ok(fs.existsSync(path.join(wsDir, name)), `Worktree ${name} must exist`);
    }
  } finally {
    fs.rmSync(parent1, { recursive: true, force: true });
    fs.rmSync(parent2, { recursive: true, force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('--dry-run: prints plan, <root>/<name> absent, no wsg/ branches', async () => {
  const repo = createTestRepo({ prefix: 'wsg-dry-' });
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-root-'));
  const tmpDoc = path.join(tmpRoot, 'doc.txt');
  fs.writeFileSync(tmpDoc, 'dry run doc\n');

  try {
    const result = await runMain([
      'create',
      'dry run request',
      '--name',
      'dry-ws',
      '--root',
      tmpRoot,
      '--repo',
      repo.dir,
      '--doc',
      tmpDoc,
      '--dry-run',
    ]);

    assert.equal(result.exitCode, 0);

    // Prints plan
    assert.match(result.stdout, /Workspace: dry-ws/);
    assert.match(result.stdout, /Destination:/);
    assert.match(result.stdout, /Repositories \(1\):/);
    assert.match(result.stdout, /Documents \(1\):/);

    // Target workspace directory is absent
    const wsDir = path.join(tmpRoot, 'dry-ws');
    assert.equal(fs.existsSync(wsDir), false, 'Target workspace must not exist after dry run');

    // No wsg/ branch created in source repo
    const repoBase = path.basename(repo.dir);
    assert.equal(
      branchExists(repo.dir, `wsg/dry-ws/${repoBase}`),
      false,
      'No wsg/ branch must be created on dry run'
    );
  } finally {
    repo.cleanup();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Preflight exit 1, nothing created: non-repo', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-root-'));
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-not-a-repo-'));

  try {
    const result = await runMain([
      'create',
      'task',
      '--name',
      'test-fail',
      '--root',
      tmpRoot,
      '--repo',
      emptyDir,
    ]);

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /not a git repository/);
    assert.equal(fs.existsSync(path.join(tmpRoot, 'test-fail')), false);
  } finally {
    fs.rmSync(emptyDir, { recursive: true, force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Preflight exit 1, nothing created: subdir of repo (PD1)', async () => {
  const repo = createTestRepo({ prefix: 'wsg-subdir-' });
  const subDir = path.join(repo.dir, 'some-subfolder');
  fs.mkdirSync(subDir);
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-root-'));

  try {
    const result = await runMain([
      'create',
      'task',
      '--name',
      'test-fail',
      '--root',
      tmpRoot,
      '--repo',
      subDir,
    ]);

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /is a subdirectory of git repository at/);
    assert.match(result.stderr, /Please specify the repository root/);
    assert.equal(fs.existsSync(path.join(tmpRoot, 'test-fail')), false);
  } finally {
    repo.cleanup();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Preflight exit 1, nothing created: bare repo', async () => {
  const repo = createTestRepo({ prefix: 'wsg-bare-', bare: true });
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-root-'));

  try {
    const result = await runMain([
      'create',
      'task',
      '--name',
      'test-fail',
      '--root',
      tmpRoot,
      '--repo',
      repo.dir,
    ]);

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /bare git repository/);
    assert.equal(fs.existsSync(path.join(tmpRoot, 'test-fail')), false);
  } finally {
    repo.cleanup();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Preflight exit 1, nothing created: unborn repo', async () => {
  const repo = createTestRepo({ prefix: 'wsg-unborn-', unborn: true });
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-root-'));

  try {
    const result = await runMain([
      'create',
      'task',
      '--name',
      'test-fail',
      '--root',
      tmpRoot,
      '--repo',
      repo.dir,
    ]);

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /unborn HEAD/);
    assert.equal(fs.existsSync(path.join(tmpRoot, 'test-fail')), false);
  } finally {
    repo.cleanup();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Preflight exit 1, nothing created: missing doc', async () => {
  const repo = createTestRepo({ prefix: 'wsg-repo-' });
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-root-'));

  try {
    const result = await runMain([
      'create',
      'task',
      '--name',
      'test-fail',
      '--root',
      tmpRoot,
      '--repo',
      repo.dir,
      '--doc',
      path.join(tmpRoot, 'nonexistent.md'),
    ]);

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /does not exist/);
    assert.equal(fs.existsSync(path.join(tmpRoot, 'test-fail')), false);
  } finally {
    repo.cleanup();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Preflight exit 1, nothing created: secret doc (filename and content)', async () => {
  const repo = createTestRepo({ prefix: 'wsg-repo-' });
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-root-'));
  const envDoc = path.join(tmpRoot, '.env');
  fs.writeFileSync(envDoc, 'API_KEY=123\n');

  const keyDoc = path.join(tmpRoot, 'notes.md');
  fs.writeFileSync(keyDoc, '-----BEGIN RSA PRIVATE KEY-----\nsecret\n-----END RSA PRIVATE KEY-----\n');

  try {
    // Secret filename
    const res1 = await runMain([
      'create',
      'task',
      '--name',
      'test-fail1',
      '--root',
      tmpRoot,
      '--repo',
      repo.dir,
      '--doc',
      envDoc,
    ]);
    assert.equal(res1.exitCode, 1);
    assert.match(res1.stderr, /matches protected pattern/);
    assert.equal(fs.existsSync(path.join(tmpRoot, 'test-fail1')), false);

    // Secret content
    const res2 = await runMain([
      'create',
      'task',
      '--name',
      'test-fail2',
      '--root',
      tmpRoot,
      '--repo',
      repo.dir,
      '--doc',
      keyDoc,
    ]);
    assert.equal(res2.exitCode, 1);
    assert.match(res2.stderr, /contains private key/);
    assert.equal(fs.existsSync(path.join(tmpRoot, 'test-fail2')), false);
  } finally {
    repo.cleanup();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Preflight exit 1, nothing created: invalid --name', async () => {
  const repo = createTestRepo({ prefix: 'wsg-repo-' });
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-root-'));

  try {
    const result = await runMain([
      'create',
      'task',
      '--name',
      'invalid/name',
      '--root',
      tmpRoot,
      '--repo',
      repo.dir,
    ]);

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /is invalid/);
    assert.equal(fs.existsSync(path.join(tmpRoot, 'invalid')), false);
  } finally {
    repo.cleanup();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Preflight exit 1, nothing created: --for bogus and --for none,agents', async () => {
  const repo = createTestRepo({ prefix: 'wsg-repo-' });
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-root-'));

  try {
    // --for bogus
    const res1 = await runMain([
      'create',
      'task',
      '--name',
      'test-fail1',
      '--root',
      tmpRoot,
      '--repo',
      repo.dir,
      '--for',
      'bogus',
    ]);
    assert.equal(res1.exitCode, 1);
    assert.match(res1.stderr, /Invalid adapter 'bogus'/);
    assert.equal(fs.existsSync(path.join(tmpRoot, 'test-fail1')), false);

    // --for none,agents
    const res2 = await runMain([
      'create',
      'task',
      '--name',
      'test-fail2',
      '--root',
      tmpRoot,
      '--repo',
      repo.dir,
      '--for',
      'none,agents',
    ]);
    assert.equal(res2.exitCode, 1);
    assert.match(res2.stderr, /Invalid adapter 'none'/);
    assert.equal(fs.existsSync(path.join(tmpRoot, 'test-fail2')), false);
  } finally {
    repo.cleanup();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Conflict exit 2, no mutation: existing branch (guidance printed, not run)', async () => {
  const repo = createTestRepo({ prefix: 'wsg-branch-conflict-' });
  const repoBase = path.basename(repo.dir);
  const conflictingBranch = `wsg/test-ws/${repoBase}`;
  runGit(['-C', repo.dir, 'branch', conflictingBranch, repo.headCommit]);

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-root-'));

  try {
    const result = await runMain([
      'create',
      'task',
      '--name',
      'test-ws',
      '--root',
      tmpRoot,
      '--repo',
      repo.dir,
    ]);

    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, new RegExp(`Branch '${conflictingBranch}' already exists`));
    // Guidance printed
    assert.match(result.stderr, /branch -D/);
    assert.match(result.stderr, /--name/);

    // No workspace directory created
    assert.equal(fs.existsSync(path.join(tmpRoot, 'test-ws')), false);
  } finally {
    repo.cleanup();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Conflict exit 2, no mutation: complete workspace exists', async () => {
  const repo = createTestRepo({ prefix: 'wsg-ws-conflict-' });
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-root-'));
  const wsDir = path.join(tmpRoot, 'test-ws');
  fs.mkdirSync(wsDir, { recursive: true });
  fs.writeFileSync(path.join(wsDir, 'workspace.yaml'), 'version: 1\nname: test-ws\n');

  try {
    const result = await runMain([
      'create',
      'task',
      '--name',
      'test-ws',
      '--root',
      tmpRoot,
      '--repo',
      repo.dir,
    ]);

    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /already exists with a completed workspace/);

    // No wsg/ branch created in source repo
    const repoBase = path.basename(repo.dir);
    assert.equal(branchExists(repo.dir, `wsg/test-ws/${repoBase}`), false);
  } finally {
    repo.cleanup();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Conflict exit 2, no mutation: incomplete without --resume (suggests it)', async () => {
  const repo = createTestRepo({ prefix: 'wsg-incomp-' });
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-root-'));
  const wsDir = path.join(tmpRoot, 'test-ws');
  fs.mkdirSync(path.join(wsDir, '.wsg'), { recursive: true });
  fs.writeFileSync(path.join(wsDir, '.wsg', 'partial.txt'), 'partial\n');

  try {
    const result = await runMain([
      'create',
      'task',
      '--name',
      'test-ws',
      '--root',
      tmpRoot,
      '--repo',
      repo.dir,
    ]);

    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /already exists with an incomplete workspace/);
    assert.match(result.stderr, /Use --resume/);

    // No wsg/ branch created in source repo
    const repoBase = path.basename(repo.dir);
    assert.equal(branchExists(repo.dir, `wsg/test-ws/${repoBase}`), false);
  } finally {
    repo.cleanup();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Conflict exit 2, no mutation: live lock', async () => {
  const repo = createTestRepo({ prefix: 'wsg-livelock-' });
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-root-'));
  const wsDir = path.join(tmpRoot, 'test-ws');
  fs.mkdirSync(path.join(wsDir, '.wsg'), { recursive: true });

  // Simulate active process lock
  const lockData = {
    pid: process.pid,
    hostname: os.hostname(),
    startedAt: new Date().toISOString(),
    opId: 'test-lock-op',
    token: 'test-token',
  };
  fs.writeFileSync(path.join(wsDir, '.wsg', 'lock'), JSON.stringify(lockData, null, 2) + '\n');

  try {
    const result = await runMain([
      'create',
      'task',
      '--name',
      'test-ws',
      '--root',
      tmpRoot,
      '--repo',
      repo.dir,
    ]);

    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /Lock is held by active process/);

    // No wsg/ branch created in source repo
    const repoBase = path.basename(repo.dir);
    assert.equal(branchExists(repo.dir, `wsg/test-ws/${repoBase}`), false);
  } finally {
    repo.cleanup();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Submodule/LFS fixture -> discovery.gaps in manifest and context', async () => {
  const repo = createTestRepo({ prefix: 'wsg-gaps-', submodules: true, lfs: true });
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-root-'));

  try {
    const result = await runMain([
      'create',
      'gaps test',
      '--name',
      'gaps-ws',
      '--root',
      tmpRoot,
      '--repo',
      repo.dir,
    ]);

    assert.equal(result.exitCode, 0);

    const wsDir = path.join(tmpRoot, 'gaps-ws');
    const manifest = parseManifest(fs.readFileSync(path.join(wsDir, 'workspace.yaml'), 'utf8'));

    assert.ok(manifest.discovery.gaps.length >= 2, 'Should detect at least 2 gaps');
    assert.ok(manifest.discovery.gaps.some((g) => g.includes('Submodules detected in .gitmodules')));
    assert.ok(manifest.discovery.gaps.some((g) => g.includes('Git LFS filter configured')));

    const contextMd = fs.readFileSync(path.join(wsDir, 'docs', 'context.md'), 'utf8');
    assert.match(contextMd, /## Gaps and Unresolved Questions/);
    assert.match(contextMd, /Submodules detected in \.gitmodules/);
    assert.match(contextMd, /Git LFS filter configured/);
  } finally {
    repo.cleanup();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('--code-root -> stderr note (PD6)', async () => {
  const repo = createTestRepo({ prefix: 'wsg-coderoot-' });
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-root-'));

  try {
    const result = await runMain([
      'create',
      'code root note test',
      '--name',
      'coderoot-ws',
      '--root',
      tmpRoot,
      '--repo',
      repo.dir,
      '--code-root',
      '/tmp/code',
    ]);

    assert.equal(result.exitCode, 0);
    assert.match(result.stderr, /wsg: note: --code-root is accepted but autonomous discovery is not available/);

    const wsDir = path.join(tmpRoot, 'coderoot-ws');
    assert.ok(fs.existsSync(path.join(wsDir, 'workspace.yaml')));
  } finally {
    repo.cleanup();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('URL doc reference and binary unread metadata', async () => {
  const repo = createTestRepo({ prefix: 'wsg-docs-ref-' });
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-root-'));
  const binDoc = path.join(tmpRoot, 'image.png');
  // Binary buffer with NUL byte
  fs.writeFileSync(binDoc, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0a, 0x1a, 0x0a]));

  try {
    const result = await runMain([
      'create',
      'url reference and binary test',
      '--name',
      'docs-ws',
      '--root',
      tmpRoot,
      '--repo',
      repo.dir,
      '--doc',
      'https://example.com/spec.md',
      '--doc',
      binDoc,
    ]);

    assert.equal(result.exitCode, 0);
    const wsDir = path.join(tmpRoot, 'docs-ws');
    const manifest = parseManifest(fs.readFileSync(path.join(wsDir, 'workspace.yaml'), 'utf8'));

    assert.equal(manifest.docs.length, 2);
    const refDoc = manifest.docs.find((d) => d.source === 'https://example.com/spec.md');
    assert.ok(refDoc);
    assert.equal(refDoc.mode, 'reference');
    assert.equal(refDoc.reason, 'Not fetched in this version');

    const snapDoc = manifest.docs.find((d) => d.source !== 'https://example.com/spec.md');
    assert.ok(snapDoc);
    assert.equal(snapDoc.mode, 'snapshot');

    const contextMd = fs.readFileSync(path.join(wsDir, 'docs', 'context.md'), 'utf8');
    // Both reference and binary document should be marked with (unread)
    assert.match(contextMd, /https:\/\/example\.com\/spec\.md.*\(mode: reference\)\s*\(unread\)/);
    assert.match(contextMd, /image\.png.*\(mode: snapshot\)\s*\(unread\)/);
  } finally {
    repo.cleanup();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('--resume placeholder exits 1 UsageError', async () => {
  const result = await runMain(['create', 'resume test', '--resume']);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /--resume is not implemented in this version/);
});
