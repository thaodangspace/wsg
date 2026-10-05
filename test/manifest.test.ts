import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  parseManifest,
  validateManifest,
  serializeManifest,
  MANIFEST_VERSION,
  IntentSchema,
  RepoEntrySchema,
  EvidenceSchema,
  DocEntrySchema,
  ScriptEntrySchema,
  CommandEntrySchema,
  DiscoverySchema,
  ManifestSchema,
  type Manifest,
} from '../src/manifest.ts';
import { checkBranchName, runGit } from '../src/git.ts';
import { UsageError } from '../src/errors.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturesDir = path.join(__dirname, 'fixtures', 'manifests');

function readFixture(name: string): string {
  return readFileSync(path.join(fixturesDir, name), 'utf8');
}

test('schemas and constants are exported', () => {
  assert.equal(MANIFEST_VERSION, 1);
  assert.ok(IntentSchema);
  assert.ok(RepoEntrySchema);
  assert.ok(EvidenceSchema);
  assert.ok(DocEntrySchema);
  assert.ok(ScriptEntrySchema);
  assert.ok(CommandEntrySchema);
  assert.ok(DiscoverySchema);
  assert.ok(ManifestSchema);
});

test('repo spec §5 example (placeholders filled) parses', () => {
  const content = readFixture('spec-section-5.yaml');
  const manifest = parseManifest(content);

  assert.equal(manifest.version, 1);
  assert.equal(manifest.name, 'port-emr');
  assert.match(manifest.request, /Port EMR from the monolith/);
  assert.deepEqual(manifest.context, [
    'The target uses patient-service module boundaries.',
  ]);
  assert.deepEqual(manifest.adapters, ['agents', 'claude']);
  assert.equal(manifest.repos.length, 2);

  const [legacy, newPlatform] = manifest.repos;
  assert.equal(legacy.name, 'legacy-platform');
  assert.equal(legacy.source, '/home/user/code/legacy-platform');
  assert.equal(legacy.path, 'legacy-platform');
  assert.equal(legacy.base_commit, '0123456789abcdef0123456789abcdef01234567');
  assert.equal(legacy.branch, 'wsg/port-emr/legacy-platform');
  assert.equal(legacy.intent, 'reference');
  assert.equal(legacy.added_by, 'scout');
  assert.equal(legacy.reason, 'Owns the current EMR implementation.');
  assert.equal(legacy.evidence.length, 1);
  assert.deepEqual(legacy.evidence[0], {
    file: 'src/emr/MedicalRecord.ts',
    lines: [12, 48],
    summary: 'Defines the source MedicalRecord model.',
  });

  assert.equal(newPlatform.name, 'new-platform');
  assert.equal(newPlatform.intent, 'target');
  assert.equal(newPlatform.added_by, 'user');
  assert.deepEqual(newPlatform.evidence, []);

  assert.equal(manifest.docs.length, 2);
  const [doc1, doc2] = manifest.docs;
  assert.equal(doc1.mode, 'snapshot');
  assert.equal(doc1.path, 'docs/emr-migration.md');
  assert.equal(
    doc1.sha256,
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
  );
  assert.equal(doc2.mode, 'reference');
  assert.equal(doc2.path, undefined);

  assert.deepEqual(manifest.scripts, []);
  assert.equal(manifest.commands.length, 1);
  assert.equal(manifest.commands[0].name, 'test-new-platform');
  assert.equal(manifest.commands[0].cwd, 'new-platform');
  assert.deepEqual(manifest.commands[0].argv, ['npm', 'run', 'test']);

  assert.equal(manifest.discovery.excluded.length, 1);
  assert.equal(manifest.discovery.gaps.length, 1);
});

test('version: 2 → "Unsupported workspace.yaml version 2" only', () => {
  const content = readFixture('version-2.yaml');
  assert.throws(
    () => parseManifest(content),
    (err: unknown) => {
      assert(err instanceof UsageError);
      assert.equal(err.message, 'Unsupported workspace.yaml version 2');
      assert.equal(err.hints.length, 0);
      return true;
    }
  );

  // Even when other fields are invalid/missing, version-first rejection reports only version error
  const invalidV2 = `version: 2
repos:
  - foo: bar
`;
  assert.throws(
    () => parseManifest(invalidV2),
    (err: unknown) => {
      assert(err instanceof UsageError);
      assert.equal(err.message, 'Unsupported workspace.yaml version 2');
      return true;
    }
  );
});

test('unknown repos[0].foo → line:col', () => {
  const content = readFixture('unknown-field.yaml');
  assert.throws(
    () => parseManifest(content),
    (err: unknown) => {
      assert(err instanceof UsageError);
      assert.match(err.message, /unknown key 'repos\[0\]\.foo'/);
      assert.match(err.message, /14:5/);
      return true;
    }
  );
});

test('missing request rejected', () => {
  const content = readFixture('missing-request.yaml');
  assert.throws(
    () => parseManifest(content),
    (err: unknown) => {
      assert(err instanceof UsageError);
      assert.match(err.message, /request/);
      return true;
    }
  );
});

test('intent: unspecified ok, bogus rejected', () => {
  const validYaml = `version: 1
name: test-ws
request: |
  A test request
repos:
  - name: repo-a
    source: /home/user/code/repo-a
    path: repo-a
    base_commit: 0123456789abcdef0123456789abcdef01234567
    branch: wsg/test-ws/repo-a
    intent: unspecified
    added_by: user
    reason: Explicit repository supplied by the user.
docs: []
`;
  const manifest = parseManifest(validYaml);
  assert.equal(manifest.repos[0].intent, 'unspecified');

  const bogusContent = readFixture('intent-bogus.yaml');
  assert.throws(
    () => parseManifest(bogusContent),
    (err: unknown) => {
      assert(err instanceof UsageError);
      assert.match(err.message, /intent/);
      return true;
    }
  );
});

test('duplicate repo name/path/source rejected', () => {
  assert.throws(
    () => parseManifest(readFixture('duplicate-repo-name.yaml')),
    (err: unknown) => {
      assert(err instanceof UsageError);
      assert.match(err.message, /duplicate repo name 'my-repo'/);
      return true;
    }
  );

  assert.throws(
    () => parseManifest(readFixture('duplicate-repo-path.yaml')),
    (err: unknown) => {
      assert(err instanceof UsageError);
      assert.match(err.message, /duplicate repo path 'shared-path'/);
      return true;
    }
  );

  assert.throws(
    () => parseManifest(readFixture('duplicate-repo-source.yaml')),
    (err: unknown) => {
      assert(err instanceof UsageError);
      assert.match(err.message, /duplicate repo source/);
      return true;
    }
  );

  // Duplicate canonical source with trailing slash
  const trailingSlashYaml = `version: 1
name: test-ws
request: |
  A test request
repos:
  - name: repo1
    source: /home/user/code/repo1
    path: repo1
    base_commit: 0123456789abcdef0123456789abcdef01234567
    branch: wsg/test-ws/repo1
    intent: reference
    added_by: user
    reason: Repo 1
  - name: repo2
    source: /home/user/code/repo1/
    path: repo2
    base_commit: 0123456789abcdef0123456789abcdef01234567
    branch: wsg/test-ws/repo2
    intent: reference
    added_by: user
    reason: Repo 2
docs: []
`;
  assert.throws(
    () => parseManifest(trailingSlashYaml),
    (err: unknown) => {
      assert(err instanceof UsageError);
      assert.match(err.message, /duplicate repo source/);
      return true;
    }
  );
});

test('path: ../x rejected', () => {
  assert.throws(
    () => parseManifest(readFixture('invalid-path-traversal.yaml')),
    (err: unknown) => {
      assert(err instanceof UsageError);
      assert.match(err.message, /\.\./);
      return true;
    }
  );
});

test('39-hex base_commit rejected', () => {
  assert.throws(
    () => parseManifest(readFixture('invalid-base-commit.yaml')),
    (err: unknown) => {
      assert(err instanceof UsageError);
      assert.match(err.message, /base_commit/);
      return true;
    }
  );
});

test('branch: bad..name rejected', () => {
  assert.throws(
    () => parseManifest(readFixture('invalid-branch.yaml')),
    (err: unknown) => {
      assert(err instanceof UsageError);
      assert.match(err.message, /branch.*bad\.\.name/);
      return true;
    }
  );
});

test('commands[0].cwd: nope rejected', () => {
  assert.throws(
    () => parseManifest(readFixture('invalid-command-cwd.yaml')),
    (err: unknown) => {
      assert(err instanceof UsageError);
      assert.match(err.message, /cwd 'nope'/);
      return true;
    }
  );
});

test('reference doc with path rejected', () => {
  assert.throws(
    () => parseManifest(readFixture('invalid-reference-doc.yaml')),
    (err: unknown) => {
      assert(err instanceof UsageError);
      assert.match(err.message, /reference doc.*must not have a 'path'/);
      return true;
    }
  );
});

test('snapshot doc without sha256 rejected', () => {
  assert.throws(
    () => parseManifest(readFixture('invalid-snapshot-doc.yaml')),
    (err: unknown) => {
      assert(err instanceof UsageError);
      assert.match(err.message, /snapshot doc.*must have a 'sha256'/);
      return true;
    }
  );
});

test('round-trip serialize(parse(x)) byte-stable on second pass, spec key order, request as | block', () => {
  const content = readFixture('spec-section-5.yaml');
  const parsed1 = parseManifest(content);
  const serialized1 = serializeManifest(parsed1);
  const parsed2 = parseManifest(serialized1);
  const serialized2 = serializeManifest(parsed2);

  // Byte-stable on second pass
  assert.equal(serialized1, serialized2);

  // request is formatted as | block
  assert.match(
    serialized1,
    /request: \|\n  Port EMR from the monolith to the modular architecture of the new system\./
  );

  // Spec key order at top level: version, name, request, context, adapters, repos, docs, scripts, commands, discovery
  const keyOrder = [
    'version:',
    'name:',
    'request:',
    'context:',
    'adapters:',
    'repos:',
    'docs:',
    'scripts:',
    'commands:',
    'discovery:',
  ];

  let lastIndex = -1;
  for (const key of keyOrder) {
    const idx = serialized1.indexOf(key);
    assert.ok(
      idx > lastIndex,
      `Key ${key} should appear after previous key in spec order (found at ${idx}, previous at ${lastIndex})`
    );
    lastIndex = idx;
  }
});

test('parseManifest filename option formats positioned errors with filename prefix', () => {
  const content = readFixture('unknown-field.yaml');
  assert.throws(
    () => parseManifest(content, { filename: 'workspace.yaml' }),
    (err: unknown) => {
      assert(err instanceof UsageError);
      assert.match(err.message, /^workspace\.yaml:14:5: unknown key 'repos\[0\]\.foo'/);
      return true;
    }
  );
});

test('validateManifest rejects invalid workspace names and empty requests', () => {
  const base = parseManifest(readFixture('spec-section-5.yaml'));

  assert.throws(
    () => validateManifest({ ...base, name: 'invalid/name' }),
    (err: unknown) => {
      assert(err instanceof UsageError);
      assert.match(err.message, /Workspace name 'invalid\/name' is invalid/);
      return true;
    }
  );

  assert.throws(
    () => validateManifest({ ...base, name: 'workspace.yaml' }),
    (err: unknown) => {
      assert(err instanceof UsageError);
      assert.match(err.message, /reserved name/);
      return true;
    }
  );

  assert.throws(
    () => validateManifest({ ...base, request: '   ' }),
    (err: unknown) => {
      assert(err instanceof UsageError);
      assert.match(err.message, /Workspace request must not be empty/);
      return true;
    }
  );
});

test('validateManifest rejects reserved root names and backslashes in repo paths', () => {
  const base = parseManifest(readFixture('spec-section-5.yaml'));

  const reservedRepo = { ...base.repos[0], path: 'docs' };
  assert.throws(
    () => validateManifest({ ...base, repos: [reservedRepo] }),
    (err: unknown) => {
      assert(err instanceof UsageError);
      assert.match(err.message, /reserved root name/);
      return true;
    }
  );

  const backslashRepo = { ...base.repos[0], path: 'legacy\\platform' };
  assert.throws(
    () => validateManifest({ ...base, repos: [backslashRepo] }),
    (err: unknown) => {
      assert(err instanceof UsageError);
      assert.match(err.message, /backslashes/);
      return true;
    }
  );
});

test('validateManifest rejects invalid evidence lines range', () => {
  const base = parseManifest(readFixture('spec-section-5.yaml'));
  const badEvidenceRepo = {
    ...base.repos[0],
    evidence: [
      {
        file: 'src/emr/MedicalRecord.ts',
        lines: [48, 12] as [number, number],
        summary: 'inverted lines',
      },
    ],
  };

  assert.throws(
    () => validateManifest({ ...base, repos: [badEvidenceRepo] }),
    (err: unknown) => {
      assert(err instanceof UsageError);
      assert.match(err.message, /evidence\[0\]\.lines start \(48\) must be <= end \(12\)/);
      return true;
    }
  );
});

test('validateManifest rejects snapshot doc with non-64-hex sha256', () => {
  const base = parseManifest(readFixture('spec-section-5.yaml'));
  const badDoc = {
    ...base.docs[0],
    sha256: 'not-a-valid-hex-hash',
  };

  assert.throws(
    () => validateManifest({ ...base, docs: [badDoc] }),
    (err: unknown) => {
      assert(err instanceof UsageError);
      assert.match(err.message, /64-character hexadecimal/);
      return true;
    }
  );
});

test('seed git functions checkBranchName and runGit', () => {
  assert.equal(checkBranchName('main'), true);
  assert.equal(checkBranchName('wsg/port-emr/legacy-platform'), true);
  assert.equal(checkBranchName('feature/my-branch_123'), true);
  assert.equal(checkBranchName('bad..name'), false);
  assert.equal(checkBranchName('-bad'), false);
  assert.equal(checkBranchName('bad/'), false);
  assert.equal(checkBranchName(''), false);

  const gitVer = runGit(['--version']);
  assert.match(gitVer, /git version/);

  assert.throws(() => runGit(['non-existent-subcommand-12345']));
});
