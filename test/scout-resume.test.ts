import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeEmrFixture } from './helpers/emr-fixture.ts';
import { enumerateRepos } from '../src/discovery.ts';
import { PiScout, SCOUT_DB_FILENAME, SCOUT_TOOL_NAMES, SCOUT_OBSERVED_FILENAME } from '../src/pi-scout.ts';
import { runCreate } from '../src/create.ts';
import { parseManifest } from '../src/manifest.ts';
import { ConflictError } from '../src/errors.ts';
import { createTestRepo } from './helpers/git-fixture.ts';

let piAvailable = true;
try {
  const spec: string = '@earendil-works/pi-durable';
  await import(spec);
} catch {
  piAvailable = false;
}
const skip = piAvailable ? false : 'Pi Durable packages are not installed';

const NO_CONFIG = path.join(os.tmpdir(), `wsg-m3-resume-noconfig-${process.pid}.yaml`);
const io = { env: { ...process.env, WSG_CONFIG: NO_CONFIG }, cwd: process.cwd() };

function scriptFor(fixture: ReturnType<typeof makeEmrFixture>) {
  return [
    { tool: 'list_repos', args: {} },
    { tool: 'read_file', args: { repo: fixture.names.legacy, path: 'src/emr/MedicalRecord.ts' } },
    {
      tool: 'submit_selection',
      args: {
        repos: [
          {
            source: fixture.names.legacy,
            intent: 'source',
            reason: 'legacy EMR',
            evidence: [
              {
                file: 'src/emr/MedicalRecord.ts',
                lines: [1, 3],
                summary: 'MedicalRecord',
                quote: 'export class MedicalRecord',
              },
            ],
          },
          {
            source: fixture.names.modular,
            intent: 'target',
            reason: 'modular target',
            evidence: [
              {
                file: 'src/patient/Patient.ts',
                lines: [2, 4],
                summary: 'Patient module',
                quote: 'export interface Patient',
              },
            ],
          },
        ],
        exclusions: [{ source: fixture.names.unrelated, reason: 'unrelated billing repo' }],
        gaps: [],
        context: [],
      },
    },
  ];
}

test('interrupted autonomous scouting resumes and completes the workspace', { skip }, async () => {
  const fixture = makeEmrFixture();
  const stateDir = path.join(fixture.workspaceRoot, '.wsg-scout', 'resumed-emr');
  const wsDir = path.join(fixture.workspaceRoot, 'resumed-emr');
  try {
    const discovery = enumerateRepos([fixture.codeRoot]);
    const crashing = new PiScout({
      discovered: discovery.repos,
      provider: 'faux',
      fauxScript: scriptFor(fixture),
      haltAfterTool: 'read_file',
    });

    await assert.rejects(
      () =>
        runCreate(
          {
            request: 'Port EMR from monolith to modular',
            name: 'resumed-emr',
            root: fixture.workspaceRoot,
            codeRoots: [fixture.codeRoot],
            scout: crashing,
          },
          io
        ),
      'the interrupted scout must fail before materialization'
    );

    // The model's read-only turn committed a real SQLite checkpoint, and no
    // materialization happened inside the scout step.
    assert.ok(fs.existsSync(path.join(stateDir, SCOUT_DB_FILENAME)), 'checkpoint must exist');
    assert.equal(fs.existsSync(wsDir), false, 'no workspace is materialized by the model step');

    const resumed = new PiScout({
      discovered: discovery.repos,
      provider: 'faux',
      fauxScript: scriptFor(fixture),
    });
    const code = await runCreate(
      {
        request: 'Port EMR from monolith to modular',
        name: 'resumed-emr',
        root: fixture.workspaceRoot,
        codeRoots: [fixture.codeRoot],
        scout: resumed,
        resume: true,
      },
      io
    );
    assert.equal(code, 0);

    const manifest = parseManifest(fs.readFileSync(path.join(wsDir, 'workspace.yaml'), 'utf8'));
    assert.equal(manifest.repos.length, 2);
    assert.equal(manifest.repos.filter((r) => r.intent === 'source').length, 1);
    assert.equal(manifest.repos.filter((r) => r.intent === 'target').length, 1);
    assert.ok(manifest.repos.every((r) => r.evidence.length >= 1));

    // The durable scout checkpoint is preserved in workspace runtime storage.
    assert.ok(fs.existsSync(path.join(wsDir, '.wsg', 'runtime.sqlite')));
  } finally {
    fixture.cleanup();
  }
});

test('the scout toolset is read-only and never exposes write or shell tools', () => {
  assert.deepEqual(SCOUT_TOOL_NAMES, ['list_repos', 'read_file', 'rg_search', 'submit_selection']);
  for (const name of SCOUT_TOOL_NAMES) {
    assert.doesNotMatch(name, /write|edit|shell|exec|run|install|delete|remove|git/i);
  }
});

test('read observations persist across a crash and are used when resuming through create', { skip }, async () => {
  const codeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-obs-crash-'));
  const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-obs-out-'));
  const repo = createTestRepo({
    prefix: 'wsg-obs-repo-',
    files: { 'src/only.ts': 'export const onlyMarker = 42;\n' },
  });
  fs.symlinkSync(repo.dir, path.join(codeRoot, 'only-repo'));
  const wsDir = path.join(outRoot, 'obs-ws');
  const stateDir = path.join(outRoot, '.wsg-scout', 'obs-ws');
  const submit = {
    tool: 'submit_selection',
    args: {
      repos: [
        {
          source: 'only-repo',
          intent: 'target',
          reason: 'only candidate',
          evidence: [
            {
              file: 'src/only.ts',
              lines: [1, 1],
              summary: 'onlyMarker',
              quote: 'export const onlyMarker',
            },
          ],
        },
      ],
      exclusions: [],
      gaps: [],
      context: [],
    },
  };
  const script = [
    { tool: 'read_file', args: { repo: 'only-repo', path: 'src/only.ts' } },
    submit,
  ];
  try {
    const discovery = enumerateRepos([codeRoot]);
    const crashing = new PiScout({
      discovered: discovery.repos,
      provider: 'faux',
      fauxScript: script,
      haltAfterTool: 'read_file',
    });
    await assert.rejects(
      () =>
        runCreate(
          {
            request: 'port unknown service',
            name: 'obs-ws',
            root: outRoot,
            codeRoots: [codeRoot],
            scout: crashing,
          },
          io
        ),
      'the interrupted scout must reject before materialization'
    );
    assert.ok(
      fs.existsSync(path.join(stateDir, SCOUT_OBSERVED_FILENAME)),
      'observed lines must be persisted before the crash'
    );
    assert.equal(fs.existsSync(wsDir), false);

    const resumed = new PiScout({
      discovered: discovery.repos,
      provider: 'faux',
      fauxScript: script,
    });
    const code = await runCreate(
      {
        request: 'port unknown service',
        name: 'obs-ws',
        root: outRoot,
        codeRoots: [codeRoot],
        scout: resumed,
        resume: true,
      },
      io
    );
    assert.equal(code, 0);
    const manifest = parseManifest(fs.readFileSync(path.join(wsDir, 'workspace.yaml'), 'utf8'));
    assert.equal(manifest.repos.length, 1);
    assert.equal(manifest.repos[0].evidence.length, 1);
    assert.equal(manifest.repos[0].evidence[0].file, 'src/only.ts');
  } finally {
    repo.cleanup();
    fs.rmSync(codeRoot, { recursive: true, force: true });
    fs.rmSync(outRoot, { recursive: true, force: true });
  }
});

test('resuming scouting with a changed task conflicts instead of replaying the old selection', { skip }, async () => {
  const fixture = makeEmrFixture();
  const stateDir = path.join(fixture.workspaceRoot, '.wsg-scout', 'identity');
  try {
    const discovery = enumerateRepos([fixture.codeRoot]);
    const first = new PiScout({
      discovered: discovery.repos,
      provider: 'faux',
      fauxScript: [
        { tool: 'read_file', args: { repo: fixture.names.legacy, path: 'src/emr/MedicalRecord.ts' } },
        {
          tool: 'submit_selection',
          args: {
            repos: [
              {
                source: fixture.names.legacy,
                intent: 'source',
                reason: 'legacy',
                evidence: [
                  {
                    file: 'src/emr/MedicalRecord.ts',
                    lines: [1, 3],
                    summary: 'MedicalRecord',
                    quote: 'export class MedicalRecord',
                  },
                ],
              },
            ],
            exclusions: [],
            gaps: [],
            context: [],
          },
        },
      ],
    });
    await first.scout({
      request: 'Port EMR from monolith to modular',
      codeRoots: [fixture.codeRoot],
      stateDir,
    });
    assert.ok(fs.existsSync(path.join(stateDir, 'selection.json')));

    const changed = new PiScout({
      discovered: discovery.repos,
      provider: 'faux',
      fauxScript: [{ tool: 'submit_selection', args: { repos: [], exclusions: [], gaps: [], context: [] } }],
    });
    await assert.rejects(
      () =>
        runCreate(
          {
            request: 'A completely different migration task',
            name: 'identity',
            root: fixture.workspaceRoot,
            codeRoots: [fixture.codeRoot],
            scout: changed,
            resume: true,
          },
          io
        ),
      (err: unknown) => err instanceof ConflictError && /does not match/.test(err.message)
    );
    assert.equal(fs.existsSync(path.join(fixture.workspaceRoot, 'identity')), false);
  } finally {
    fixture.cleanup();
  }
});
