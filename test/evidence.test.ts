import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestRepo } from './helpers/git-fixture.ts';
import {
  validateEvidenceItem,
  validateScoutSelection,
  findTargetAmbiguity,
  type AllowedRepo,
} from '../src/evidence.ts';
import { UsageError } from '../src/errors.ts';
import type { ScoutSelection } from '../src/scout.ts';

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('validateEvidenceItem accepts real evidence and maps it to the manifest shape', () => {
  const repo = createTestRepo({
    prefix: 'wsg-ev-',
    files: { 'src/a.ts': 'line one\nline two\nexport class Widget {}\n' },
  });
  try {
    const allowed: AllowedRepo = { name: 'ev', source: repo.dir };
    const evidence = validateEvidenceItem(allowed, {
      file: 'src/a.ts',
      lines: [3, 3],
      summary: 'Widget class',
      quote: 'export class Widget',
    });
    assert.deepEqual(evidence, { file: 'src/a.ts', lines: [3, 3], summary: 'Widget class' });
  } finally {
    repo.cleanup();
  }
});

test('validateEvidenceItem rejects missing files, bad ranges, fictional quotes, and vendor paths', () => {
  const repo = createTestRepo({
    prefix: 'wsg-ev-bad-',
    files: { 'src/a.ts': 'alpha\nbeta\ngamma\n' },
  });
  try {
    const allowed: AllowedRepo = { name: 'ev', source: repo.dir };
    const base = { summary: 's', quote: 'alpha' };

    assert.throws(
      () => validateEvidenceItem(allowed, { ...base, file: 'src/missing.ts' }),
      /missing file/
    );
    assert.throws(
      () => validateEvidenceItem(allowed, { ...base, file: 'src/a.ts', lines: [2, 99] }),
      /only 4 lines|only \d+ lines/
    );
    assert.throws(
      () => validateEvidenceItem(allowed, { ...base, file: 'src/a.ts', quote: 'delta' }),
      /does not contain the quoted snippet/
    );
    // Quote exists in the file but outside the cited range.
    assert.throws(
      () => validateEvidenceItem(allowed, { ...base, file: 'src/a.ts', lines: [1, 1], quote: 'gamma' }),
      /does not contain the quoted snippet/
    );
    assert.throws(
      () => validateEvidenceItem(allowed, { ...base, file: 'node_modules/x.ts' }),
      /vendor path/
    );
    assert.throws(
      () => validateEvidenceItem(allowed, { ...base, file: '../secret.ts' }),
      /must not contain '\.\.'|not a valid relative path|escapes/
    );
  } finally {
    repo.cleanup();
  }
});

test('validateScoutSelection requires evidence for discovered selections and resolves by name', () => {
  const repo = createTestRepo({
    prefix: 'wsg-ev-sel-',
    files: { 'src/a.ts': 'export class Widget {}\n' },
  });
  try {
    const allowed: AllowedRepo[] = [{ name: 'ev', source: repo.dir }];
    const selection: ScoutSelection = {
      kind: 'selection',
      repos: [
        { source: 'ev', intent: 'target', evidence: [{ file: 'src/a.ts', summary: 'w', quote: 'export class Widget' }] },
      ],
      docs: [],
    };
    const validated = validateScoutSelection(selection, allowed);
    assert.equal(validated.repos.length, 1);
    assert.equal(validated.repos[0].source, repo.dir);
    assert.equal(validated.repos[0].intent, 'target');
  } finally {
    repo.cleanup();
  }
});

test('validateScoutSelection rejects unknown repositories and evidence-free selections', () => {
  const repo = createTestRepo({ prefix: 'wsg-ev-sel2-' });
  try {
    const allowed: AllowedRepo[] = [{ name: 'ev', source: repo.dir }];

    assert.throws(
      () =>
        validateScoutSelection(
          { kind: 'selection', repos: [{ source: '/nope', evidence: [] }], docs: [] },
          allowed
        ),
      /was not enumerated/
    );

    assert.throws(
      () =>
        validateScoutSelection(
          { kind: 'selection', repos: [{ source: 'ev' }], docs: [] },
          allowed
        ),
      /without evidence/
    );

    // Explicit (user) repos may legitimately carry no evidence.
    const explicit = validateScoutSelection(
      { kind: 'selection', repos: [{ source: 'ev', addedBy: 'user' }], docs: [] },
      allowed
    );
    assert.equal(explicit.repos[0].addedBy, 'user');
    assert.deepEqual(explicit.repos[0].evidence, []);
  } finally {
    repo.cleanup();
  }
});

test('findTargetAmbiguity flags more than one target repository', () => {
  const base = {
    name: 'x',
    source: '/x',
    addedBy: 'scout' as const,
    reason: 'r',
    evidence: [],
  };
  const ambiguous = findTargetAmbiguity({
    repos: [
      { ...base, name: 'a', source: '/a', intent: 'target' },
      { ...base, name: 'b', source: '/b', intent: 'target' },
    ],
    excluded: [],
    gaps: [],
    context: [],
    docs: [],
  });
  assert.ok(ambiguous);
  assert.equal(ambiguous?.candidates.length, 2);

  const focused = findTargetAmbiguity({
    repos: [{ ...base, intent: 'target' }, { ...base, name: 's', source: '/s', intent: 'source' }],
    excluded: [],
    gaps: [],
    context: [],
    docs: [],
  });
  assert.equal(focused, null);
});

test('validateEvidenceItem surfaces a UsageError for empty summaries', () => {
  const repo = createTestRepo({ prefix: 'wsg-ev-sum-' });
  try {
    assert.throws(
      () => validateEvidenceItem({ name: 'ev', source: repo.dir }, { file: 'README.md', summary: '', quote: '# Test Repo' }),
      (err: unknown) => err instanceof UsageError
    );
  } finally {
    repo.cleanup();
  }
});
