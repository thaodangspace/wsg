#!/usr/bin/env node
// Package smoke test: build the real npm tarball, inspect its contents, then
// INSTALL that tarball into a throwaway prefix and drive the installed `wsg`
// bin for all four commands. The installed copy has no access to this checkout,
// its source, or its devDependencies, so this catches a tarball missing
// compiled modules, leftover source, or an accidental reliance on the repo.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

let failures = 0;
function check(condition, message) {
  if (condition) {
    console.log(`  ok: ${message}`);
  } else {
    failures += 1;
    console.error(`  FAIL: ${message}`);
  }
}

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return result;
}

function mustRun(cmd, args, options = {}, label = `${cmd} ${args.join(' ')}`) {
  const result = run(cmd, args, options);
  if (result.status !== 0) {
    throw new Error(
      `${label} failed (exit ${result.status})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    );
  }
  return result;
}

function git(args, cwd) {
  return mustRun('git', args, { cwd }, `git ${args.join(' ')}`);
}

function initRepo(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '-b', 'main'], dir);
  git(['config', 'user.name', 'WSG Smoke'], dir);
  git(['config', 'user.email', 'smoke@example.com'], dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  git(['add', '.'], dir);
  git(['commit', '-m', 'Initial commit'], dir);
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-package-smoke-'));
try {
  console.log('== Build and pack the real tarball ==');
  const packDir = path.join(tmpRoot, 'pack');
  fs.mkdirSync(packDir, { recursive: true });
  const packed = mustRun('npm', ['pack', '--json', '--pack-destination', packDir], {
    cwd: repoRoot,
  });
  const packInfo = JSON.parse(packed.stdout);
  const tarball = path.join(packDir, packInfo[0].filename);
  check(fs.existsSync(tarball), `tarball created: ${path.basename(tarball)}`);

  console.log('== Tarball contents ==');
  const tarList = mustRun('tar', ['-tzf', tarball], {}, 'tar -tzf').stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const tarSet = new Set(tarList);

  check(tarSet.has('package/dist/cli.js'), 'tarball contains dist/cli.js');
  check(tarSet.has('package/package.json'), 'tarball contains package.json');
  check(tarSet.has('package/README.md'), 'tarball contains README.md');

  // Every compiled runtime module must be present, not just the bin entry.
  const expectedModules = fs
    .readdirSync(path.join(repoRoot, 'src'))
    .filter((f) => f.endsWith('.ts'))
    .map((f) => `package/dist/${f.replace(/\.ts$/, '.js')}`);
  const missingModules = expectedModules.filter((m) => !tarSet.has(m));
  check(
    missingModules.length === 0,
    `tarball contains all ${expectedModules.length} compiled runtime modules` +
      (missingModules.length ? ` (missing: ${missingModules.join(', ')})` : '')
  );

  const leakedSource = tarList.filter((p) => p.startsWith('package/src/'));
  check(leakedSource.length === 0, 'tarball ships no TypeScript source (no package/src/**)');
  const leakedNodeModules = tarList.filter((p) => p.startsWith('package/node_modules/'));
  check(leakedNodeModules.length === 0, 'tarball ships no node_modules');

  console.log('== INSTALL the tarball into a clean prefix ==');
  const prefix = path.join(tmpRoot, 'prefix');
  fs.mkdirSync(prefix, { recursive: true });
  mustRun(
    'npm',
    ['install', '--prefix', prefix, '--no-audit', '--no-fund', '--ignore-scripts', tarball],
    { cwd: tmpRoot },
    'npm install <tarball>'
  );

  const installedPkg = path.join(prefix, 'node_modules', 'wsg');
  check(fs.existsSync(path.join(installedPkg, 'dist', 'cli.js')), 'installed dist/cli.js exists');
  check(!fs.existsSync(path.join(installedPkg, 'src')), 'installed package has no src/');
  check(
    !fs.existsSync(path.join(prefix, 'node_modules', 'typescript')),
    'installed prefix has no devDependencies (typescript)'
  );

  const bin = path.join(prefix, 'node_modules', '.bin', 'wsg');
  check(fs.existsSync(bin), 'installed .bin/wsg exists');

  const env = {
    WSG_CONFIG: path.join(tmpRoot, 'no-such-config.yaml'),
    // Deliberately do NOT inherit repo node_modules resolution via cwd.
    PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ''}`,
  };

  console.log('== Drive the installed bin: all four commands ==');
  const version = mustRun(bin, ['--version'], { cwd: tmpRoot, env }, 'installed wsg --version');
  check(version.stdout.trim() === pkg.version, `--version prints ${pkg.version}`);

  const help = mustRun(bin, ['--help'], { cwd: tmpRoot, env }, 'installed wsg --help');
  for (const cmd of ['create', 'explain', 'add', 'refresh']) {
    check(help.stdout.includes(cmd), `--help lists '${cmd}'`);
  }

  const repoA = path.join(tmpRoot, 'repo-a');
  const repoB = path.join(tmpRoot, 'repo-b');
  initRepo(repoA, {
    'README.md': '# Repo A\n',
    'package.json': JSON.stringify({ name: 'repo-a', scripts: { test: 'true' } }),
  });
  initRepo(repoB, { 'README.md': '# Repo B\n' });
  const docPath = path.join(tmpRoot, 'migration guide.md');
  fs.writeFileSync(docPath, '# Migration\nport to modular\n', 'utf8');

  const wsRoot = path.join(tmpRoot, 'wsg');
  const create = mustRun(
    bin,
    [
      'create',
      'port EMR mono to modular',
      '--name',
      'smoke',
      '--root',
      wsRoot,
      '--repo',
      repoA,
      '--doc',
      docPath,
      '--for',
      'agents,claude',
    ],
    { cwd: tmpRoot, env },
    'installed wsg create'
  );
  check(create.status === 0, 'create exits 0');

  const wsDir = path.join(wsRoot, 'smoke');
  check(fs.existsSync(path.join(wsDir, 'workspace.yaml')), 'create wrote workspace.yaml');
  check(fs.existsSync(path.join(wsDir, 'docs', 'context.md')), 'create wrote docs/context.md');
  check(fs.existsSync(path.join(wsDir, 'AGENTS.md')), 'create wrote AGENTS.md');
  check(fs.existsSync(path.join(wsDir, 'CLAUDE.md')), 'create wrote CLAUDE.md');

  const explain = mustRun(
    bin,
    ['explain', '--workspace', wsDir],
    { cwd: tmpRoot, env },
    'installed wsg explain'
  );
  check(explain.stdout.includes('Workspace: smoke'), 'explain reports the workspace');

  const add = mustRun(
    bin,
    ['add', repoB, '--workspace', wsDir],
    { cwd: tmpRoot, env },
    'installed wsg add'
  );
  check(add.status === 0, 'add exits 0');

  const refresh = mustRun(
    bin,
    ['refresh', '--workspace', wsDir],
    { cwd: tmpRoot, env },
    'installed wsg refresh'
  );
  check(refresh.status === 0, 'refresh exits 0');
  check(fs.existsSync(path.join(wsDir, 'workspace.yaml')), 'workspace.yaml survives add+refresh');
} catch (err) {
  failures += 1;
  console.error(`\npackage smoke error: ${err instanceof Error ? err.stack ?? err.message : err}`);
} finally {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

if (failures > 0) {
  console.error(`\npackage smoke FAILED (${failures} check(s))`);
  process.exit(1);
}
console.log('\npackage smoke PASSED');
