import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestRepo, type TestRepo } from './git-fixture.ts';
import type { ScoutResult } from '../../src/scout.ts';

export interface EmrFixture {
  /** Temporary directory containing symlinks to each repository. */
  codeRoot: string;
  workspaceRoot: string;
  legacy: TestRepo;
  modular: TestRepo;
  shared: TestRepo;
  unrelated: TestRepo;
  names: {
    legacy: string;
    modular: string;
    shared: string;
    unrelated: string;
  };
  /** A realistic, evidence-backed selection used by deterministic tests. */
  selection: ScoutResult;
  cleanup: () => void;
}

const LEGACY_FILE = 'src/emr/MedicalRecord.ts';
const MODULAR_FILE = 'src/patient/Patient.ts';
const SHARED_FILE = 'src/health/HealthRecord.ts';

export const EMR_FILES = {
  legacy: LEGACY_FILE,
  modular: MODULAR_FILE,
  shared: SHARED_FILE,
};

export const EMR_CONTENT = {
  legacy:
    'export class MedicalRecord {\n  constructor(public patientId: string) {}\n}\n// EMR legacy platform record\n',
  modular:
    "import type { HealthRecord } from 'shared-health-model';\nexport interface Patient {\n  id: string;\n  record: HealthRecord;\n}\n// EMR modular patient target\n",
  shared:
    'export interface HealthRecord {\n  code: string;\n  value: string;\n}\n// EMR shared health record\n',
};

/**
 * Builds the EMR-like fixture from the MVP acceptance: a legacy monolith, a
 * modular target that depends on a shared health model, and an unrelated
 * billing repository. Repositories are symlinked under one code root so
 * bounded enumeration and symlink handling are exercised.
 */
export function makeEmrFixture(): EmrFixture {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-emr-'));
  const codeRoot = path.join(base, 'code');
  const workspaceRoot = path.join(base, 'wsg');
  fs.mkdirSync(codeRoot, { recursive: true });
  fs.mkdirSync(workspaceRoot, { recursive: true });

  const legacy = createTestRepo({
    prefix: 'wsg-emr-legacy-',
    files: {
      [LEGACY_FILE]: EMR_CONTENT.legacy,
      'package.json': JSON.stringify({ name: 'legacy-platform', version: '1.0.0' }),
      'README.md': '# Legacy Platform\n\nMonolithic EMR implementation.\n',
    },
  });
  const modular = createTestRepo({
    prefix: 'wsg-emr-modular-',
    files: {
      [MODULAR_FILE]: EMR_CONTENT.modular,
      'package.json': JSON.stringify({
        name: 'new-platform',
        dependencies: { 'shared-health-model': 'workspace:*' },
      }),
      'README.md': '# New Platform\n\nModular target for the EMR port.\n',
    },
  });
  const shared = createTestRepo({
    prefix: 'wsg-emr-shared-',
    files: {
      [SHARED_FILE]: EMR_CONTENT.shared,
      'package.json': JSON.stringify({ name: 'shared-health-model' }),
      'README.md': '# Shared Health Model\n',
    },
  });
  const unrelated = createTestRepo({
    prefix: 'wsg-emr-billing-',
    files: {
      'src/billing.ts': 'export const monthlyInvoice = 42;\n',
      'README.md': '# Billing Service\n\nInvoices; unrelated to EMR.\n',
    },
  });

  const names = {
    legacy: 'legacy-platform',
    modular: 'new-platform',
    shared: 'shared-health-model',
    unrelated: 'billing-service',
  };
  fs.symlinkSync(legacy.dir, path.join(codeRoot, names.legacy));
  fs.symlinkSync(modular.dir, path.join(codeRoot, names.modular));
  fs.symlinkSync(shared.dir, path.join(codeRoot, names.shared));
  fs.symlinkSync(unrelated.dir, path.join(codeRoot, names.unrelated));

  const selection: ScoutResult = {
    kind: 'selection',
    repos: [
      {
        source: names.legacy,
        intent: 'source',
        addedBy: 'scout',
        reason: 'Owns the current monolithic EMR MedicalRecord implementation.',
        evidence: [
          {
            file: LEGACY_FILE,
            lines: [1, 3],
            summary: 'Defines the source MedicalRecord model.',
            quote: 'export class MedicalRecord',
          },
        ],
      },
      {
        source: names.modular,
        intent: 'target',
        addedBy: 'scout',
        reason: 'Modular target that consumes the shared health model.',
        evidence: [
          {
            file: MODULAR_FILE,
            lines: [2, 4],
            summary: 'Patient module depends on shared-health-model.',
            quote: 'export interface Patient',
          },
          {
            file: 'package.json',
            summary: 'Declares a dependency on shared-health-model.',
            quote: 'shared-health-model',
          },
        ],
      },
      {
        source: names.shared,
        intent: 'shared',
        addedBy: 'scout',
        reason: 'Shared health types used by both source and target.',
        evidence: [
          {
            file: SHARED_FILE,
            lines: [1, 4],
            summary: 'Shared HealthRecord type.',
            quote: 'export interface HealthRecord',
          },
        ],
      },
    ],
    docs: [],
    excluded: [
      {
        source: names.unrelated,
        reason: 'Billing mention is incidental; no EMR symbols or dependencies found.',
      },
    ],
    gaps: [],
  };

  const cleanup = () => {
    legacy.cleanup();
    modular.cleanup();
    shared.cleanup();
    unrelated.cleanup();
    fs.rmSync(base, { recursive: true, force: true });
  };

  return {
    codeRoot,
    workspaceRoot,
    legacy,
    modular,
    shared,
    unrelated,
    names,
    selection,
    cleanup,
  };
}
