import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runMain } from './helpers/cli.ts';
import { serializeManifest, type Manifest } from '../src/manifest.ts';
import { renderExplain } from '../src/explain.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI_PATH = path.join(REPO_ROOT, 'src', 'cli.ts');

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function fixtureManifest(base: string): Manifest {
  return {
    version: 1,
    name: 'fixture-ws',
    request: 'Port EMR mono to modular.\nSecond line of the request.',
    context: ['Target uses patient-service boundaries'],
    adapters: ['agents'],
    repos: [
      {
        name: 'repo-alpha',
        source: path.join(base, 'alpha-src'),
        path: 'repo-alpha',
        base_commit: 'a'.repeat(40),
        branch: 'wsg/fixture-ws/repo-alpha',
        intent: 'source',
        added_by: 'user',
        reason: 'Legacy monolith to port.',
        evidence: [
          {
            file: 'src/a.ts',
            lines: [1, 3] as [number, number],
            summary: 'entry point',
          },
          { file: 'src/b.ts', summary: 'domain model' },
        ],
      },
      {
        name: 'repo-beta',
        source: path.join(base, 'beta-src'),
        path: 'repo-beta',
        base_commit: 'b'.repeat(40),
        branch: 'wsg/fixture-ws/repo-beta',
        intent: 'target',
        added_by: 'user',
        reason: 'Modular runtime.',
        evidence: [],
      },
    ],
    docs: [
      {
        source: path.join(base, 'migration.md'),
        path: 'docs/migration.md',
        mode: 'snapshot',
        added_by: 'user',
        sha256: 'c'.repeat(64),
        fetched_at: '2026-01-01T00:00:00.000Z',
      },
      {
        source: 'https://example.com/wiki',
        mode: 'reference',
        added_by: 'user',
        reason: 'Not fetched in this version',
      },
    ],
    scripts: [],
    commands: [
      {
        name: 'build',
        cwd: 'repo-beta',
        argv: ['npm', 'run', 'build'],
        evidence: 'package.json',
      },
    ],
    discovery: {
      excluded: [
        {
          source: path.join(base, 'old-src'),
          reason: 'unrelated to the migration',
        },
      ],
      gaps: ['Submodules detected in .gitmodules for repository repo-alpha'],
    },
  };
}

function makeWorkspace(manifest: Manifest): string {
  const wsDir = mkTmp('wsg-explain-ws-');
  fs.writeFileSync(
    path.join(wsDir, 'workspace.yaml'),
    serializeManifest(manifest),
    'utf8'
  );
  return wsDir;
}

test('renderExplain includes every manifest-derived section', () => {
  const manifest = fixtureManifest('/tmp/base');
  const out = renderExplain(manifest, { workspaceRoot: '/tmp/base/ws' });

  assert.match(out, /Workspace: fixture-ws/);
  assert.match(out, /Root: \/tmp\/base\/ws/);
  assert.match(out, /Port EMR mono to modular\./);
  assert.match(out, /Second line of the request\./);
  assert.match(out, /Repositories \(2\):/);
  assert.match(out, /repo-alpha \(intent: source, path: repo-alpha\)/);
  assert.match(out, /repo-beta \(intent: target, path: repo-beta\)/);
  assert.match(out, /reason: Legacy monolith to port\./);
  assert.match(out, /evidence: 2 entries/);
  assert.match(out, /evidence: 0 entries/);
  assert.match(out, /src\/a\.ts:1-3: entry point/);
  assert.match(out, /Documents \(2\):/);
  assert.match(out, /docs\/migration\.md \(mode: snapshot\)/);
  assert.match(out, /https:\/\/example\.com\/wiki \(mode: reference\)/);
  assert.match(out, /Exclusions \(1\):/);
  assert.match(out, /unrelated to the migration/);
  assert.match(out, /Gaps \(1\):/);
  assert.match(out, /Submodules detected/);
  assert.match(out, /Commands \(1\) \[discovered, not verified\]:/);
  assert.match(out, /build: npm run build \(cwd: repo-beta\)/);
});

test('explain resolves from the workspace root, docs/, and inside a worktree', async () => {
  const base = mkTmp('wsg-explain-base-');
  const wsDir = makeWorkspace(fixtureManifest(base));
  const nested = path.join(wsDir, 'repo-alpha', 'src', 'deep');
  fs.mkdirSync(nested, { recursive: true });
  fs.mkdirSync(path.join(wsDir, 'docs'), { recursive: true });

  try {
    for (const cwd of [wsDir, path.join(wsDir, 'docs'), nested]) {
      const result = await runMain(['explain'], { cwd });
      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stdout, /Workspace: fixture-ws/);
      assert.match(result.stdout, /repo-alpha/);
      assert.match(result.stdout, /repo-beta/);
      assert.match(result.stdout, /Documents \(2\):/);
      assert.match(result.stdout, /mode: snapshot/);
      assert.match(result.stdout, /mode: reference/);
      assert.match(result.stdout, /Exclusions \(1\):/);
      assert.match(result.stdout, /Gaps \(1\):/);
      assert.match(result.stdout, /Commands \(1\)/);
      assert.equal(result.stderr, '');
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(wsDir, { recursive: true, force: true });
  }
});

test('explain --workspace resolves from an unrelated working directory', async () => {
  const base = mkTmp('wsg-explain-base-');
  const wsDir = makeWorkspace(fixtureManifest(base));
  const unrelated = mkTmp('wsg-explain-unrelated-');

  try {
    const result = await runMain(['explain', '--workspace', wsDir], {
      cwd: unrelated,
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /Workspace: fixture-ws/);
    assert.match(result.stdout, /repo-alpha/);

    // A relative --workspace resolves against the caller's cwd.
    const relative = path.relative(unrelated, wsDir);
    const relativeResult = await runMain(
      ['explain', '--workspace', relative],
      { cwd: unrelated }
    );
    assert.equal(relativeResult.exitCode, 0, relativeResult.stderr);
    assert.match(relativeResult.stdout, /Workspace: fixture-ws/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(wsDir, { recursive: true, force: true });
    fs.rmSync(unrelated, { recursive: true, force: true });
  }
});

test('explain without a manifest exits 1 with a hint', async () => {
  const empty = mkTmp('wsg-explain-empty-');
  try {
    const result = await runMain(['explain'], { cwd: empty });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /No workspace\.yaml/);
    assert.match(result.stderr, /wsg explain --workspace/);
    assert.equal(result.stdout, '');
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test('explain <repo> filters to one repository; unknown repo exits 1', async () => {
  const base = mkTmp('wsg-explain-base-');
  const wsDir = makeWorkspace(fixtureManifest(base));

  try {
    const filtered = await runMain(['explain', 'repo-alpha'], { cwd: wsDir });
    assert.equal(filtered.exitCode, 0, filtered.stderr);
    assert.match(filtered.stdout, /repo-alpha/);
    assert.match(filtered.stdout, /evidence: 2 entries/);
    assert.doesNotMatch(filtered.stdout, /repo-beta/);

    const unknown = await runMain(['explain', 'does-not-exist'], { cwd: wsDir });
    assert.equal(unknown.exitCode, 1);
    assert.match(unknown.stderr, /not part of workspace 'fixture-ws'/);
    assert.match(unknown.stderr, /Available repositories: repo-alpha, repo-beta/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(wsDir, { recursive: true, force: true });
  }
});

test('explain works with .wsg removed, no credentials, and no git on PATH', () => {
  const base = mkTmp('wsg-explain-base-');
  const wsDir = makeWorkspace(fixtureManifest(base));
  const nested = path.join(wsDir, 'repo-alpha', 'src', 'deep');
  fs.mkdirSync(nested, { recursive: true });

  let noPathDir: string | undefined;
  try {
    // Simulate a completed workspace whose runtime storage was removed.
    fs.mkdirSync(path.join(wsDir, '.wsg'), { recursive: true });
    fs.writeFileSync(
      path.join(wsDir, '.wsg', 'operation.json'),
      '{"version":1,"owned":{},"operation":null}\n',
      'utf8'
    );
    fs.rmSync(path.join(wsDir, '.wsg'), { recursive: true, force: true });
    assert.ok(!fs.existsSync(path.join(wsDir, '.wsg')));

    // A PATH with no `git` (and no `node`): the subprocess is launched via an
    // absolute execPath, so any hidden Git call would fail the run.
    noPathDir = mkTmp('wsg-explain-nopath-');
    const env: Record<string, string> = {
      PATH: noPathDir,
      HOME: process.env.HOME ?? '',
    };
    assert.equal(env.OPENAI_API_KEY, undefined);

    const result = spawnSync(process.execPath, [CLI_PATH, 'explain'], {
      cwd: nested,
      env,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Workspace: fixture-ws/);
    assert.match(result.stdout, /repo-alpha/);
    assert.equal(result.stderr, '');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(wsDir, { recursive: true, force: true });
    if (noPathDir) fs.rmSync(noPathDir, { recursive: true, force: true });
  }
});

test('explain on an invalid manifest exits 1 with line:col', async () => {
  const wsDir = mkTmp('wsg-explain-bad-');
  fs.writeFileSync(
    path.join(wsDir, 'workspace.yaml'),
    'version: 1\nname: bad\nrequest: hi\nrepos: []\ndocs: []\nbogus: true\n',
    'utf8'
  );

  try {
    const result = await runMain(['explain'], { cwd: wsDir });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /:\d+:\d+:/);
    assert.match(result.stderr, /bogus/);
  } finally {
    fs.rmSync(wsDir, { recursive: true, force: true });
  }
});
