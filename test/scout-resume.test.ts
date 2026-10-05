import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeEmrFixture } from './helpers/emr-fixture.ts';
import { enumerateRepos } from '../src/discovery.ts';
import { PiScout, SCOUT_DB_FILENAME, SCOUT_TOOL_NAMES } from '../src/pi-scout.ts';
import { runCreate } from '../src/create.ts';
import { parseManifest } from '../src/manifest.ts';
import { ConflictError } from '../src/errors.ts';

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

test('resuming scouting with a changed task conflicts instead of replaying the old selection', { skip }, async () => {
  const fixture = makeEmrFixture();
  const stateDir = path.join(fixture.workspaceRoot, '.wsg-scout', 'identity');
  try {
    const discovery = enumerateRepos([fixture.codeRoot]);
    const first = new PiScout({
      discovered: discovery.repos,
      provider: 'faux',
      fauxScript: [
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
