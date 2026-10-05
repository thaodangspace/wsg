#!/usr/bin/env node
// Manual live-model scout trial (billed, non-deterministic). This is NOT part
// of the default test suite. It runs the real Pi Durable scout against the
// EMR-like fixture over an actual provider and prints the selection, evidence,
// exclusions, gaps, and discovery limits so the result can be recorded with the
// model and runtime versions.
//
// Usage:
//   OPENAI_API_KEY=... WSG_TRIAL_MODEL=gpt-4o npm run trial:live
//
// Requires the pinned optional Pi packages (@earendil-works/pi-*) to be
// installed. Reads the provider API key only from the environment; it never
// writes a credential to disk, and it prints only whether a key is present.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runCreate } from '../src/create.ts';
import { parseManifest } from '../src/manifest.ts';
import { makeEmrFixture } from '../test/helpers/emr-fixture.ts';

function gitVersion(): string {
  const r = spawnSync('git', ['--version'], { encoding: 'utf8' });
  return (r.stdout ?? '').trim() || '(git unavailable)';
}

const model = process.env.WSG_TRIAL_MODEL ?? 'gpt-4o';
const provider = process.env.WSG_TRIAL_PROVIDER ?? 'openai';
const hasKey = Boolean(process.env.OPENAI_API_KEY);

console.log('=== WSG manual live-model trial ===');
console.log(`node:     ${process.version}`);
console.log(`git:      ${gitVersion()}`);
console.log(`provider: ${provider}`);
console.log(`model:    ${model}`);
console.log(`OPENAI_API_KEY present: ${hasKey}`);
console.log('');

if (provider === 'openai' && !hasKey) {
  console.error(
    'SKIP: OPENAI_API_KEY is not set; the billed live-model trial cannot run. ' +
      'Set it and re-run `npm run trial:live`. No live result was produced.'
  );
  process.exit(2);
}

const fixture = makeEmrFixture();
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-live-trial-config-'));
const configPath = path.join(configDir, 'config.yaml');
fs.writeFileSync(
  configPath,
  [
    'code_roots:',
    `  - ${JSON.stringify(fixture.codeRoot)}`,
    `workspace_root: ${JSON.stringify(fixture.workspaceRoot)}`,
    'scout:',
    `  provider: ${provider}`,
    `  model: ${model}`,
    '',
  ].join('\n'),
  'utf8'
);

const started = Date.now();
try {
  const code = await runCreate(
    {
      request: 'Port EMR from the monolith to the modular architecture of the new system',
      name: 'live-trial',
      root: fixture.workspaceRoot,
      codeRoots: [fixture.codeRoot],
    },
    { env: { ...process.env, WSG_CONFIG: configPath }, cwd: process.cwd() }
  );

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n=== Result (exit ${code}, ${elapsed}s) ===`);
  const wsDir = path.join(fixture.workspaceRoot, 'live-trial');
  if (code === 0 && fs.existsSync(path.join(wsDir, 'workspace.yaml'))) {
    const manifest = parseManifest(fs.readFileSync(path.join(wsDir, 'workspace.yaml'), 'utf8'));
    console.log(`selected repositories: ${manifest.repos.length}`);
    for (const repo of manifest.repos) {
      console.log(`  - ${repo.name} [${repo.intent}] evidence=${repo.evidence.length} branch=${repo.branch}`);
    }
    console.log(`excluded: ${manifest.discovery.excluded.length}`);
    for (const ex of manifest.discovery.excluded) {
      console.log(`  - ${ex.source}: ${ex.reason}`);
    }
    console.log(`gaps: ${manifest.discovery.gaps.length}`);
    for (const gap of manifest.discovery.gaps) console.log(`  - ${gap}`);
    console.log(`commands: ${manifest.commands.length}`);
  } else {
    console.error(`No completed workspace to report (exit ${code}).`);
  }
  process.exit(code === 0 ? 0 : 1);
} catch (err) {
  console.error(`\nLive trial failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
} finally {
  fixture.cleanup();
  fs.rmSync(configDir, { recursive: true, force: true });
}
