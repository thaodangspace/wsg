import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestRepo } from './helpers/git-fixture.ts';
import { enumerateRepos } from '../src/discovery.ts';
import {
  PiScout,
  confinedRepoFile,
  SCOUT_DB_FILENAME,
  SCOUT_CHECKPOINT_FILENAME,
  SCOUT_BUDGET_FILENAME,
} from '../src/pi-scout.ts';
import { UsageError, ConflictError } from '../src/errors.ts';

let piAvailable = true;
try {
  const spec: string = '@earendil-works/pi-durable';
  await import(spec);
} catch {
  piAvailable = false;
}
const skip = piAvailable ? false : 'Pi Durable packages are not installed';

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function setupRepo() {
  const codeRoot = tmp('wsg-pi-');
  const repo = createTestRepo({
    prefix: 'wsg-pi-repo-',
    files: {
      'src/Widget.ts': 'export class Widget {\n  size = 1;\n}\n',
      'README.md': '# Widget Repo\n',
    },
  });
  fs.symlinkSync(repo.dir, path.join(codeRoot, 'widget-repo'));
  return { codeRoot, repo };
}

const selectionPayload = {
  repos: [
    {
      source: 'widget-repo',
      intent: 'target',
      reason: 'owns the Widget implementation',
      evidence: [
        { file: 'src/Widget.ts', lines: [1, 3], summary: 'Widget class', quote: 'export class Widget' },
      ],
    },
  ],
  exclusions: [],
  gaps: [],
  context: [],
};

test('PiScout runs one real Pi Durable conversation and persists a checkpoint', { skip }, async () => {
  const { codeRoot, repo } = setupRepo();
  const stateDir = path.join(tmp('wsg-pi-state-'), 'scout');
  try {
    const discovery = enumerateRepos([codeRoot]);
    const scout = new PiScout({
      discovered: discovery.repos,
      provider: 'faux',
      fauxScript: [
        { tool: 'list_repos', args: {} },
        { tool: 'read_file', args: { repo: 'widget-repo', path: 'src/Widget.ts' } },
        { tool: 'submit_selection', args: selectionPayload },
      ],
    });

    const result = await scout.scout({ request: 'port widget', codeRoots: [codeRoot], stateDir });
    assert.equal(result.kind, 'selection');
    if (result.kind === 'selection') {
      assert.equal(result.repos.length, 1);
      assert.equal(result.repos[0].source, 'widget-repo');
      assert.equal(result.repos[0].intent, 'target');
    }
    assert.ok(fs.existsSync(path.join(stateDir, SCOUT_DB_FILENAME)), 'SQLite checkpoint must exist');
    assert.ok(fs.existsSync(path.join(stateDir, SCOUT_CHECKPOINT_FILENAME)), 'selection checkpoint must exist');
  } finally {
    repo.cleanup();
    fs.rmSync(codeRoot, { recursive: true, force: true });
    fs.rmSync(path.dirname(stateDir), { recursive: true, force: true });
  }
});

test('rg_search returns matching files through the real harness tool', { skip }, async () => {
  const { codeRoot, repo } = setupRepo();
  fs.writeFileSync(path.join(repo.dir, 'secret.pem'), 'Widget private material\n');
  const stateDir = path.join(tmp('wsg-pi-rg-'), 'scout');
  try {
    const discovery = enumerateRepos([codeRoot]);
    const observed: string[] = [];
    const scout = new PiScout({
      discovered: discovery.repos,
      provider: 'faux',
      onObserve: (_source, relPath) => observed.push(relPath),
      fauxScript: [
        { tool: 'rg_search', args: { query: 'Widget', repo: 'widget-repo' } },
        { tool: 'submit_selection', args: selectionPayload },
      ],
    });

    const result = await scout.scout({ request: 'find widget', codeRoots: [codeRoot], stateDir });
    assert.equal(result.kind, 'selection');
    assert.ok(
      observed.some((p) => p === 'src/Widget.ts'),
      `rg_search must report the matching source file, observed=${JSON.stringify(observed)}`
    );
    assert.ok(
      !observed.some((p) => p.endsWith('.pem')),
      'rg_search must not surface secret-like files'
    );
  } finally {
    repo.cleanup();
    fs.rmSync(codeRoot, { recursive: true, force: true });
    fs.rmSync(path.dirname(stateDir), { recursive: true, force: true });
  }
});

test('PiScout returns an ambiguous result without guessing', { skip }, async () => {
  const { codeRoot, repo } = setupRepo();
  const stateDir = path.join(tmp('wsg-pi-amb-'), 'scout');
  try {
    const discovery = enumerateRepos([codeRoot]);
    const scout = new PiScout({
      discovered: discovery.repos,
      provider: 'faux',
      fauxScript: [
        {
          tool: 'submit_selection',
          args: { ...selectionPayload, ambiguous: true, ambiguousReason: 'two candidate targets' },
        },
      ],
    });
    const result = await scout.scout({ request: 'ambiguous', codeRoots: [codeRoot], stateDir });
    assert.equal(result.kind, 'ambiguous');
    if (result.kind === 'ambiguous') {
      assert.match(result.reason, /two candidate targets/);
    }
  } finally {
    repo.cleanup();
    fs.rmSync(codeRoot, { recursive: true, force: true });
    fs.rmSync(path.dirname(stateDir), { recursive: true, force: true });
  }
});

test('PiScout resumes from the SQLite checkpoint after a simulated crash', { skip }, async () => {
  const { codeRoot, repo } = setupRepo();
  const stateDir = path.join(tmp('wsg-pi-resume-'), 'scout');
  try {
    const discovery = enumerateRepos([codeRoot]);
    const script = [
      { tool: 'read_file', args: { repo: 'widget-repo', path: 'src/Widget.ts' } },
      { tool: 'submit_selection', args: selectionPayload },
    ];

    const crashing = new PiScout({
      discovered: discovery.repos,
      provider: 'faux',
      fauxScript: script,
      haltAfterTool: 'read_file',
    });
    await assert.rejects(
      async () => crashing.scout({ request: 'port widget', codeRoots: [codeRoot], stateDir }),
      'the simulated crash must reject the first scout run'
    );
    assert.ok(fs.existsSync(path.join(stateDir, SCOUT_DB_FILENAME)), 'checkpoint survives the crash');
    assert.equal(
      fs.existsSync(path.join(stateDir, SCOUT_CHECKPOINT_FILENAME)),
      false,
      'no completed checkpoint is written when the run crashes'
    );

    const resumed = new PiScout({
      discovered: discovery.repos,
      provider: 'faux',
      fauxScript: script,
    });
    const result = await resumed.scout({
      request: 'port widget',
      codeRoots: [codeRoot],
      stateDir,
      resume: true,
    });
    assert.equal(result.kind, 'selection');
    if (result.kind === 'selection') {
      assert.equal(result.repos[0].source, 'widget-repo');
    }
  } finally {
    repo.cleanup();
    fs.rmSync(codeRoot, { recursive: true, force: true });
    fs.rmSync(path.dirname(stateDir), { recursive: true, force: true });
  }
});

test('PiScout refuses to replay a cached selection for a changed request', { skip }, async () => {
  const { codeRoot, repo } = setupRepo();
  const stateDir = path.join(tmp('wsg-pi-identity-'), 'scout');
  try {
    const discovery = enumerateRepos([codeRoot]);
    const first = new PiScout({
      discovered: discovery.repos,
      provider: 'faux',
      fauxScript: [{ tool: 'submit_selection', args: selectionPayload }],
    });
    await first.scout({ request: 'port widget', codeRoots: [codeRoot], stateDir });

    const changed = new PiScout({
      discovered: discovery.repos,
      provider: 'faux',
      fauxScript: [{ tool: 'submit_selection', args: selectionPayload }],
    });
    await assert.rejects(
      () =>
        changed.scout({
          request: 'a completely different task',
          codeRoots: [codeRoot],
          stateDir,
          resume: true,
        }),
      (err: unknown) => err instanceof ConflictError && /does not match/.test(err.message)
    );
  } finally {
    repo.cleanup();
    fs.rmSync(codeRoot, { recursive: true, force: true });
    fs.rmSync(path.dirname(stateDir), { recursive: true, force: true });
  }
});

test('PiScout reuses a completed checkpoint on resume without reopening the harness', { skip }, async () => {
  const { codeRoot, repo } = setupRepo();
  const stateDir = path.join(tmp('wsg-pi-cache-'), 'scout');
  try {
    const discovery = enumerateRepos([codeRoot]);
    const first = new PiScout({
      discovered: discovery.repos,
      provider: 'faux',
      fauxScript: [{ tool: 'submit_selection', args: selectionPayload }],
    });
    await first.scout({ request: 'port widget', codeRoots: [codeRoot], stateDir });

    // No faux script at all: if the harness ran, it would submit an empty
    // selection and fail. A cached result proves the conversation was not rerun.
    const second = new PiScout({ discovered: discovery.repos, provider: 'faux', fauxScript: [] });
    const result = await second.scout({
      request: 'port widget',
      codeRoots: [codeRoot],
      stateDir,
      resume: true,
    });
    assert.equal(result.kind, 'selection');
  } finally {
    repo.cleanup();
    fs.rmSync(codeRoot, { recursive: true, force: true });
    fs.rmSync(path.dirname(stateDir), { recursive: true, force: true });
  }
});

test('an uncooperative provider is stopped by the durable tool budget', { skip }, async () => {
  const { codeRoot, repo } = setupRepo();
  const stateDir = path.join(tmp('wsg-pi-budget-'), 'scout');
  try {
    const discovery = enumerateRepos([codeRoot]);
    const scout = new PiScout({
      discovered: discovery.repos,
      provider: 'faux',
      maxToolCalls: 1,
      // The provider only ever calls list_repos; it never submits.
      fauxScript: [{ tool: 'list_repos', args: {} }],
    });
    const result = await scout.scout({ request: 'uncooperative', codeRoots: [codeRoot], stateDir });
    assert.equal(result.kind, 'none');
    if (result.kind === 'none') {
      assert.match(result.reason, /budget/);
    }
    const budget = JSON.parse(fs.readFileSync(path.join(stateDir, SCOUT_BUDGET_FILENAME), 'utf8'));
    assert.match(String(budget.exhausted), /budget/);
  } finally {
    repo.cleanup();
    fs.rmSync(codeRoot, { recursive: true, force: true });
    fs.rmSync(path.dirname(stateDir), { recursive: true, force: true });
  }
});

test('a resumed scout past an exhausted budget performs no further work', { skip }, async () => {
  const { codeRoot, repo } = setupRepo();
  const stateDir = path.join(tmp('wsg-pi-budget-resume-'), 'scout');
  try {
    const discovery = enumerateRepos([codeRoot]);
    const first = new PiScout({
      discovered: discovery.repos,
      provider: 'faux',
      maxToolCalls: 1,
      fauxScript: [{ tool: 'list_repos', args: {} }],
    });
    const firstResult = await first.scout({ request: 'uncooperative', codeRoots: [codeRoot], stateDir });
    assert.equal(firstResult.kind, 'none');

    // Simulate resuming after a crash that lost the completed checkpoint but
    // kept the durable budget accounting.
    fs.rmSync(path.join(stateDir, SCOUT_CHECKPOINT_FILENAME), { force: true });

    const observed: string[] = [];
    const resumed = new PiScout({
      discovered: discovery.repos,
      provider: 'faux',
      onObserve: (_s, p) => observed.push(p),
      // Would submit if the harness ran; the exhausted budget must prevent that.
      fauxScript: [{ tool: 'submit_selection', args: selectionPayload }],
    });
    const result = await resumed.scout({
      request: 'uncooperative',
      codeRoots: [codeRoot],
      stateDir,
      resume: true,
    });
    assert.equal(result.kind, 'none');
    assert.match(result.kind === 'none' ? result.reason : '', /budget/);
    assert.deepEqual(observed, [], 'no tools may run when the durable budget is exhausted');
  } finally {
    repo.cleanup();
    fs.rmSync(codeRoot, { recursive: true, force: true });
    fs.rmSync(path.dirname(stateDir), { recursive: true, force: true });
  }
});

test('read tool confinement refuses traversal, absolute paths, symlink escapes, and secrets', () => {
  const { codeRoot, repo } = setupRepo();
  let outside: string | undefined;
  try {
    const discovery = enumerateRepos([codeRoot]);
    outside = tmp('wsg-pi-outside-');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(repo.dir, 'escape.txt'));
    fs.symlinkSync(outside, path.join(repo.dir, 'escape-dir'));

    assert.throws(
      () => confinedRepoFile(discovery.repos, 'widget-repo', '../outside.txt'),
      /inside the repository/
    );
    assert.throws(
      () => confinedRepoFile(discovery.repos, 'widget-repo', '/etc/passwd'),
      /repository-relative/
    );
    assert.throws(
      () => confinedRepoFile(discovery.repos, 'widget-repo', 'node_modules/x.ts'),
      /vendor/
    );
    assert.throws(
      () => confinedRepoFile(discovery.repos, 'widget-repo', '.env'),
      /secret-like/
    );
    assert.throws(
      () => confinedRepoFile(discovery.repos, 'widget-repo', 'escape.txt'),
      /outside|symlink/
    );
    assert.throws(
      () => confinedRepoFile(discovery.repos, 'widget-repo', 'escape-dir/secret.txt'),
      /outside|symlink/
    );
    assert.throws(() => confinedRepoFile(discovery.repos, 'nope', 'README.md'), /Unknown repository/);

    const valid = confinedRepoFile(discovery.repos, 'widget-repo', 'README.md');
    assert.equal(valid.repo.source, fs.realpathSync(repo.dir));
  } finally {
    repo.cleanup();
    if (outside) fs.rmSync(outside, { recursive: true, force: true });
    fs.rmSync(codeRoot, { recursive: true, force: true });
  }
});

test('PiScout rejects an unsupported provider with actionable guidance', { skip }, async () => {
  const scout = new PiScout({ discovered: [], provider: 'not-a-provider' });
  const stateDir = tmp('wsg-pi-prov-');
  try {
    await assert.rejects(
      () => scout.scout({ request: 'x', stateDir }),
      (err: unknown) => err instanceof UsageError && /Unsupported scout provider/.test(err.message)
    );
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
