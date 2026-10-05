import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeEmrFixture, EMR_FILES, EMR_CONTENT } from './helpers/emr-fixture.ts';
import { createTestRepo } from './helpers/git-fixture.ts';
import { runCreate } from '../src/create.ts';
import { runMain } from './helpers/cli.ts';
import { ScriptedScout, type ScoutResult } from '../src/scout.ts';
import { parseManifest } from '../src/manifest.ts';
import { branchExists } from '../src/git.ts';
import { ConflictError, UsageError } from '../src/errors.ts';

const NO_CONFIG = path.join(os.tmpdir(), `wsg-m3-noconfig-${process.pid}.yaml`);

function io(env: Record<string, string | undefined> = {}) {
  return {
    env: { ...process.env, WSG_CONFIG: NO_CONFIG, ...env },
    cwd: process.cwd(),
  };
}

function cloneSelection(selection: ScoutResult): ScoutResult {
  return JSON.parse(JSON.stringify(selection)) as ScoutResult;
}

test('EMR fixture: scout selects source/target/shared, excludes the unrelated repo, and materializes', async () => {
  const fixture = makeEmrFixture();
  const stateDir = path.join(fixture.workspaceRoot, '.scout-state');
  try {
    const code = await runCreate(
      {
        request: 'Port EMR from the monolith to the modular architecture',
        name: 'port-emr',
        root: fixture.workspaceRoot,
        codeRoots: [fixture.codeRoot],
        scout: new ScriptedScout(fixture.selection),
        scoutStateDir: stateDir,
      },
      io()
    );
    assert.equal(code, 0);

    const wsDir = path.join(fixture.workspaceRoot, 'port-emr');
    const manifest = parseManifest(fs.readFileSync(path.join(wsDir, 'workspace.yaml'), 'utf8'));

    const byName = new Map(manifest.repos.map((r) => [r.name, r]));
    assert.equal(manifest.repos.length, 3, 'source, target, and shared are selected');
    assert.equal(manifest.repos.filter((r) => r.intent === 'source').length, 1);
    assert.equal(manifest.repos.filter((r) => r.intent === 'target').length, 1);
    assert.equal(manifest.repos.filter((r) => r.intent === 'shared').length, 1);
    for (const repo of manifest.repos) {
      assert.equal(repo.added_by, 'scout');
      assert.ok(repo.evidence.length >= 1, `${repo.name} must carry verified evidence`);
    }

    // The unrelated repository is excluded with a reason, not materialized.
    assert.ok(
      manifest.discovery.excluded.some(
        (e) => e.reason.includes('incidental') || e.source.length > 0
      )
    );
    assert.ok(
      !manifest.repos.some((r) => r.source === fixture.unrelated.dir),
      'the unrelated billing repo must not be selected'
    );
    assert.equal(
      fs.existsSync(path.join(wsDir, fixture.unrelated.dir.split(path.sep).pop()!)),
      false
    );

    // Worktrees and branches exist for each selected repo.
    for (const repo of manifest.repos) {
      assert.ok(fs.existsSync(path.join(wsDir, repo.path)), `${repo.path} worktree exists`);
      assert.ok(branchExists(repo.source, repo.branch));
    }

    // Evidence is wired into `wsg explain` without a model call.
    const explained = await runMain(['explain', '--workspace', wsDir], io({ OPENAI_API_KEY: undefined }));
    assert.equal(explained.exitCode, 0, explained.stderr);
    assert.match(explained.stdout, /intent: source/);
    assert.match(explained.stdout, /intent: target/);
    assert.match(explained.stdout, /intent: shared/);
    assert.match(explained.stdout, /evidence: \d+ entr/);
    assert.match(explained.stdout, /Exclusions/);
    assert.match(explained.stdout, /billing-service/);
  } finally {
    fixture.cleanup();
  }
});

test('EMR fixture: the evidence corpus for the target contains real symbols', () => {
  const fixture = makeEmrFixture();
  try {
    const modularFile = fs.readFileSync(path.join(fixture.modular.dir, EMR_FILES.modular), 'utf8');
    assert.equal(modularFile, EMR_CONTENT.modular);
    assert.match(modularFile, /shared-health-model/);
    const legacyFile = fs.readFileSync(path.join(fixture.legacy.dir, EMR_FILES.legacy), 'utf8');
    assert.match(legacyFile, /MedicalRecord/);
  } finally {
    fixture.cleanup();
  }
});

test('fictional evidence is rejected before any materialization', async () => {
  const fixture = makeEmrFixture();
  const selection = cloneSelection(fixture.selection);
  if (selection.kind === 'selection') {
    selection.repos[0].evidence = [
      { file: EMR_FILES.legacy, summary: 'fabricated', quote: 'this exact text does not exist' },
    ];
  }
  try {
    await assert.rejects(
      () =>
        runCreate(
          {
            request: 'port EMR',
            name: 'fictional',
            root: fixture.workspaceRoot,
            codeRoots: [fixture.codeRoot],
            scout: new ScriptedScout(selection),
            scoutStateDir: path.join(fixture.workspaceRoot, '.scout-fictional'),
          },
          io()
        ),
      (err: unknown) => err instanceof UsageError && /fictional|does not contain/.test(err.message)
    );
    assert.equal(fs.existsSync(path.join(fixture.workspaceRoot, 'fictional')), false);
  } finally {
    fixture.cleanup();
  }
});

test('discovered selection without evidence is rejected', async () => {
  const fixture = makeEmrFixture();
  const selection: ScoutResult = {
    kind: 'selection',
    repos: [{ source: fixture.names.legacy, intent: 'source', addedBy: 'scout', evidence: [] }],
    docs: [],
  };
  try {
    await assert.rejects(
      () =>
        runCreate(
          {
            request: 'port EMR',
            name: 'no-evidence',
            root: fixture.workspaceRoot,
            codeRoots: [fixture.codeRoot],
            scout: new ScriptedScout(selection),
            scoutStateDir: path.join(fixture.workspaceRoot, '.scout-noev'),
          },
          io()
        ),
      (err: unknown) => err instanceof UsageError && /without evidence/.test(err.message)
    );
    assert.equal(fs.existsSync(path.join(fixture.workspaceRoot, 'no-evidence')), false);
  } finally {
    fixture.cleanup();
  }
});

test('ambiguous target repositories do not trigger arbitrary materialization', async () => {
  const fixture = makeEmrFixture();
  const selection = cloneSelection(fixture.selection);
  if (selection.kind === 'selection') {
    for (const repo of selection.repos) repo.intent = 'target';
  }
  try {
    await assert.rejects(
      () =>
        runCreate(
          {
            request: 'port EMR to the modular target',
            name: 'ambiguous',
            root: fixture.workspaceRoot,
            codeRoots: [fixture.codeRoot],
            scout: new ScriptedScout(selection),
            scoutStateDir: path.join(fixture.workspaceRoot, '.scout-amb'),
          },
          io()
        ),
      (err: unknown) => err instanceof ConflictError && /candidate target/.test(err.message)
    );
    assert.equal(fs.existsSync(path.join(fixture.workspaceRoot, 'ambiguous')), false);
  } finally {
    fixture.cleanup();
  }
});

test('absent code roots produce an actionable bounded error', async () => {
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-empty-root-'));
  const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-empty-out-'));
  try {
    await assert.rejects(
      () =>
        runCreate(
          {
            request: 'port EMR',
            name: 'empty',
            root: outRoot,
            codeRoots: [emptyRoot],
            scout: new ScriptedScout({ kind: 'none', reason: 'unused' }),
            scoutStateDir: path.join(outRoot, '.scout-empty'),
          },
          io()
        ),
      (err: unknown) =>
        err instanceof UsageError && /No git repositories found/.test(err.message)
    );
    assert.equal(fs.existsSync(path.join(outRoot, 'empty')), false);
  } finally {
    fs.rmSync(emptyRoot, { recursive: true, force: true });
    fs.rmSync(outRoot, { recursive: true, force: true });
  }
});

test('the discovered-repository cap applies only to auto-discovered repos', async () => {
  const fixture = makeEmrFixture();
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-m3-cfg-'));
  const configPath = path.join(configDir, 'config.yaml');
  fs.writeFileSync(configPath, 'max_discovered_repos: 1\n');
  try {
    const code = await runCreate(
      {
        request: 'port EMR to modular',
        name: 'capped',
        root: fixture.workspaceRoot,
        codeRoots: [fixture.codeRoot],
        scout: new ScriptedScout(fixture.selection),
        scoutStateDir: path.join(fixture.workspaceRoot, '.scout-capped'),
      },
      { env: { ...process.env, WSG_CONFIG: configPath }, cwd: process.cwd() }
    );
    assert.equal(code, 0);
    const manifest = parseManifest(
      fs.readFileSync(path.join(fixture.workspaceRoot, 'capped', 'workspace.yaml'), 'utf8')
    );
    assert.equal(manifest.repos.length, 1, 'only one discovered repo survives the cap');
    assert.ok(
      manifest.discovery.gaps.some((g) => /capped at 1/.test(g)),
      `expected a cap gap, got ${JSON.stringify(manifest.discovery.gaps)}`
    );
  } finally {
    fixture.cleanup();
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test('evidence grounded in dirty files requires --allow-dirty-evidence', async () => {
  const codeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-m3-dirty-'));
  const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-m3-dirty-out-'));
  const repo = createTestRepo({
    prefix: 'wsg-m3-dirty-repo-',
    files: { 'src/a.ts': 'export const a = 1;\n' },
    dirty: true,
  });
  fs.writeFileSync(path.join(repo.dir, 'dirty.txt'), 'dirty evidence line\n');
  fs.symlinkSync(repo.dir, path.join(codeRoot, 'dirty-repo'));

  const selection: ScoutResult = {
    kind: 'selection',
    repos: [
      {
        source: 'dirty-repo',
        intent: 'target',
        addedBy: 'scout',
        evidence: [
          { file: 'dirty.txt', lines: [1, 1], summary: 'dirty evidence', quote: 'dirty evidence line' },
        ],
      },
    ],
    docs: [],
  };

  try {
    await assert.rejects(
      () =>
        runCreate(
          {
            request: 'dirty evidence',
            name: 'dirty-blocked',
            root: outRoot,
            codeRoots: [codeRoot],
            scout: new ScriptedScout(selection),
            scoutStateDir: path.join(outRoot, '.scout-dirty'),
          },
          io()
        ),
      (err: unknown) => err instanceof ConflictError && /uncommitted changes/.test(err.message)
    );
    assert.equal(fs.existsSync(path.join(outRoot, 'dirty-blocked')), false);

    const ok = await runCreate(
      {
        request: 'dirty evidence',
        name: 'dirty-allowed',
        root: outRoot,
        codeRoots: [codeRoot],
        scout: new ScriptedScout(selection),
        scoutStateDir: path.join(outRoot, '.scout-dirty-ok'),
        allowDirtyEvidence: true,
      },
      io()
    );
    assert.equal(ok, 0);
    assert.ok(fs.existsSync(path.join(outRoot, 'dirty-allowed', 'workspace.yaml')));
  } finally {
    repo.cleanup();
    fs.rmSync(codeRoot, { recursive: true, force: true });
    fs.rmSync(outRoot, { recursive: true, force: true });
  }
});

test('autonomous --dry-run prints the plan without creating the workspace', async () => {
  const fixture = makeEmrFixture();
  try {
    const code = await runCreate(
      {
        request: 'port EMR dry',
        name: 'dry-emr',
        root: fixture.workspaceRoot,
        codeRoots: [fixture.codeRoot],
        scout: new ScriptedScout(fixture.selection),
        scoutStateDir: path.join(fixture.workspaceRoot, '.scout-dry'),
        dryRun: true,
      },
      io()
    );
    assert.equal(code, 0);
    assert.equal(fs.existsSync(path.join(fixture.workspaceRoot, 'dry-emr')), false);
  } finally {
    fixture.cleanup();
  }
});
