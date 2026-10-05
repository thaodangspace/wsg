import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runMain } from './helpers/cli.ts';
import { createTestRepo } from './helpers/git-fixture.ts';
import { parseManifest } from '../src/manifest.ts';
import { sha256 } from '../src/fsx.ts';
import { readOperation } from '../src/operation.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI_PATH = path.join(REPO_ROOT, 'src', 'cli.ts');
const NO_CONFIG = path.join(os.tmpdir(), `wsg-m5-noconfig-${process.pid}.yaml`);

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

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

function readManifest(wsDir: string) {
  return parseManifest(fs.readFileSync(path.join(wsDir, 'workspace.yaml'), 'utf8'));
}

function initRecordingShims(dir: string, logPath: string): void {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ['npm', 'node', 'sh']) {
    const shimPath = path.join(dir, name);
    fs.writeFileSync(
      shimPath,
      `#!/bin/sh\nprintf '%s %s\\n' "${name}" "$*" >> "${logPath}"\nexit 0\n`,
      { mode: 0o755 }
    );
    fs.chmodSync(shimPath, 0o755);
  }
}

test('M5: create discovers an npm test command and the wrapper runs from any cwd with its exit code', () => {
  const repo = createTestRepo({
    prefix: 'wsg-m5-test-',
    files: {
      'package.json': JSON.stringify({
        name: 'demo',
        scripts: { test: 'node -e "process.exit(7)"', build: 'node -e "process.exit(0)"' },
      }),
    },
  });

  // Move the repository under a path with a space and non-ASCII bytes.
  const spacedParent = mkTmp('wsg m5 空间 parent-');
  const spacedSource = path.join(spacedParent, 'repo with space');
  fs.renameSync(repo.dir, spacedSource);

  const root = mkTmp('wsg-m5-root-');
  const wsDir = path.join(root, 'demo');
  const shimDir = mkTmp('wsg-m5-shim-bin-');
  const shimLog = path.join(mkTmp('wsg-m5-shim-log-'), 'calls.log');

  try {
    initRecordingShims(shimDir, shimLog);

    // Creation must discover commands from the recorded revision without ever
    // executing npm/node/sh.
    const created = runCli(
      ['create', 'demo task', '--name', 'demo', '--root', root, '--repo', spacedSource, '--for', 'agents,claude'],
      { env: { PATH: `${shimDir}:${process.env.PATH ?? ''}` } }
    );
    assert.equal(created.status, 0, created.stderr);
    assert.ok(!fs.existsSync(shimLog), `create must not execute project commands; shim log: ${fs.existsSync(shimLog) ? fs.readFileSync(shimLog, 'utf8') : ''}`);

    const manifest = readManifest(wsDir);
    assert.equal(manifest.commands.length, 2);
    const testCmd = manifest.commands.find((c) => c.name === 'test-repo-with-space');
    assert.ok(testCmd, `commands: ${manifest.commands.map((c) => c.name).join(', ')}`);
    assert.equal(testCmd.cwd, 'repo-with-space');
    assert.deepEqual(testCmd.argv, ['npm', 'run', 'test']);
    assert.equal(testCmd.evidence, 'package.json scripts.test');
    assert.equal(testCmd.wrapper, 'scripts/test-repo-with-space.sh');

    const wrapperPath = path.join(wsDir, testCmd.wrapper!);
    assert.ok(fs.existsSync(wrapperPath), 'wrapper must exist');
    assert.ok(
      (fs.statSync(wrapperPath).mode & 0o111) !== 0,
      'wrapper must be executable'
    );

    // The wrapper resolves the spaced workspace from its own location and
    // propagates the script exit status from an unrelated cwd.
    const ran = spawnSync('sh', [wrapperPath], {
      cwd: '/',
      env: process.env,
      encoding: 'utf8',
    });
    assert.equal(ran.status, 7, `expected propagated exit 7, got ${ran.status}: ${ran.stderr}`);

    // Context exposes the discovered command with its provenance and wrapper.
    const context = fs.readFileSync(path.join(wsDir, 'docs', 'context.md'), 'utf8');
    assert.match(context, /## Commands \(discovered, not verified\)/);
    assert.match(context, /test-repo-with-space/);
    assert.match(context, /npm run test/);
    assert.match(context, /package\.json scripts\.test/);
    assert.match(context, /scripts\/test-repo-with-space\.sh/);
  } finally {
    repo.cleanup();
    fs.rmSync(spacedParent, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(shimDir, { recursive: true, force: true });
    fs.rmSync(path.dirname(shimLog), { recursive: true, force: true });
  }
});

test('M5: a repository without a test reports the gap and gets no invented verification wrapper', () => {
  const repo = createTestRepo({
    prefix: 'wsg-m5-notest-',
    files: {
      'package.json': JSON.stringify({ name: 'legacy', scripts: { build: 'node -e "process.exit(0)"' } }),
    },
  });
  const root = mkTmp('wsg-m5-notest-root-');
  const wsDir = path.join(root, 'no-test');

  try {
    const created = runCli(['create', 'migration task', '--name', 'no-test', '--root', root, '--repo', repo.dir]);
    assert.equal(created.status, 0, created.stderr);

    const manifest = readManifest(wsDir);
    assert.ok(
      !manifest.commands.some(
        (c) => c.name.startsWith('test-') || /migration/i.test(c.name) || c.argv.join(' ') === 'npm run test'
      ),
      `no invented verification command expected, got ${JSON.stringify(manifest.commands)}`
    );
    assert.ok(
      manifest.discovery.gaps.some((g) => /No test command discovered/.test(g)),
      `missing-test gap expected, got ${JSON.stringify(manifest.discovery.gaps)}`
    );

    const scriptsDir = path.join(wsDir, 'scripts');
    const wrapperNames = fs.existsSync(scriptsDir) ? fs.readdirSync(scriptsDir) : [];
    assert.ok(
      !wrapperNames.some((name) => /^(test-|.*migration)/i.test(name)),
      `no invented verification wrapper expected, got ${wrapperNames.join(', ')}`
    );

    const context = fs.readFileSync(path.join(wsDir, 'docs', 'context.md'), 'utf8');
    assert.match(context, /No test command discovered/);
  } finally {
    repo.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('M5: create, add, and refresh never execute tests, documented scripts, or installs', async () => {
  const repoA = createTestRepo({
    prefix: 'wsg-m5-record-a-',
    files: {
      'package.json': JSON.stringify({
        name: 'a',
        scripts: { test: 'sh evil.sh', verify: 'sh verify-evil.sh', postinstall: 'node install.js' },
      }),
      'evil.sh': '#!/bin/sh\ntouch EXECUTED_TEST\n',
      'verify-evil.sh': '#!/bin/sh\ntouch EXECUTED_VERIFY\n',
      'scripts/check.sh': '#!/bin/sh\ntouch EXECUTED_CHECK\n',
      'README.md':
        '# A\n\n## Validation\n\n```sh\nnpm run verify\nsh scripts/check.sh\n```\n',
    },
  });
  const repoB = createTestRepo({
    prefix: 'wsg-m5-record-b-',
    files: { 'package.json': JSON.stringify({ name: 'b', scripts: { test: 'sh evil.sh' } }) },
  });

  const root = mkTmp('wsg-m5-record-root-');
  const wsDir = path.join(root, 'record');
  const shimDir = mkTmp('wsg-m5-record-shim-');
  const shimLog = path.join(mkTmp('wsg-m5-record-log-'), 'calls.log');

  try {
    initRecordingShims(shimDir, shimLog);
    const recordEnv = { PATH: `${shimDir}:${process.env.PATH ?? ''}` };

    const created = runCli(
      ['create', 'record task', '--name', 'record', '--root', root, '--repo', repoA.dir],
      { env: recordEnv }
    );
    assert.equal(created.status, 0, created.stderr);

    const added = runCli(['add', repoB.dir, '--workspace', wsDir], { env: recordEnv });
    assert.equal(added.status, 0, added.stderr);

    const refreshed = runCli(['refresh', '--workspace', wsDir], { env: recordEnv });
    // Refresh may exit 0 or 3 depending on reconciliation, but must not execute.
    assert.ok(refreshed.status === 0 || refreshed.status === 3, refreshed.stderr);

    const recorded = fs.existsSync(shimLog) ? fs.readFileSync(shimLog, 'utf8') : '';
    assert.equal(recorded, '', `no project command may run:\n${recorded}`);
    for (const marker of ['EXECUTED_TEST', 'EXECUTED_VERIFY', 'EXECUTED_CHECK', 'EXECUTED_INSTALL']) {
      assert.ok(!fs.existsSync(path.join(repoA.dir, marker)), `${marker} must not exist`);
    }

    const manifest = readManifest(wsDir);
    assert.ok(manifest.commands.length >= 2, 'both repositories contribute commands');
    assert.ok(
      manifest.commands.some((c) => (c.evidence ?? '').startsWith('README.md: documented')),
      `documented command expected, got ${JSON.stringify(manifest.commands)}`
    );
  } finally {
    repoA.cleanup();
    repoB.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(shimDir, { recursive: true, force: true });
    fs.rmSync(path.dirname(shimLog), { recursive: true, force: true });
  }
});

test('M5: commands come from the recorded commit, not dirty source package.json changes', () => {
  const repo = createTestRepo({
    prefix: 'wsg-m5-dirty-',
    files: {
      'package.json': JSON.stringify({ name: 'r', scripts: { build: 'node -e "process.exit(0)"' } }),
    },
  });
  const root = mkTmp('wsg-m5-dirty-root-');

  try {
    // Uncommitted source-only test script must not become a wrapper: the
    // worktree is created at the recorded commit, which has no test script.
    fs.writeFileSync(
      path.join(repo.dir, 'package.json'),
      JSON.stringify({ name: 'r', scripts: { build: 'node -e "process.exit(0)"', test: 'node -e "process.exit(1)"' } }),
      'utf8'
    );

    const created = runCli(['create', 'dirty task', '--name', 'dirty', '--root', root, '--repo', repo.dir]);
    assert.equal(created.status, 0, created.stderr);

    const manifest = readManifest(path.join(root, 'dirty'));
    assert.ok(
      !manifest.commands.some((c) => c.name.includes('test')),
      `uncommitted test script must not be discovered: ${JSON.stringify(manifest.commands)}`
    );
    assert.ok(manifest.discovery.gaps.some((g) => /No test command discovered/.test(g)));
  } finally {
    repo.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('M5: both selected adapters expose the same context after add and refresh', async () => {
  const repoA = createTestRepo({
    prefix: 'wsg-m5-adapter-a-',
    files: { 'package.json': JSON.stringify({ name: 'a', scripts: { test: 'node -e "process.exit(0)"' } }) },
  });
  const repoB = createTestRepo({
    prefix: 'wsg-m5-adapter-b-',
    files: { 'package.json': JSON.stringify({ name: 'b', scripts: { test: 'node -e "process.exit(0)"' } }) },
  });
  const root = mkTmp('wsg-m5-adapter-root-');
  const wsDir = path.join(root, 'adapters');

  const readAdapter = (name: string) => fs.readFileSync(path.join(wsDir, name), 'utf8');
  const bodyWithoutTitle = (text: string) => text.replace(/^# .*\n/, '');

  try {
    const created = await runCliInProcess(
      ['create', 'adapter task', '--name', 'adapters', '--root', root, '--repo', repoA.dir, '--for', 'agents,claude']
    );
    assert.equal(created.exitCode, 0, created.stderr);

    const agents0 = readAdapter('AGENTS.md');
    const claude0 = readAdapter('CLAUDE.md');
    assert.match(agents0, /docs\/context\.md/);
    assert.match(claude0, /docs\/context\.md/);
    assert.equal(
      bodyWithoutTitle(agents0),
      bodyWithoutTitle(claude0),
      'both adapters must carry the same pointer body'
    );

    // Add a second repository: both adapters and the canonical context update.
    const added = await runCliInProcess(['add', repoB.dir, '--workspace', wsDir]);
    assert.equal(added.exitCode, 0, added.stderr);

    const agents1 = readAdapter('AGENTS.md');
    const claude1 = readAdapter('CLAUDE.md');
    assert.match(agents1, /docs\/context\.md/);
    assert.match(claude1, /docs\/context\.md/);
    assert.equal(bodyWithoutTitle(agents1), bodyWithoutTitle(claude1));

    const contextAfterAdd = fs.readFileSync(path.join(wsDir, 'docs', 'context.md'), 'utf8');
    for (const repo of [repoA, repoB]) {
      const entry = path.basename(repo.dir);
      assert.match(contextAfterAdd, new RegExp(entry), 'context must include the added repo');
    }
    assert.match(agents1, /Repository-local instructions and workflows also apply/);
    assert.match(claude1, /Repository-local instructions and workflows also apply/);

    // Refresh keeps both adapters pointing at the same regenerated context.
    const refreshed = await runCliInProcess(['refresh', '--workspace', wsDir]);
    assert.ok(refreshed.exitCode === 0 || refreshed.exitCode === 3, refreshed.stderr);
    const agents2 = readAdapter('AGENTS.md');
    const claude2 = readAdapter('CLAUDE.md');
    assert.equal(bodyWithoutTitle(agents2), bodyWithoutTitle(claude2));
    assert.match(agents2, /docs\/context\.md/);
    assert.match(claude2, /docs\/context\.md/);
  } finally {
    repoA.cleanup();
    repoB.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('M5: wrapper names avoid untracked user scripts instead of clobbering them', async () => {
  const parent = mkTmp('wsg-m5-collide-parent-');
  const target = path.join(parent, 'newrepo');
  const repo = createTestRepo({
    prefix: 'wsg-m5-collide-',
    files: { 'package.json': JSON.stringify({ name: 'newrepo', scripts: { test: 'node -e "process.exit(0)"' } }) },
  });
  fs.renameSync(repo.dir, target);

  const base = createTestRepo({ prefix: 'wsg-m5-collide-base-' });
  const root = mkTmp('wsg-m5-collide-root-');
  const wsDir = path.join(root, 'collide');
  const sentinelRel = 'scripts/test-newrepo.sh';
  const sentinelContent = '#!/bin/sh\necho "user script"\n';

  try {
    const created = await runCliInProcess(
      ['create', 'collide task', '--name', 'collide', '--root', root, '--repo', base.dir]
    );
    assert.equal(created.exitCode, 0, created.stderr);

    fs.mkdirSync(path.join(wsDir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(wsDir, sentinelRel), sentinelContent, 'utf8');

    const added = await runCliInProcess(['add', target, '--workspace', wsDir]);
    assert.equal(added.exitCode, 0, added.stderr);

    // The user's untracked script is untouched.
    assert.equal(fs.readFileSync(path.join(wsDir, sentinelRel), 'utf8'), sentinelContent);

    const manifest = readManifest(wsDir);
    const cmd = manifest.commands.find((c) => c.cwd === 'newrepo');
    assert.ok(cmd, `expected a command for newrepo, got ${JSON.stringify(manifest.commands)}`);
    assert.match(cmd!.wrapper!, /^scripts\/test-newrepo-[0-9a-f]{6}\.sh$/);
    assert.ok(fs.existsSync(path.join(wsDir, cmd!.wrapper!)), 'suffixed wrapper must exist');
  } finally {
    repo.cleanup();
    base.cleanup();
    fs.rmSync(parent, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('M5: a documented validation script gets a wrapper that runs from any cwd and propagates exit', () => {
  const repo = createTestRepo({
    prefix: 'wsg-m5-doc-script-',
    files: {
      'scripts/check.sh': '#!/bin/sh\nexit 6\n',
      'README.md': '# Repo\n\n## Validation\n\n```sh\nsh scripts/check.sh\n```\n',
    },
  });
  const root = mkTmp('wsg-m5-doc-script-root-');
  const wsDir = path.join(root, 'doc-script');

  try {
    const created = runCli(
      ['create', 'doc task', '--name', 'doc-script', '--root', root, '--repo', repo.dir]
    );
    assert.equal(created.status, 0, created.stderr);

    const manifest = readManifest(wsDir);
    const cmd = manifest.commands.find(
      (c) => (c.evidence ?? '').startsWith('README.md: documented') && c.argv[0] === 'sh'
    );
    assert.ok(cmd, `documented script command expected, got ${JSON.stringify(manifest.commands)}`);
    assert.deepEqual(cmd.argv, ['sh', 'scripts/check.sh']);
    assert.equal(cmd.cwd, path.basename(repo.dir));
    assert.match(cmd.wrapper!, /^scripts\/check-[^/]+\.sh$/);

    const wrapperPath = path.join(wsDir, cmd.wrapper!);
    assert.ok(fs.existsSync(wrapperPath), 'documented script wrapper must exist');
    const ran = spawnSync('sh', [wrapperPath], { cwd: '/', env: process.env, encoding: 'utf8' });
    assert.equal(ran.status, 6, `expected propagated exit 6: ${ran.stderr}`);

    // The repository still has no test command, so the gap is reported.
    assert.ok(manifest.discovery.gaps.some((g) => /No test command discovered/.test(g)));
  } finally {
    repo.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('M5: a documented validation path that does not exist reports a gap and no wrapper', () => {
  const repo = createTestRepo({
    prefix: 'wsg-m5-doc-missing-',
    files: {
      'README.md': '# Repo\n\n## Validation\n\n```sh\nsh scripts/missing.sh\n```\n',
    },
  });
  const root = mkTmp('wsg-m5-doc-missing-root-');
  const wsDir = path.join(root, 'doc-missing');

  try {
    const created = runCli(
      ['create', 'missing task', '--name', 'doc-missing', '--root', root, '--repo', repo.dir]
    );
    assert.equal(created.status, 0, created.stderr);

    const manifest = readManifest(wsDir);
    assert.ok(
      !manifest.commands.some((c) => c.argv.join(' ').includes('missing')),
      `no wrapper for a missing documented path: ${JSON.stringify(manifest.commands)}`
    );
    assert.ok(
      manifest.discovery.gaps.some((g) => /does not exist at the recorded commit/.test(g)),
      `missing documented path gap expected, got ${JSON.stringify(manifest.discovery.gaps)}`
    );
    const scriptsDir = path.join(wsDir, 'scripts');
    const wrappers = fs.existsSync(scriptsDir) ? fs.readdirSync(scriptsDir) : [];
    assert.ok(!wrappers.some((name) => name.includes('missing')), wrappers.join(', '));
  } finally {
    repo.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('M5: an empty npm test value reports the gap and gets no wrapper', () => {
  const repo = createTestRepo({
    prefix: 'wsg-m5-empty-test-',
    files: {
      'package.json': JSON.stringify({
        name: 'empty-test',
        scripts: { test: '   ', build: 'node -e "process.exit(0)"' },
      }),
    },
  });
  const root = mkTmp('wsg-m5-empty-test-root-');
  const wsDir = path.join(root, 'empty-test');

  try {
    const created = runCli(
      ['create', 'empty task', '--name', 'empty-test', '--root', root, '--repo', repo.dir]
    );
    assert.equal(created.status, 0, created.stderr);

    const manifest = readManifest(wsDir);
    assert.ok(
      !manifest.commands.some((c) => c.argv.join(' ') === 'npm run test'),
      `no test wrapper for an empty script: ${JSON.stringify(manifest.commands)}`
    );
    assert.ok(
      manifest.discovery.gaps.some((g) => /No test command discovered/.test(g)),
      `missing-test gap expected, got ${JSON.stringify(manifest.discovery.gaps)}`
    );
    const scriptsDir = path.join(wsDir, 'scripts');
    const wrappers = fs.existsSync(scriptsDir) ? fs.readdirSync(scriptsDir) : [];
    assert.ok(
      !wrappers.some((name) => /^test[-.]/.test(name)),
      `no test wrapper expected, got ${wrappers.join(', ')}`
    );
  } finally {
    repo.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('M5: resume preserves a user-edited wrapper and writes a .wsg-new proposal', () => {
  const repo = createTestRepo({
    prefix: 'wsg-m5-resume-',
    files: { 'package.json': JSON.stringify({ name: 'r', scripts: { test: 'node -e "process.exit(0)"' } }) },
  });
  const root = mkTmp('wsg-m5-resume-root-');
  const wsDir = path.join(root, 'resume-ws');
  const args = ['create', 'resume task', '--name', 'resume-ws', '--root', root, '--repo', repo.dir];

  try {
    const crashed = runCli(args, { env: { WSG_FAULT: 'after-generate:1' } });
    assert.equal(crashed.status, 70, `expected fault exit 70: ${crashed.stderr}`);

    const crashedJournal = readOperation(wsDir);
    const recordedCommands = ((crashedJournal?.operation?.plan as Record<string, unknown> | undefined)
      ?.commands as unknown[]) ?? [];
    assert.ok(recordedCommands.length > 0, 'commands must be recorded in the plan');

    const scriptsDir = path.join(wsDir, 'scripts');
    const wrapperName = fs.readdirSync(scriptsDir).find((name) => name.endsWith('.sh'));
    assert.ok(wrapperName, 'a wrapper must exist after the interrupted generate');
    const wrapperPath = path.join(scriptsDir, wrapperName!);
    const generated = fs.readFileSync(wrapperPath, 'utf8');

    const edited = `${generated}# USER EDIT\n`;
    fs.writeFileSync(wrapperPath, edited, 'utf8');

    const resumed = runCli([...args, '--resume']);
    assert.equal(resumed.status, 3, `expected partial exit 3: ${resumed.stderr}`);

    assert.equal(fs.readFileSync(wrapperPath, 'utf8'), edited, 'user edit must be preserved');
    const proposalPath = `${wrapperPath}.wsg-new`;
    assert.ok(fs.existsSync(proposalPath), 'a .wsg-new proposal must be written');
    assert.match(fs.readFileSync(proposalPath, 'utf8'), /Generated by WSG/);
    assert.ok(fs.existsSync(path.join(wsDir, 'workspace.yaml')), 'manifest must be published last');

    // The resumed manifest replays the exact recorded command set (deterministic).
    const manifest = readManifest(wsDir);
    assert.deepEqual(
      manifest.commands.map((c) => ({
        name: c.name,
        cwd: c.cwd,
        argv: c.argv,
        evidence: c.evidence,
        wrapper: c.wrapper,
      })),
      recordedCommands
    );
  } finally {
    repo.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('M5: explicitly attached scripts keep provenance and are never executed', async () => {
  const base = createTestRepo({ prefix: 'wsg-m5-script-base-' });
  const root = mkTmp('wsg-m5-script-root-');
  const wsDir = path.join(root, 'scripts-ws');
  const srcDir = mkTmp('wsg-m5-script-src-');
  const marker = path.join(srcDir, 'EXECUTED');
  const scriptPath = path.join(srcDir, 'reproduce.sh');
  const scriptBody = `#!/bin/sh\ntouch "${marker}"\n`;
  fs.writeFileSync(scriptPath, scriptBody, 'utf8');

  try {
    await runCliInProcess(['create', 'script task', '--name', 'scripts-ws', '--root', root, '--repo', base.dir]);
    const added = await runCliInProcess(['add', scriptPath, '--as', 'script', '--workspace', wsDir]);
    assert.equal(added.exitCode, 0, added.stderr);

    const manifest = readManifest(wsDir);
    assert.equal(manifest.scripts.length, 1);
    const entry = manifest.scripts[0];
    assert.equal(entry.source, fs.realpathSync(scriptPath));
    assert.equal(entry.sha256, sha256(Buffer.from(scriptBody)));
    assert.equal(entry.added_by, 'user');
    const copiedPath = path.join(wsDir, entry.path);
    assert.equal(fs.readFileSync(copiedPath, 'utf8'), scriptBody);
    assert.ok(!fs.existsSync(marker), 'attached script must never execute');

    // Re-adding is a no-op and refresh preserves the copied bytes and provenance.
    const again = await runCliInProcess(['add', scriptPath, '--as', 'script', '--workspace', wsDir]);
    assert.equal(again.exitCode, 0, again.stderr);
    assert.match(again.stdout, /Nothing to add/);

    const refreshed = await runCliInProcess(['refresh', '--workspace', wsDir]);
    assert.ok(refreshed.exitCode === 0 || refreshed.exitCode === 3, refreshed.stderr);
    const after = readManifest(wsDir);
    assert.equal(after.scripts.length, 1);
    assert.equal(fs.readFileSync(path.join(wsDir, after.scripts[0].path), 'utf8'), scriptBody);
    assert.ok(!fs.existsSync(marker));
  } finally {
    base.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(srcDir, { recursive: true, force: true });
  }
});
