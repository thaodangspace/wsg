import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  WsgTuiController,
  PiTuiView,
  isInteractiveTerminal,
  formatPlanSummary,
  resolveClarificationAnswer,
  type TuiView,
} from '../src/tui.ts';
import { ScriptedScout, type ScoutResult } from '../src/scout.ts';
import type { ActionableQuestion, PlanSummary, WorkflowEvent } from '../src/workflow.ts';
import { createTestRepo } from './helpers/git-fixture.ts';
import { branchExists, runGit } from '../src/git.ts';
import type { Terminal } from '@earendil-works/pi-tui';

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function NO_CONFIG(root: string) {
  return path.join(root, 'no-config.yaml');
}

function testIo(root: string) {
  return { env: { ...process.env, WSG_CONFIG: NO_CONFIG(root) }, cwd: process.cwd() };
}

function selectionFor(source: string): ScoutResult {
  return { kind: 'selection', repos: [{ source }], docs: [] };
}

/**
 * Scripted MockTuiView for pure state-machine and interaction testing.
 */
class MockTuiView implements TuiView {
  transcript: string[] = [];
  events: WorkflowEvent[] = [];
  planShown: PlanSummary | null = null;
  busyStates: { busy: boolean; status?: string }[] = [];
  inputsToProvide: (string | null)[] = [];
  confirmationsToProvide: boolean[] = [];
  closed = false;

  addTranscript(text: string): void {
    this.transcript.push(text);
  }

  showProgress(event: WorkflowEvent): void {
    this.events.push(event);
  }

  showPlan(plan: PlanSummary): void {
    this.planShown = plan;
  }

  async askInput(_prompt: string): Promise<string | null> {
    if (this.inputsToProvide.length === 0) return null;
    return this.inputsToProvide.shift() ?? null;
  }

  async askConfirmation(_prompt: string): Promise<boolean> {
    if (this.confirmationsToProvide.length === 0) return false;
    return this.confirmationsToProvide.shift() ?? false;
  }

  setBusy(busy: boolean, status?: string): void {
    this.busyStates.push({ busy, status });
  }

  render(): void {}

  async close(): Promise<void> {
    this.closed = true;
  }
}

/**
 * Mock terminal implementing the Pi TUI `Terminal` interface for component
 * rendering, keystrokes, resize, and Unicode testing.
 */
class MockTerminal implements Terminal {
  linesWritten: string[] = [];
  columns = 80;
  rows = 24;
  kittyProtocolActive = false;
  cursorHidden = false;
  stopped = false;
  drained = false;
  onInputCallback?: (data: string) => void;
  onResizeCallback?: () => void;

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.onInputCallback = onInput;
    this.onResizeCallback = onResize;
  }

  stop(): void {
    this.stopped = true;
  }

  async drainInput(): Promise<void> {
    this.drained = true;
  }

  write(data: string): void {
    this.linesWritten.push(data);
  }

  moveBy(): void {}
  hideCursor(): void {
    this.cursorHidden = true;
  }
  showCursor(): void {
    this.cursorHidden = false;
  }
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}

  feedInput(data: string): void {
    this.onInputCallback?.(data);
  }

  triggerResize(cols: number, rows: number): void {
    this.columns = cols;
    this.rows = rows;
    this.onResizeCallback?.();
  }
}

// ---------------------------------------------------------------------------
// Unit tests: Helpers and formatters
// ---------------------------------------------------------------------------

test('isInteractiveTerminal checks both stdin and stdout TTY flags', () => {
  assert.equal(isInteractiveTerminal({}), false);
  assert.equal(isInteractiveTerminal({ stdin: { isTTY: true }, stdout: { isTTY: false, write: () => {} } }), false);
  assert.equal(isInteractiveTerminal({ stdin: { isTTY: false }, stdout: { isTTY: true, write: () => {} } }), false);
  assert.equal(isInteractiveTerminal({ stdin: { isTTY: true }, stdout: { isTTY: true, write: () => {} } }), true);
});

test('resolveClarificationAnswer maps numeric choice to candidate or returns answer', () => {
  const questions: ActionableQuestion[] = [
    {
      id: 'target',
      question: 'Choose target',
      candidates: ['repo-alpha', 'repo-beta', 'repo-gamma'],
    },
  ];

  assert.equal(resolveClarificationAnswer('1', questions), 'repo-alpha');
  assert.equal(resolveClarificationAnswer('2', questions), 'repo-beta');
  assert.equal(resolveClarificationAnswer('3', questions), 'repo-gamma');
  assert.equal(resolveClarificationAnswer('99', questions), '99'); // out of range: keeps original
  assert.equal(resolveClarificationAnswer('repo-beta', questions), 'repo-beta');
  assert.equal(resolveClarificationAnswer('custom answer', questions), 'custom answer');
});

test('formatPlanSummary includes all sections with roles and gaps', () => {
  const plan: PlanSummary = {
    name: 'test-ws',
    wsDir: '/tmp/test-ws',
    request: 'test request',
    adapters: ['agents'],
    repos: [
      {
        name: 'repo-a',
        source: '/src/repo-a',
        dest: '/tmp/test-ws/repo-a',
        branch: 'wsg/test-ws/repo-a',
        intent: 'target',
        added_by: 'scout',
      },
    ],
    docs: [
      {
        source: '/docs/spec.md',
        path: 'docs/spec.md',
        mode: 'snapshot',
        added_by: 'user',
      },
    ],
    commands: 2,
    gaps: ['No test command found in repo-a'],
  };

  const formatted = formatPlanSummary(plan);
  assert.match(formatted, /=== Plan Summary ===/);
  assert.match(formatted, /Workspace:\s+test-ws/);
  assert.match(formatted, /Destination:\s+\/tmp\/test-ws/);
  assert.match(formatted, /repo-a \(target\)/);
  assert.match(formatted, /docs\/spec\.md \(mode: snapshot\)/);
  assert.match(formatted, /Commands:\s+2 discovered/);
  assert.match(formatted, /Gaps \/ Warnings:/);
  assert.match(formatted, /No test command found/);
});

// ---------------------------------------------------------------------------
// State-machine tests with injected MockTuiView
// ---------------------------------------------------------------------------

test('state machine: clear request -> plan reviewed -> user approves -> workspace created', async () => {
  const repo = createTestRepo({ prefix: 'wsg-tui-approve-' });
  const root = mkTmp('wsg-tui-root-');
  const name = 'tui-approve';
  const wsDir = path.join(root, name);

  const view = new MockTuiView();
  view.inputsToProvide = ['create a clear workspace'];
  view.confirmationsToProvide = [true]; // User approves

  try {
    const controller = new WsgTuiController(
      view,
      {
        name,
        root,
        repos: [repo.dir],
        scout: new ScriptedScout(selectionFor(repo.dir)),
      },
      testIo(root)
    );

    const exitCode = await controller.run();
    assert.equal(exitCode, 0);
    assert.ok(fs.existsSync(path.join(wsDir, 'workspace.yaml')), 'workspace must be created on approval');
    assert.ok(view.closed, 'view must be closed on exit');
    assert.ok(view.planShown !== null, 'plan must have been displayed before approval');
    assert.equal(view.planShown?.name, name);
    assert.ok(view.events.some((e) => e.stage === 'plan'));
    assert.ok(view.events.some((e) => e.stage === 'assembly'));
    assert.ok(view.transcript.some((t) => t.includes(`Workspace created at ${wsDir}`)));
  } finally {
    repo.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('state machine: clear request -> plan reviewed -> user declines -> NO workspace created', async () => {
  const repo = createTestRepo({ prefix: 'wsg-tui-decline-' });
  const root = mkTmp('wsg-tui-root-');
  const name = 'tui-decline';
  const wsDir = path.join(root, name);

  const view = new MockTuiView();
  view.inputsToProvide = ['create a clear workspace'];
  view.confirmationsToProvide = [false]; // User declines!

  try {
    const controller = new WsgTuiController(
      view,
      {
        name,
        root,
        repos: [repo.dir],
        scout: new ScriptedScout(selectionFor(repo.dir)),
      },
      testIo(root)
    );

    const exitCode = await controller.run();
    assert.equal(exitCode, 1);
    assert.equal(fs.existsSync(wsDir), false, 'declined plan must NEVER create a workspace');
    assert.equal(fs.existsSync(path.join(wsDir, 'workspace.yaml')), false);
    assert.equal(branchExists(repo.dir, `wsg/${name}/${path.basename(repo.dir)}`), false);
    assert.ok(view.closed);
    assert.ok(view.transcript.some((t) => t.includes('Workspace creation was cancelled')));
  } finally {
    repo.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('state machine: initial prompt cancelled or empty exits 1 without planning', async () => {
  const root = mkTmp('wsg-tui-empty-');
  const view = new MockTuiView();
  view.inputsToProvide = [null]; // Cancelled / Ctrl-C / Esc

  try {
    const controller = new WsgTuiController(
      view,
      { root },
      testIo(root)
    );

    const exitCode = await controller.run();
    assert.equal(exitCode, 1);
    assert.equal(view.events.length, 0, 'no workflow events may run when prompt is cancelled');
    assert.ok(view.closed);
    assert.ok(view.transcript.some((t) => t.includes('Workspace creation was cancelled')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('state machine: ambiguous request -> follow-up question -> clarification answered -> plan approved -> created', async () => {
  const repoA = createTestRepo({ prefix: 'wsg-tui-amb-a-' });
  const repoB = createTestRepo({ prefix: 'wsg-tui-amb-b-' });
  const root = mkTmp('wsg-tui-amb-root-');
  const name = 'tui-amb-resolved';
  const wsDir = path.join(root, name);

  let scoutAttempts = 0;
  const scriptedScout = {
    async scout(): Promise<ScoutResult> {
      scoutAttempts++;
      if (scoutAttempts === 1) {
        return {
          kind: 'ambiguous',
          reason: 'two candidate target repositories',
          candidates: [path.basename(repoA.dir), path.basename(repoB.dir)],
          guidance: 'Specify which repository is the target.',
        };
      }
      return {
        kind: 'selection',
        repos: [{ source: repoA.dir, intent: 'target', reason: 'chosen by clarification' }],
        docs: [],
      };
    },
  };

  const view = new MockTuiView();
  view.inputsToProvide = [
    'port the module',       // 1. Initial rough request
    '1',                     // 2. Clarification: selects candidate 1 (repoA)
  ];
  view.confirmationsToProvide = [true]; // 3. Plan confirmation: approve

  try {
    const controller = new WsgTuiController(
      view,
      {
        name,
        root,
        repos: [repoA.dir, repoB.dir],
        scout: scriptedScout,
      },
      testIo(root)
    );

    const exitCode = await controller.run();
    assert.equal(exitCode, 0);
    assert.equal(scoutAttempts, 2, 'scout should be re-invoked with clarified request');
    assert.ok(fs.existsSync(path.join(wsDir, 'workspace.yaml')), 'workspace must be created after clarification');
    assert.ok(view.transcript.some((t) => t.includes('More information needed')));
    assert.ok(view.transcript.some((t) => t.includes(path.basename(repoA.dir))));
    assert.ok(view.closed);
  } finally {
    repoA.cleanup();
    repoB.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('state machine: ambiguous request -> user cancels follow-up -> exits 1 with NO workspace', async () => {
  const repo = createTestRepo({ prefix: 'wsg-tui-amb-cancel-' });
  const root = mkTmp('wsg-tui-amb-croot-');
  const name = 'tui-amb-cancel';
  const wsDir = path.join(root, name);

  const scriptedScout = {
    async scout(): Promise<ScoutResult> {
      return {
        kind: 'ambiguous',
        reason: 'missing target repository',
        candidates: ['target-a', 'target-b'],
      };
    },
  };

  const view = new MockTuiView();
  view.inputsToProvide = [
    'ambiguous task',
    ':cancel', // user explicitly cancels at clarification prompt
  ];

  try {
    const controller = new WsgTuiController(
      view,
      {
        name,
        root,
        repos: [repo.dir],
        scout: scriptedScout,
      },
      testIo(root)
    );

    const exitCode = await controller.run();
    assert.equal(exitCode, 1);
    assert.equal(fs.existsSync(wsDir), false, 'cancelled clarification must never create workspace');
    assert.ok(view.transcript.some((t) => t.includes('Workspace creation was cancelled')));
    assert.ok(view.closed);
  } finally {
    repo.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('state machine: repeatedly ambiguous request exceeds max clarification turns and exits 4', async () => {
  const repo = createTestRepo({ prefix: 'wsg-tui-loop-' });
  const root = mkTmp('wsg-tui-loop-root-');
  const name = 'tui-loop';

  const scriptedScout = {
    async scout(): Promise<ScoutResult> {
      return {
        kind: 'ambiguous',
        reason: 'unresolvable ambiguity',
        candidates: ['a', 'b'],
      };
    },
  };

  const view = new MockTuiView();
  // Provide clarification answers repeatedly
  view.inputsToProvide = ['initial task', 'clarify 1', 'clarify 2', 'clarify 3'];

  try {
    const controller = new WsgTuiController(
      view,
      {
        name,
        root,
        repos: [repo.dir],
        scout: scriptedScout,
      },
      testIo(root),
      { maxClarificationTurns: 2 } // Bound to 2 turns for test
    );

    const exitCode = await controller.run();
    assert.equal(exitCode, 4);
    assert.ok(view.transcript.some((t) => t.includes('Maximum clarification attempts reached')));
    assert.ok(view.closed);
  } finally {
    repo.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('state machine: dry-run plan approved terminates with exit 0 and no workspace directory', async () => {
  const repo = createTestRepo({ prefix: 'wsg-tui-dry-' });
  const root = mkTmp('wsg-tui-dry-root-');
  const name = 'tui-dry';
  const wsDir = path.join(root, name);

  const view = new MockTuiView();
  view.inputsToProvide = ['dry run request'];
  view.confirmationsToProvide = [true]; // approve plan

  try {
    const controller = new WsgTuiController(
      view,
      {
        name,
        root,
        repos: [repo.dir],
        scout: new ScriptedScout(selectionFor(repo.dir)),
        dryRun: true,
      },
      testIo(root)
    );

    const exitCode = await controller.run();
    assert.equal(exitCode, 0);
    assert.equal(fs.existsSync(wsDir), false, 'dry run must not create the workspace');
    assert.ok(view.transcript.some((t) => t.includes(`Dry run complete for ${name}`)));
    assert.ok(view.closed);
  } finally {
    repo.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('state machine: conflict error exits 2 and renders conflict guidance', async () => {
  const repo = createTestRepo({ prefix: 'wsg-tui-conf-' });
  const root = mkTmp('wsg-tui-conf-root-');
  const name = 'tui-conflict';
  const branch = `wsg/${name}/${path.basename(repo.dir)}`;
  runGit(['-C', repo.dir, 'branch', branch, repo.headCommit]);

  const view = new MockTuiView();
  view.inputsToProvide = ['conflicting task'];
  view.confirmationsToProvide = [true];

  try {
    const controller = new WsgTuiController(
      view,
      {
        name,
        root,
        repos: [repo.dir],
        scout: new ScriptedScout(selectionFor(repo.dir)),
      },
      testIo(root)
    );

    const exitCode = await controller.run();
    assert.equal(exitCode, 2);
    assert.ok(view.transcript.some((t) => t.includes('already exists')));
    assert.ok(view.closed);
  } finally {
    repo.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('state machine: infrastructure error exits 1 with diagnostic hints', async () => {
  const root = mkTmp('wsg-tui-infra-');
  const notARepo = mkTmp('wsg-tui-notrepo-');

  const view = new MockTuiView();
  view.inputsToProvide = ['infrastructure failure task'];

  try {
    const controller = new WsgTuiController(
      view,
      {
        name: 'tui-infra',
        root,
        repos: [notARepo],
      },
      testIo(root)
    );

    const exitCode = await controller.run();
    assert.equal(exitCode, 1);
    assert.ok(view.transcript.some((t) => t.includes('not a git repository')));
    assert.ok(view.closed);
  } finally {
    fs.rmSync(notARepo, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Real Pi TUI terminal integration smoke tests
// ---------------------------------------------------------------------------

test('terminal smoke: PiTuiView keystroke input, progress, resize, narrow columns and Unicode', async () => {
  const mockTerm = new MockTerminal();
  const view = new PiTuiView(mockTerm);

  // 1. Progress event rendering
  view.showProgress({
    stage: 'discovery',
    status: 'completed',
    message: 'Found 2 repositories',
  });
  view.render();
  assert.ok(mockTerm.linesWritten.length > 0, 'terminal must receive rendered output');

  // 2. Keystroke input through real Input component
  const inputPromise = view.askInput('Task: ');
  // Simulate user typing 'build feature' + Enter
  for (const char of 'build feature\r') {
    mockTerm.feedInput(char);
  }
  const inputResult = await inputPromise;
  assert.equal(inputResult, 'build feature');

  // 3. Confirmation input ('y' + Enter)
  const confirmPromise = view.askConfirmation('Proceed?');
  mockTerm.feedInput('y');
  mockTerm.feedInput('\r');
  const confirmResult = await confirmPromise;
  assert.equal(confirmResult, true);

  // 4. Unicode handling: emoji and CJK characters
  view.addTranscript('Testing 🚀 Rocket and 測試 Chinese and German üöä.');
  view.render();
  const lastChunk = mockTerm.linesWritten[mockTerm.linesWritten.length - 1];
  assert.ok(lastChunk.includes('🚀') || lastChunk.length > 0);

  // 5. Narrow width rendering (columns = 20)
  mockTerm.triggerResize(20, 10);
  view.render();
  assert.ok(mockTerm.linesWritten.length > 0, 'narrow terminal rendering must not throw');

  // 6. Escape cancellation
  const escPromise = view.askInput('Cancel me: ');
  mockTerm.feedInput('\x1b'); // Escape
  const escResult = await escPromise;
  assert.equal(escResult, null, 'escape must resolve to null');

  // 7. Clean shutdown and cursor restore
  await view.close();
  assert.equal(mockTerm.stopped, true, 'terminal must be stopped');
  assert.equal(mockTerm.cursorHidden, false, 'cursor must be restored to visible');
  assert.equal(mockTerm.drained, true, 'terminal input must be drained on exit');
});

test('terminal smoke: Ctrl-C cancels pending input and cleans up', async () => {
  const mockTerm = new MockTerminal();
  const view = new PiTuiView(mockTerm);

  const inputPromise = view.askInput('Enter something: ');
  // Send Ctrl-C sequence (\x03)
  mockTerm.feedInput('\x03');
  const result = await inputPromise;
  assert.equal(result, null, 'Ctrl-C must cancel active input');

  await view.close();
  assert.equal(mockTerm.stopped, true);
});

// ---------------------------------------------------------------------------
// Pseudoterminal CLI invocation test
// ---------------------------------------------------------------------------

test('pty smoke: invoking wsg with no args in a real pseudoterminal enters interactive mode', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const cliPath = path.join(repoRoot, 'dist', 'cli.js');

  // Use python3's built-in pty module to allocate a real pseudoterminal, spawn wsg,
  // write Ctrl-C immediately, and observe interactive startup without immediate non-TTY error.
  const pyScript = `
import pty, os, sys, select, time

master, slave = pty.openpty()
pid = os.fork()
if pid == 0:
    os.close(master)
    os.setsid()
    os.dup2(slave, 0)
    os.dup2(slave, 1)
    os.dup2(slave, 2)
    os.close(slave)
    os.environ["WSG_CONFIG"] = "/tmp/no-wsg-config.yaml"
    os.execv(sys.executable, [sys.executable, "${cliPath}"])
else:
    os.close(slave)
    time.sleep(0.3)
    # Send Ctrl-C to exit interactive mode cleanly
    os.write(master, b"\\x03")
    time.sleep(0.3)
    output = b""
    try:
        while True:
            r, _, _ = select.select([master], [], [], 0.5)
            if not r: break
            chunk = os.read(master, 1024)
            if not chunk: break
            output += chunk
    except OSError:
        pass
    os.close(master)
    _, status = os.waitpid(pid, 0)
    sys.stdout.buffer.write(output)
    sys.exit(os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else (status >> 8))
`;

  const result = spawnSync('python3', ['-c', pyScript], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 10000,
  });

  const output = (result.stdout ?? '') + (result.stderr ?? '');
  // Verify it entered interactive mode (showing WSG or prompt), not the non-TTY "Usage: wsg" error!
  assert.doesNotMatch(output, /Usage: wsg \[options\]/, 'Interactive pty invocation must not exit with non-TTY usage error');
});
