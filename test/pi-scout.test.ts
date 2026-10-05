import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestRepo } from './helpers/git-fixture.ts';
import { enumerateRepos } from '../src/discovery.ts';
import { PiScout, confinedRepoFile, SCOUT_DB_FILENAME, SCOUT_CHECKPOINT_FILENAME } from '../src/pi-scout.ts';
import { UsageError } from '../src/errors.ts';

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

test('read tool confinement refuses traversal, absolute paths, and symlink escapes', () => {
  const { codeRoot, repo } = setupRepo();
  try {
    const discovery = enumerateRepos([codeRoot]);
    const outside = path.join(os.tmpdir(), 'wsg-pi-outside.txt');
    fs.writeFileSync(outside, 'secret');
    const escape = path.join(repo.dir, 'escape.txt');
    fs.symlinkSync(outside, escape);

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
      /vendor path/
    );
    assert.throws(
      () => confinedRepoFile(discovery.repos, 'widget-repo', '.env'),
      /secret-like/
    );
    assert.throws(
      () => confinedRepoFile(discovery.repos, 'widget-repo', 'escape.txt'),
      /symlinks|outside/
    );
    assert.throws(() => confinedRepoFile(discovery.repos, 'nope', 'README.md'), /Unknown repository/);

    const valid = confinedRepoFile(discovery.repos, 'widget-repo', 'README.md');
    assert.equal(valid.repo.source, fs.realpathSync(repo.dir));

    fs.unlinkSync(escape);
    fs.unlinkSync(outside);
  } finally {
    repo.cleanup();
    fs.rmSync(codeRoot, { recursive: true, force: true });
  }
});

test('PiScout bounds the number of tool turns and still terminates with a result', { skip }, async () => {
  const { codeRoot, repo } = setupRepo();
  const stateDir = path.join(tmp('wsg-pi-turn-'), 'scout');
  try {
    const discovery = enumerateRepos([codeRoot]);
    const scout = new PiScout({
      discovered: discovery.repos,
      provider: 'faux',
      maxToolCalls: 1,
      fauxScript: [
        { tool: 'list_repos', args: {} },
        { tool: 'list_repos', args: {} },
        { tool: 'list_repos', args: {} },
        { tool: 'submit_selection', args: selectionPayload },
      ],
    });
    const result = await scout.scout({ request: 'bounded', codeRoots: [codeRoot], stateDir });
    assert.equal(result.kind, 'selection');
  } finally {
    repo.cleanup();
    fs.rmSync(codeRoot, { recursive: true, force: true });
    fs.rmSync(path.dirname(stateDir), { recursive: true, force: true });
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
