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
import { ObservedEvidenceStore } from '../src/observed.ts';
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
      /vendor\/build directory/
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
    const store = new ObservedEvidenceStore();
    store.observe(repo.dir, 'src/a.ts', 1, ['export class Widget {}']);
    const validated = validateScoutSelection(selection, allowed, { observed: store });
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
      /neither an explicit --repo input nor enumerated/
    );

    assert.throws(
      () =>
        validateScoutSelection(
          { kind: 'selection', repos: [{ source: 'ev' }], docs: [] },
          allowed
        ),
      /without evidence/
    );

    // Explicit allowed entries may legitimately carry no evidence (covered by
    // the dedicated explicit-repository test).
    assert.throws(
      () =>
        validateScoutSelection(
          { kind: 'selection', repos: [{ source: 'ev', addedBy: 'user' }], docs: [] },
          allowed
        ),
      /without evidence/
    );
  } finally {
    repo.cleanup();
  }
});

test('findTargetAmbiguity flags more than one target repository', () => {
  const base = {
    name: 'x',
    source: '/x',
    addedBy: 'scout' as const,
    explicit: false,
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

test('validateEvidenceItem rejects intermediate directory symlink escapes', () => {
  const repo = createTestRepo({ prefix: 'wsg-ev-intermediate-', files: { 'sub/real.ts': 'export const real = 1;\n' } });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-ev-outside-'));
  fs.writeFileSync(path.join(outside, 'secret.ts'), 'export const secret = 1;\n');
  fs.symlinkSync(outside, path.join(repo.dir, 'escape'));
  try {
    const allowed: AllowedRepo = { name: 'ev', source: repo.dir };
    assert.throws(
      () => validateEvidenceItem(allowed, { file: 'escape/secret.ts', summary: 's', quote: 'secret' }),
      /not confined|escapes/
    );
  } finally {
    repo.cleanup();
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('validateEvidenceItem rejects multi-level vendor paths and .pem secrets', () => {
  const repo = createTestRepo({
    prefix: 'wsg-ev-vendor-',
    files: { 'src/node_modules/x.ts': 'export const x = 1;\n', 'key.pem': 'PRIVATE\n' },
  });
  try {
    const allowed: AllowedRepo = { name: 'ev', source: repo.dir };
    assert.throws(
      () => validateEvidenceItem(allowed, { file: 'src/node_modules/x.ts', summary: 's', quote: 'x' }),
      /vendor\/build directory/
    );
    assert.throws(
      () => validateEvidenceItem(allowed, { file: 'key.pem', summary: 's', quote: 'PRIVATE' }),
      /secret-like/
    );
  } finally {
    repo.cleanup();
  }
});

test('validateEvidenceItem refuses unseen evidence unless it was observed', () => {
  const repo = createTestRepo({
    prefix: 'wsg-ev-unseen-',
    files: { 'src/real.ts': 'export const real = 1;\n' },
  });
  try {
    const allowed: AllowedRepo = { name: 'ev', source: repo.dir };
    const item = { file: 'src/real.ts', summary: 's', quote: 'export const real' };

    assert.throws(
      () => validateEvidenceItem(allowed, item, { observed: new ObservedEvidenceStore() }),
      /never retrieved or observed/
    );

    const observed = new ObservedEvidenceStore();
    observed.observe(repo.dir, 'src/real.ts', 1, ['export const real = 1;']);
    const evidence = validateEvidenceItem(allowed, item, { observed });
    assert.deepEqual(evidence, { file: 'src/real.ts', summary: 's' });
  } finally {
    repo.cleanup();
  }
});

test('observe-range grounding: a quote from an unread line is rejected', () => {
  const repo = createTestRepo({
    prefix: 'wsg-ev-range-',
    files: { 'src/large.ts': 'line one observed\nexport const secret = 1;\nline three\n' },
  });
  try {
    const allowed: AllowedRepo = { name: 'ev', source: repo.dir };
    const observed = new ObservedEvidenceStore();
    // Only line 1 was delivered to the scout.
    observed.observe(repo.dir, 'src/large.ts', 1, ['line one observed']);

    // Citing line 2 with a real quote from line 2 must fail: line 2 was unseen.
    assert.throws(
      () =>
        validateEvidenceItem(
          allowed,
          { file: 'src/large.ts', lines: [2, 2], summary: 's', quote: 'export const secret' },
          { observed }
        ),
      /were not observed|does not contain/
    );

    // An ungrounded quote without lines must also fail.
    assert.throws(
      () =>
        validateEvidenceItem(
          allowed,
          { file: 'src/large.ts', summary: 's', quote: 'export const secret' },
          { observed }
        ),
      /does not contain the quoted snippet in any observed slice/
    );

    // The observed line is accepted.
    const evidence = validateEvidenceItem(
      allowed,
      { file: 'src/large.ts', lines: [1, 1], summary: 's', quote: 'line one observed' },
      { observed }
    );
    assert.deepEqual(evidence, { file: 'src/large.ts', lines: [1, 1], summary: 's' });
  } finally {
    repo.cleanup();
  }
});

test('validateScoutSelection accepts explicit repositories outside the roots without evidence', () => {
  const allowed: AllowedRepo[] = [
    { name: 'outside', source: '/outside', explicit: true },
  ];
  const validated = validateScoutSelection(
    {
      kind: 'selection',
      repos: [{ source: '/outside', intent: 'target', reason: 'user supplied' }],
      docs: [],
    },
    allowed
  );
  assert.equal(validated.repos.length, 1);
  assert.equal(validated.repos[0].explicit, true);
  assert.equal(validated.repos[0].addedBy, 'user');
  assert.deepEqual(validated.repos[0].evidence, []);
});

