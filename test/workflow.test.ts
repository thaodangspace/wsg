import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  prepareCreate,
  assemblePrepared,
  runCreateWorkflow,
  safeEventMessage,
  MAX_EVENT_MESSAGE_LENGTH,
} from '../src/workflow.ts';
import type {
  NeedsInput,
  PrepareResult,
  ReadyCreate,
  WorkflowEvent,
  WorkflowResult,
} from '../src/workflow.ts';
import { runCreate } from '../src/create.ts';
import { ScriptedScout, type ScoutResult } from '../src/scout.ts';
import { enumerateRepos } from '../src/discovery.ts';
import { createTestRepo } from './helpers/git-fixture.ts';
import { branchExists, worktreeList, runGit } from '../src/git.ts';
import { readOperation } from '../src/operation.ts';
import { parseManifest } from '../src/manifest.ts';
import { ConflictError, UsageError } from '../src/errors.ts';
import { SCOUT_OBSERVED_FILENAME } from '../src/pi-scout.ts';

const NO_CONFIG = (root: string) => path.join(root, 'no-config.yaml');

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function planIo(root: string) {
  return { env: { ...process.env, WSG_CONFIG: NO_CONFIG(root) }, cwd: process.cwd() };
}

function selectionFor(source: string): ScoutResult {
  return { kind: 'selection', repos: [{ source }], docs: [] };
}

test('prepareCreate reaches a validated plan without assembling a workspace', async () => {
  const repo = createTestRepo({ prefix: 'wsg-wf-clear-' });
  const root = mkTmp('wsg-wf-root-');
  const repoBase = path.basename(repo.dir);
  const branch = `wsg/wf-clear/${repoBase}`;
  const wsDir = path.join(root, 'wf-clear');

  try {
    const prepared = await prepareCreate(
      {
        request: 'prepare only, do not assemble',
        name: 'wf-clear',
        root,
        repos: [repo.dir],
        scout: new ScriptedScout(selectionFor(repo.dir)),
      },
      planIo(root)
    );

    assert.equal(prepared.kind, 'ready');
    const ready = prepared as ReadyCreate;
    assert.equal(ready.assembly.wsName, 'wf-clear');
    assert.equal(ready.assembly.repos.length, 1);
    assert.equal(ready.assembly.repos[0].source, fs.realpathSync(repo.dir));
    assert.equal(ready.assembly.repos[0].dest, path.join(wsDir, repoBase));

    // Nothing has been published or mutated by planning.
    assert.equal(fs.existsSync(wsDir), false, 'workspace directory must not exist before assembly');
    assert.equal(
      fs.existsSync(path.join(wsDir, 'workspace.yaml')),
      false,
      'workspace.yaml must not exist before assembly'
    );
    assert.equal(branchExists(repo.dir, branch), false, 'planning must not create a wsg/ branch');
    assert.equal(
      worktreeList(repo.dir).some((wt) => wt.branch === branch),
      false,
      'planning must not register a worktree'
    );
  } finally {
    repo.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('assemblePrepared is the first mutation point and materializes the plan', async () => {
  const repo = createTestRepo({ prefix: 'wsg-wf-assemble-' });
  const root = mkTmp('wsg-wf-root-');
  const wsDir = path.join(root, 'wf-assemble');
  const branch = `wsg/wf-assemble/${path.basename(repo.dir)}`;

  try {
    const prepared = await prepareCreate(
      {
        request: 'assemble after prepare',
        name: 'wf-assemble',
        root,
        repos: [repo.dir],
        scout: new ScriptedScout(selectionFor(repo.dir)),
      },
      planIo(root)
    );
    assert.equal(prepared.kind, 'ready');
    assert.equal(fs.existsSync(wsDir), false);
    assert.equal(branchExists(repo.dir, branch), false);

    const code = await assemblePrepared(prepared as ReadyCreate, { dryRun: false }, planIo(root));
    assert.equal(code, 0);

    assert.ok(fs.existsSync(path.join(wsDir, 'workspace.yaml')), 'assembly must publish workspace.yaml');
    assert.ok(fs.existsSync(path.join(wsDir, '.wsg', 'operation.json')), 'assembly must write the journal');
    assert.ok(branchExists(repo.dir, branch), 'assembly must create the wsg/ branch');

    const manifest = parseManifest(fs.readFileSync(path.join(wsDir, 'workspace.yaml'), 'utf8'));
    assert.equal(manifest.name, 'wf-assemble');
    const journal = readOperation(wsDir);
    assert.equal(journal?.operation?.status, 'complete');
  } finally {
    repo.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ambiguous request returns typed needs_input with no repository writes', async () => {
  const repo = createTestRepo({ prefix: 'wsg-wf-ambiguous-' });
  const root = mkTmp('wsg-wf-root-');
  const repoBase = path.basename(repo.dir);
  const branch = `wsg/wf-ambiguous/${repoBase}`;
  const wsDir = path.join(root, 'wf-ambiguous');

  const ambiguous: ScoutResult = {
    kind: 'ambiguous',
    reason: 'two candidate target repositories',
    candidates: ['candidate-a', 'candidate-b'],
    guidance: 'Choose the target with --repo <path>.',
  };

  try {
    const prepared = await prepareCreate(
      {
        request: 'ambiguous task',
        name: 'wf-ambiguous',
        root,
        repos: [repo.dir],
        scout: new ScriptedScout(ambiguous),
      },
      planIo(root)
    );

    assert.equal(prepared.kind, 'needs_input');
    const needs = prepared as NeedsInput;
    assert.match(needs.reason, /two candidate target repositories/);
    assert.ok(needs.questions.length > 0, 'needs_input must carry actionable questions');
    assert.equal(needs.legacy.classification, 'conflict');
    assert.ok(
      needs.legacy.hints.some((h) => h.includes('Choose the target')),
      'legacy hints preserve the scout guidance'
    );

    // No workspace, branch, or worktree may be created on ambiguity.
    assert.equal(fs.existsSync(wsDir), false, 'ambiguous planning must not create the workspace');
    assert.equal(branchExists(repo.dir, branch), false, 'ambiguous planning must not create a branch');
    assert.equal(
      worktreeList(repo.dir).some((wt) => wt.branch === branch),
      false,
      'ambiguous planning must not register a worktree'
    );
  } finally {
    repo.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('legacy create keeps its conflict/usage classification for typed needs_input', async () => {
  const repo = createTestRepo({ prefix: 'wsg-wf-legacy-' });
  const root = mkTmp('wsg-wf-root-');

  try {
    await assert.rejects(
      () =>
        runCreate(
          {
            request: 'ambiguous task',
            name: 'wf-legacy',
            root,
            repos: [repo.dir],
            scout: new ScriptedScout({
              kind: 'ambiguous',
              reason: 'two candidate targets',
              candidates: ['a', 'b'],
            }),
          },
          planIo(root)
        ),
      (err: unknown) => {
        assert.ok(err instanceof ConflictError, 'ambiguous must remain a ConflictError (exit 2)');
        assert.match((err as Error).message, /two candidate targets/);
        return true;
      }
    );
    assert.equal(fs.existsSync(path.join(root, 'wf-legacy')), false);

    // No usable repository is actionable missing input -> UsageError (exit 1).
    await assert.rejects(
      () =>
        runCreate(
          {
            request: 'nothing to select',
            name: 'wf-empty',
            root,
            codeRoots: [mkTmp('wsg-wf-empty-')],
          },
          planIo(root)
        ),
      (err: unknown) =>
        err instanceof UsageError && /No git repositories found/.test(err.message)
    );
  } finally {
    repo.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('planning may write only the durable scout state, never the workspace', async () => {
  const repo = createTestRepo({ prefix: 'wsg-wf-scoutstate-' });
  const codeRoot = mkTmp('wsg-wf-coderoot-');
  const root = mkTmp('wsg-wf-root-');
  const name = 'wf-scoutstate';
  const wsDir = path.join(root, name);
  const stateDir = path.join(root, '.wsg-scout', name);
  const observedPath = path.join(stateDir, SCOUT_OBSERVED_FILENAME);

  // Seed a stale durable observation to prove planning is allowed to rewrite
  // its own scout state.
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(observedPath, '{"version":1,"files":{"stale":{"stale.ts":{"1":"STALE"}}}}\n');

  const branch = `wsg/${name}/${path.basename(repo.dir)}`;

  try {
    const prepared = await prepareCreate(
      {
        request: 'planning writes scout state only',
        name,
        root,
        // An explicit repo plus a code root routes to autonomous planning while
        // still including the explicit repo without requiring evidence.
        repos: [repo.dir],
        codeRoots: [codeRoot],
        scout: new ScriptedScout({ kind: 'selection', repos: [], docs: [] }),
      },
      planIo(root)
    );

    assert.equal(prepared.kind, 'ready');
    const ready = prepared as ReadyCreate;
    assert.equal(ready.scoutStateDir, stateDir, 'autonomous planning reports its scout state dir');

    // Allowed side effect: the stale scout observation was removed/rewritten.
    const observedAfter = fs.existsSync(observedPath) ? fs.readFileSync(observedPath, 'utf8') : '';
    assert.doesNotMatch(observedAfter, /STALE/, 'planning may reset stale scout state');

    // Forbidden side effects: no workspace, manifest, branch, or worktree.
    assert.equal(fs.existsSync(wsDir), false, 'planning must not create the workspace');
    assert.equal(fs.existsSync(path.join(wsDir, 'workspace.yaml')), false);
    assert.equal(branchExists(repo.dir, branch), false, 'planning must not create a branch');
    assert.equal(
      worktreeList(repo.dir).some((wt) => wt.branch === branch),
      false,
      'planning must not register a worktree'
    );
  } finally {
    repo.cleanup();
    fs.rmSync(codeRoot, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('infrastructure failures stay failures, not needs_input', async () => {
  const root = mkTmp('wsg-wf-root-');
  const notARepo = mkTmp('wsg-wf-notrepo-');

  try {
    await assert.rejects(
      () =>
        runCreate(
          {
            request: 'not a repo',
            name: 'wf-fail',
            root,
            repos: [notARepo],
          },
          planIo(root)
        ),
      (err: unknown) => err instanceof UsageError && /not a git repository/.test(err.message)
    );
    assert.equal(fs.existsSync(path.join(root, 'wf-fail')), false);
  } finally {
    fs.rmSync(notARepo, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('dry-run assembly validates and reports without publishing a workspace', async () => {
  const repo = createTestRepo({ prefix: 'wsg-wf-dry-' });
  const root = mkTmp('wsg-wf-root-');
  const wsDir = path.join(root, 'wf-dry');
  const branch = `wsg/wf-dry/${path.basename(repo.dir)}`;

  try {
    const prepared = await prepareCreate(
      {
        request: 'dry run plan',
        name: 'wf-dry',
        root,
        repos: [repo.dir],
        scout: new ScriptedScout(selectionFor(repo.dir)),
      },
      planIo(root)
    );
    assert.equal(prepared.kind, 'ready');

    const code = await assemblePrepared(prepared as ReadyCreate, { dryRun: true }, planIo(root));
    assert.equal(code, 0);
    assert.equal(fs.existsSync(wsDir), false, 'dry-run must not create the workspace');
    assert.equal(branchExists(repo.dir, branch), false, 'dry-run must not create a branch');
  } finally {
    repo.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Phase 2: shared coordinator, progress events, questions, and policy
// ---------------------------------------------------------------------------

interface EventCollector {
  events: WorkflowEvent[];
  sink: (event: WorkflowEvent) => void;
}

function collectEvents(): EventCollector {
  const events: WorkflowEvent[] = [];
  return { events, sink: (event) => events.push(event) };
}

function eventStages(events: WorkflowEvent[]): string[] {
  return events.map((e) => `${e.stage}:${e.status}`);
}

function assertEventsBounded(events: WorkflowEvent[]): void {
  for (const event of events) {
    assert.ok(
      event.message.length <= MAX_EVENT_MESSAGE_LENGTH,
      `event message must be bounded: ${event.message}`
    );
    assert.doesNotMatch(event.message, /[\n\r\t]/, 'event messages must be single-line');
  }
}

test('coordinator: clear unattended request terminates created with ordered real progress', async () => {
  const repo = createTestRepo({
    prefix: 'wsg-wf2-created-',
    files: { 'src/Widget.ts': 'export class Widget {}\n' },
  });
  const codeRoot = mkTmp('wsg-wf2-coderoot-');
  const root = mkTmp('wsg-wf2-root-');
  const name = 'wf2-created';
  const wsDir = path.join(root, name);
  const collector = collectEvents();

  try {
    const result = await runCreateWorkflow(
      {
        request: 'coordinate a clear create',
        name,
        root,
        repos: [repo.dir],
        codeRoots: [codeRoot],
        scout: new ScriptedScout({ kind: 'selection', repos: [], docs: [] }),
      },
      planIo(root),
      { policy: { mode: 'unattended' }, events: collector.sink }
    );

    assert.equal(result.status, 'created');
    if (result.status === 'created') {
      assert.equal(result.name, name);
      assert.equal(result.wsDir, wsDir);
      assert.equal(result.resumed, false);
      assert.equal(result.exitCode, 0);
    }

    assert.ok(fs.existsSync(path.join(wsDir, 'workspace.yaml')));
    assert.deepEqual(eventStages(collector.events), [
      'discovery:started',
      'discovery:completed',
      'retrieval:started',
      'retrieval:completed',
      'scout:started',
      'scout:completed',
      'validation:started',
      'validation:completed',
      'plan:completed',
      'assembly:started',
      'assembly:progress',
      'assembly:progress',
      'assembly:progress',
      'assembly:completed',
      'completion:completed',
    ]);
    assertEventsBounded(collector.events);
  } finally {
    repo.cleanup();
    fs.rmSync(codeRoot, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('coordinator: dry-run terminates planned with no assembly events or workspace', async () => {
  const repo = createTestRepo({ prefix: 'wsg-wf2-dry-' });
  const root = mkTmp('wsg-wf2-root-');
  const name = 'wf2-dry';
  const wsDir = path.join(root, name);
  const collector = collectEvents();

  try {
    const result = await runCreateWorkflow(
      {
        request: 'dry run via coordinator',
        name,
        root,
        repos: [repo.dir],
        scout: new ScriptedScout(selectionFor(repo.dir)),
        dryRun: true,
      },
      planIo(root),
      { policy: { mode: 'unattended' }, events: collector.sink }
    );

    assert.equal(result.status, 'planned');
    if (result.status === 'planned') {
      assert.equal(result.resumed, false);
      assert.equal(result.plan?.name, name);
      assert.equal(result.exitCode, 0);
    }
    assert.equal(fs.existsSync(wsDir), false);
    assert.equal(collector.events.some((e) => e.stage === 'assembly'), false);
    assert.ok(eventStages(collector.events).includes('plan:completed'));
    assert.ok(eventStages(collector.events).includes('completion:completed'));
    assertEventsBounded(collector.events);
  } finally {
    repo.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('coordinator: ambiguous request terminates needs_input and cannot create', async () => {
  const repo = createTestRepo({ prefix: 'wsg-wf2-amb-' });
  const codeRoot = mkTmp('wsg-wf2-coderoot-');
  const root = mkTmp('wsg-wf2-root-');
  const name = 'wf2-amb';
  const wsDir = path.join(root, name);
  const collector = collectEvents();

  try {
    const result = await runCreateWorkflow(
      {
        request: 'ambiguous via coordinator',
        name,
        root,
        repos: [repo.dir],
        codeRoots: [codeRoot],
        scout: new ScriptedScout({
          kind: 'ambiguous',
          reason: 'two candidate targets',
          candidates: ['a', 'b'],
          guidance: 'Name the target with --repo.',
        }),
      },
      planIo(root),
      { policy: { mode: 'unattended' }, events: collector.sink }
    );

    assert.equal(result.status, 'needs_input');
    if (result.status === 'needs_input') {
      assert.ok(result.questions.length > 0);
      assert.match(result.reason, /two candidate targets/);
    }
    assert.equal(fs.existsSync(wsDir), false, 'needs_input must not create a workspace');
    assert.equal(collector.events.some((e) => e.stage === 'plan'), false);
    assert.equal(collector.events.some((e) => e.stage === 'assembly'), false);
    assertEventsBounded(collector.events);
  } finally {
    repo.cleanup();
    fs.rmSync(codeRoot, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('coordinator: unsafe (unobserved) evidence stays failed, not needs_input', async () => {
  const repo = createTestRepo({
    prefix: 'wsg-wf2-evidence-',
    files: { 'src/Widget.ts': 'export class Widget {}\n' },
  });
  const codeRoot = mkTmp('wsg-wf2-coderoot-');
  const root = mkTmp('wsg-wf2-root-');
  const name = 'wf2-evidence';
  const wsDir = path.join(root, name);
  const collector = collectEvents();

  fs.symlinkSync(repo.dir, path.join(codeRoot, 'widget-repo'));

  try {
    const discovery = enumerateRepos([codeRoot]);
    const source = discovery.repos[0].source;
    const result = await runCreateWorkflow(
      {
        request: 'unrelated zzz request',
        name,
        root,
        codeRoots: [codeRoot],
        scout: new ScriptedScout({
          kind: 'selection',
          repos: [
            {
              source,
              intent: 'target',
              reason: 'fictional',
              evidence: [
                {
                  file: 'src/Widget.ts',
                  lines: [1, 1],
                  summary: 'Widget',
                  quote: 'export class Widget',
                },
              ],
            },
          ],
          docs: [],
        }),
      },
      planIo(root),
      { policy: { mode: 'unattended' }, events: collector.sink }
    );

    assert.equal(result.status, 'failed');
    if (result.status === 'failed') {
      assert.equal(result.error.code, 'usage');
      assert.equal(result.error.exitCode, 1);
      assert.match(
        result.error.message,
        /never retrieved or observed|unverifiable|without evidence/
      );
    }
    assert.equal(fs.existsSync(wsDir), false);
    assert.ok(collector.events.some((e) => e.stage === 'error' && e.status === 'failed'));
    assertEventsBounded(collector.events);
  } finally {
    repo.cleanup();
    fs.rmSync(codeRoot, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('coordinator: no usable repository terminates needs_input without scouting', async () => {
  const root = mkTmp('wsg-wf2-root-');
  const emptyRoot = mkTmp('wsg-wf2-empty-');
  const collector = collectEvents();

  try {
    const result = await runCreateWorkflow(
      { request: 'nothing here', name: 'wf2-empty', root, codeRoots: [emptyRoot] },
      planIo(root),
      { policy: { mode: 'unattended' }, events: collector.sink }
    );

    assert.equal(result.status, 'needs_input');
    if (result.status === 'needs_input') {
      assert.match(result.reason, /No git repositories found/);
    }
    assert.equal(fs.existsSync(path.join(root, 'wf2-empty')), false);
    assert.equal(collector.events.some((e) => e.stage === 'scout'), false);
    assertEventsBounded(collector.events);
  } finally {
    fs.rmSync(emptyRoot, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('coordinator: interactive policy pauses at plan and honours approve/decline', async () => {
  const repo = createTestRepo({ prefix: 'wsg-wf2-approve-' });
  const root = mkTmp('wsg-wf2-root-');
  const name = 'wf2-approve';
  const wsDir = path.join(root, name);
  const approveEvents = collectEvents();

  try {
    const approved = await runCreateWorkflow(
      {
        request: 'interactive approve',
        name,
        root,
        repos: [repo.dir],
        scout: new ScriptedScout(selectionFor(repo.dir)),
      },
      planIo(root),
      { policy: { mode: 'interactive', approve: () => 'approve' }, events: approveEvents.sink }
    );
    assert.equal(approved.status, 'created');
    assert.ok(fs.existsSync(path.join(wsDir, 'workspace.yaml')));
    const approvedStages = eventStages(approveEvents.events);
    assert.ok(
      approvedStages.indexOf('plan:completed') < approvedStages.indexOf('assembly:started'),
      'plan must be offered for approval before assembly starts'
    );
  } finally {
    repo.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }

  const repo2 = createTestRepo({ prefix: 'wsg-wf2-decline-' });
  const root2 = mkTmp('wsg-wf2-root-');
  const name2 = 'wf2-decline';
  const wsDir2 = path.join(root2, name2);
  const declineEvents = collectEvents();
  try {
    const declined = await runCreateWorkflow(
      {
        request: 'interactive decline',
        name: name2,
        root: root2,
        repos: [repo2.dir],
        scout: new ScriptedScout(selectionFor(repo2.dir)),
      },
      planIo(root2),
      { policy: { mode: 'interactive', approve: () => 'decline' }, events: declineEvents.sink }
    );
    assert.equal(declined.status, 'failed');
    if (declined.status === 'failed') {
      assert.equal(declined.error.code, 'cancelled');
    }
    assert.equal(fs.existsSync(wsDir2), false, 'declined plan must not create a workspace');
    assert.equal(declineEvents.events.some((e) => e.stage === 'assembly'), false);
    assert.ok(declineEvents.events.some((e) => e.stage === 'plan' && e.status === 'failed'));
  } finally {
    repo2.cleanup();
    fs.rmSync(root2, { recursive: true, force: true });
  }
});

test('event messages are bounded and never carry observed file contents', async () => {
  assert.equal(safeEventMessage('a'.repeat(1000)).length, MAX_EVENT_MESSAGE_LENGTH);
  assert.equal(safeEventMessage('line1\nline2\t\t tab  '), 'line1 line2 tab');

  const marker = 'SUPERSECRET_OBSERVED_MARKER_1234567890';
  const repo = createTestRepo({
    prefix: 'wsg-wf2-redact-',
    files: { 'src/secret.ts': `export const token = '${marker}';\n` },
  });
  const root = mkTmp('wsg-wf2-root-');
  const collector = collectEvents();
  try {
    const result = await runCreateWorkflow(
      {
        request: `read ${marker}`,
        name: 'wf2-redact',
        root,
        repos: [repo.dir],
        scout: new ScriptedScout(selectionFor(repo.dir)),
      },
      planIo(root),
      { policy: { mode: 'unattended' }, events: collector.sink }
    );
    assert.equal(result.status, 'created');
    assertEventsBounded(collector.events);
    assert.doesNotMatch(JSON.stringify(collector.events), new RegExp(marker));
  } finally {
    repo.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('coordinator preserves error exit classification and can rethrow for legacy adapters', async () => {
  const repo = createTestRepo({ prefix: 'wsg-wf2-conflict-' });
  const root = mkTmp('wsg-wf2-root-');
  const name = 'wf2-conflict';
  const branch = `wsg/${name}/${path.basename(repo.dir)}`;
  runGit(['-C', repo.dir, 'branch', branch, repo.headCommit]);

  try {
    const result = await runCreateWorkflow(
      { request: 'conflict', name, root, repos: [repo.dir] },
      planIo(root),
      { policy: { mode: 'unattended' } }
    );
    assert.equal(result.status, 'failed');
    if (result.status === 'failed') {
      assert.equal(result.error.code, 'conflict');
      assert.equal(result.error.exitCode, 2);
      assert.match(result.error.message, /already exists/);
    }
    assert.equal(fs.existsSync(path.join(root, name)), false);

    await assert.rejects(
      () =>
        runCreateWorkflow(
          { request: 'conflict', name, root, repos: [repo.dir] },
          planIo(root),
          { policy: { mode: 'unattended' }, throwOnFailure: true }
        ),
      (err: unknown) => err instanceof ConflictError
    );
  } finally {
    repo.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('coordinator distinguishes resumed assembly from fresh planning', async () => {
  const repo = createTestRepo({ prefix: 'wsg-wf2-resume-' });
  const root = mkTmp('wsg-wf2-root-');
  const docDir = mkTmp('wsg-wf2-doc-');
  const docPath = path.join(docDir, 'notes.md');
  fs.writeFileSync(docPath, 'resume notes\n');
  const name = 'wf2-resume';
  const wsDir = path.join(root, name);
  const freshEvents = collectEvents();

  try {
    const interrupted = await runCreateWorkflow(
      {
        request: 'resume via coordinator',
        name,
        root,
        repos: [repo.dir],
        docs: [docPath],
        scout: new ScriptedScout({
          kind: 'selection',
          repos: [{ source: repo.dir }],
          docs: [{ input: docPath }],
        }),
        _beforeSnapshotWrite: () => {
          throw new Error('injected interruption before snapshot');
        },
      },
      planIo(root),
      { policy: { mode: 'unattended' }, events: freshEvents.sink }
    );
    assert.equal(interrupted.status, 'failed');
    assert.equal(fs.existsSync(path.join(wsDir, 'workspace.yaml')), false);
    assert.ok(freshEvents.events.some((e) => e.stage === 'scout'));

    const resumeEvents = collectEvents();
    const resumed = await runCreateWorkflow(
      {
        request: 'resume via coordinator',
        name,
        root,
        repos: [repo.dir],
        docs: [docPath],
        resume: true,
      },
      planIo(root),
      { policy: { mode: 'unattended' }, events: resumeEvents.sink }
    );

    assert.equal(resumed.status, 'created');
    if (resumed.status === 'created') {
      assert.equal(resumed.resumed, true);
      assert.equal(resumed.name, name);
    }
    assert.ok(fs.existsSync(path.join(wsDir, 'workspace.yaml')));
    const stages = eventStages(resumeEvents.events);
    assert.equal(stages.some((s) => s.startsWith('discovery')), false);
    assert.equal(stages.some((s) => s.startsWith('scout')), false);
    assert.equal(stages.some((s) => s.startsWith('plan')), false);
    assert.ok(stages.includes('assembly:started'));
    assert.ok(stages.includes('assembly:completed'));
    assert.ok(stages.includes('completion:completed'));
    assertEventsBounded(resumeEvents.events);
  } finally {
    repo.cleanup();
    fs.rmSync(docDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('coordinator: cancellation at confirmation never creates a workspace', async () => {
  const repo = createTestRepo({ prefix: 'wsg-wf2-cancel-' });
  const root = mkTmp('wsg-wf2-root-');
  const name = 'wf2-cancel';
  const wsDir = path.join(root, name);
  const collector = collectEvents();
  const controller = new AbortController();

  try {
    const result = await runCreateWorkflow(
      {
        request: 'cancel at confirmation',
        name,
        root,
        repos: [repo.dir],
        scout: new ScriptedScout(selectionFor(repo.dir)),
      },
      planIo(root),
      {
        policy: {
          mode: 'interactive',
          approve: () => {
            controller.abort();
            return 'approve';
          },
        },
        events: collector.sink,
        signal: controller.signal,
      }
    );

    assert.equal(result.status, 'failed');
    if (result.status === 'failed') {
      assert.equal(result.error.code, 'cancelled');
    }
    assert.equal(fs.existsSync(wsDir), false, 'cancelled workflow must not create a workspace');
    assert.equal(collector.events.some((e) => e.stage === 'assembly'), false);
  } finally {
    repo.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('coordinator: pre-aborted signal terminates cancelled without planning', async () => {
  const root = mkTmp('wsg-wf2-root-');
  const controller = new AbortController();
  controller.abort();
  const collector = collectEvents();

  try {
    const result = await runCreateWorkflow(
      { request: 'pre-aborted', name: 'wf2-preabort', root, repos: ['/nonexistent-repo'] },
      planIo(root),
      { policy: { mode: 'unattended' }, events: collector.sink, signal: controller.signal }
    );

    assert.equal(result.status, 'failed');
    if (result.status === 'failed') {
      assert.equal(result.error.code, 'cancelled');
    }
    assert.equal(fs.existsSync(path.join(root, 'wf2-preabort')), false);
    assert.equal(collector.events.length, 1);
    assert.equal(collector.events[0].stage, 'completion');
    assert.equal(collector.events[0].status, 'failed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
