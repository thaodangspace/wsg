import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SLUG_RE,
  RESERVED_ROOT_NAMES,
  validateSlug,
  assertValidSlug,
  deriveSlug,
  suffixForSource,
  assignEntryNames,
} from '../src/slug.ts';
import { UsageError } from '../src/errors.ts';

test('slug accept/reject table', () => {
  const rejected = [
    '.',
    '..',
    'a'.repeat(65),
    '-leading-dash',
    '-',
    '--flag',
    'workspace.yaml',
    'README.md',
    'AGENTS.md',
    'CLAUDE.md',
    'docs',
    'scripts',
    '.wsg',
    '',
    'has space',
    'has/slash',
    'has\\backslash',
    '.hidden',
    '..hidden',
    'colon:test',
    '@special',
  ];

  for (const slug of rejected) {
    assert.equal(
      validateSlug(slug),
      false,
      `Expected slug '${slug}' to be rejected`
    );
    assert.throws(
      () => assertValidSlug(slug),
      UsageError,
      `Expected assertValidSlug('${slug}') to throw UsageError`
    );
  }

  const accepted = [
    'a',
    'a'.repeat(64),
    'valid-slug',
    'valid_slug',
    'valid.slug',
    'valid-slug-123',
    'my-workspace',
    'a1',
    'Test_Workspace-2.0',
    'port-emr',
    '007-agent',
  ];

  for (const slug of accepted) {
    assert.equal(
      validateSlug(slug),
      true,
      `Expected slug '${slug}' to be accepted`
    );
    assert.doesNotThrow(
      () => assertValidSlug(slug),
      `Expected assertValidSlug('${slug}') not to throw`
    );
  }
});

test('deriveSlug is deterministic, lowercase, and <= 64 characters', () => {
  const request =
    'Port EMR from the monolith to the modular architecture of the new system.';
  const slug1 = deriveSlug(request);
  const slug2 = deriveSlug(request);

  // Deterministic
  assert.equal(slug1, slug2);

  // Lowercase
  assert.equal(slug1, slug1.toLowerCase());

  // <= 64 characters
  assert(slug1.length <= 64);
  assert(slug1.length > 0);

  // Matches SLUG_RE and validateSlug
  assert(SLUG_RE.test(slug1));
  assert(validateSlug(slug1));

  // Verify exact derived slug
  assert.equal(
    slug1,
    'port-emr-from-the-monolith-to-the-modular-architecture-of-the-ne'
  );

  // Extremely long input truncated to <= 64
  const longRequest = 'Very '.repeat(50) + 'Long Request';
  const longSlug = deriveSlug(longRequest);
  assert(longSlug.length <= 64);
  assert(validateSlug(longSlug));
  assert(!longSlug.endsWith('-'));

  // Reserved names avoided
  const reservedRequest = 'docs';
  const derivedReserved = deriveSlug(reservedRequest);
  assert(!RESERVED_ROOT_NAMES.has(derivedReserved));
  assert(validateSlug(derivedReserved));

  // Non-alphanumeric input falls back to valid slug
  const emptySlug = deriveSlug('   !@#$%^&*()   ');
  assert.equal(emptySlug, 'workspace');
  assert(validateSlug(emptySlug));
});

test('suffixForSource produces 6 hex characters from sha256', () => {
  const s1 = suffixForSource('/path/to/repo-a');
  const s2 = suffixForSource('/path/to/repo-a');
  const s3 = suffixForSource('/path/to/repo-b');

  assert.match(s1, /^[0-9a-f]{6}$/);
  assert.equal(s1, s2);
  assert.notEqual(s1, s3);
});

test('assignEntryNames assigns a and a-<6hex>, stable across runs', () => {
  const sources = ['/path1/a', '/path2/a'];

  const run1 = assignEntryNames(sources);
  const run2 = assignEntryNames(sources);

  // Stable across runs
  assert.deepEqual(Array.from(run1.entries()), Array.from(run2.entries()));

  // First gets 'a', second gets 'a-<6hex>'
  const name1 = run1.get('/path1/a');
  const name2 = run1.get('/path2/a');

  assert.equal(name1, 'a');
  assert.match(name2!, /^a-[0-9a-f]{6}$/);
  assert.notEqual(name1, name2);

  // Multiple collisions
  const multiSources = ['/p1/app', '/p2/app', '/p3/app'];
  const multi = assignEntryNames(multiSources);
  const assigned = Array.from(multi.values());
  assert.equal(new Set(assigned).size, 3);
  assert.equal(multi.get('/p1/app'), 'app');
  assert.match(multi.get('/p2/app')!, /^app-[0-9a-f]{6}$/);
  assert.match(multi.get('/p3/app')!, /^app-[0-9a-f]{6}$/);

  // Duplicate spelling of same source maps to one entry
  const duplicateSources = ['/path1/a', '/path1/a/'];
  const dups = assignEntryNames(duplicateSources);
  assert.equal(dups.get('/path1/a'), 'a');
  assert.equal(dups.get('/path1/a/'), 'a');

  // Reserved root name gets suffixed
  const reservedSource = ['/code/docs'];
  const reservedResult = assignEntryNames(reservedSource);
  const reservedName = reservedResult.get('/code/docs');
  assert.notEqual(reservedName, 'docs');
  assert.match(reservedName!, /^docs-[0-9a-f]{6}$/);
});
