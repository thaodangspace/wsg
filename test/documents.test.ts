import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  classifyDocInput,
  inspectDoc,
  referenceDoc,
  snapshotDoc,
  planDocs,
  isSecretFilename,
  containsSecretContent,
  isTextBuffer,
} from '../src/documents.ts';
import { UsageError } from '../src/errors.ts';
import { canonicalize } from '../src/paths.ts';
import { suffixForSource } from '../src/slug.ts';
import { sha256 } from '../src/fsx.ts';

test('URL vs file classification', () => {
  assert.equal(classifyDocInput('http://example.com/doc.md'), 'url');
  assert.equal(classifyDocInput('https://api.github.com/repos/owner/repo'), 'url');
  assert.equal(classifyDocInput('  https://example.org/spec  '), 'url');

  assert.equal(classifyDocInput('/absolute/path/to/doc.md'), 'file');
  assert.equal(classifyDocInput('./relative/path.md'), 'file');
  assert.equal(classifyDocInput('docs/notes.md'), 'file');
  assert.equal(classifyDocInput('notes.md'), 'file');
  assert.equal(classifyDocInput('~/notes.md'), 'file');
});

test('dir / symlink-to-dir / missing / unreadable throws UsageError', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-doc-test-'));

  try {
    // Missing file
    assert.throws(
      () => inspectDoc(path.join(tmpDir, 'nonexistent.md')),
      (err: unknown) => {
        assert.ok(err instanceof UsageError);
        assert.equal(err.exitCode, 1);
        assert.match(err.message, /does not exist/);
        return true;
      }
    );

    // Directory
    const subDir = path.join(tmpDir, 'subfolder');
    fs.mkdirSync(subDir);
    assert.throws(
      () => inspectDoc(subDir),
      (err: unknown) => {
        assert.ok(err instanceof UsageError);
        assert.equal(err.exitCode, 1);
        assert.match(err.message, /is a directory/);
        return true;
      }
    );

    // Symlink to directory
    const symlinkToDir = path.join(tmpDir, 'symlink-dir');
    fs.symlinkSync(subDir, symlinkToDir);
    assert.throws(
      () => inspectDoc(symlinkToDir),
      (err: unknown) => {
        assert.ok(err instanceof UsageError);
        assert.equal(err.exitCode, 1);
        assert.match(err.message, /is a directory/);
        return true;
      }
    );

    // Broken symlink
    const brokenSymlink = path.join(tmpDir, 'broken-link');
    fs.symlinkSync(path.join(tmpDir, 'nonexistent-target'), brokenSymlink);
    assert.throws(
      () => inspectDoc(brokenSymlink),
      (err: unknown) => {
        assert.ok(err instanceof UsageError);
        assert.equal(err.exitCode, 1);
        assert.match(err.message, /broken symbolic link/);
        return true;
      }
    );

    // Unreadable file (on POSIX systems where chmod 000 is honored)
    if (process.platform !== 'win32' && process.getuid && process.getuid() !== 0) {
      const unreadableFile = path.join(tmpDir, 'unreadable.md');
      fs.writeFileSync(unreadableFile, 'secret data');
      fs.chmodSync(unreadableFile, 0o000);
      try {
        assert.throws(
          () => inspectDoc(unreadableFile),
          (err: unknown) => {
            assert.ok(err instanceof UsageError);
            assert.equal(err.exitCode, 1);
            assert.match(err.message, /unreadable/);
            return true;
          }
        );
      } finally {
        fs.chmodSync(unreadableFile, 0o644);
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('.env, id_rsa, .md with BEGIN PRIVATE KEY throw exit-1 secret error', () => {
  // .env fixture
  assert.throws(
    () => inspectDoc('test/fixtures/docs/.env'),
    (err: unknown) => {
      assert.ok(err instanceof UsageError);
      assert.equal(err.exitCode, 1);
      assert.match(err.message, /secret-like file/);
      return true;
    }
  );

  // id_rsa fixture
  assert.throws(
    () => inspectDoc('test/fixtures/docs/id_rsa'),
    (err: unknown) => {
      assert.ok(err instanceof UsageError);
      assert.equal(err.exitCode, 1);
      assert.match(err.message, /secret-like file/);
      return true;
    }
  );

  // secret.md with BEGIN PRIVATE KEY
  assert.throws(
    () => inspectDoc('test/fixtures/docs/secret.md'),
    (err: unknown) => {
      assert.ok(err instanceof UsageError);
      assert.equal(err.exitCode, 1);
      assert.match(err.message, /private key/);
      return true;
    }
  );

  // In-memory pattern helpers
  assert.ok(isSecretFilename('.env'));
  assert.ok(isSecretFilename('.env.local'));
  assert.ok(isSecretFilename('app.env'));
  assert.ok(isSecretFilename('id_rsa'));
  assert.ok(isSecretFilename('id_ed25519'));
  assert.ok(!isSecretFilename('notes.md'));
  assert.ok(!isSecretFilename('readme.txt'));

  assert.ok(containsSecretContent('-----BEGIN PRIVATE KEY-----\nMIIE...'));
  assert.ok(containsSecretContent('-----BEGIN RSA PRIVATE KEY-----\nMIIE...'));
  assert.ok(containsSecretContent('BEGIN OPENSSH PRIVATE KEY'));
  assert.ok(!containsSecretContent('# Normal markdown file'));
});

test('secret marker beyond 512 KiB is detected and rejected', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-large-secret-'));
  try {
    const largeFile = path.join(tmpDir, 'large-doc.md');
    // 600 KiB of markdown text padding followed by secret key marker
    const padding = '# Heading\n' + 'A'.repeat(1024) + '\n';
    const numRepeats = Math.ceil((600 * 1024) / padding.length);
    const content = padding.repeat(numRepeats) + '\n-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASC\n';
    fs.writeFileSync(largeFile, content);

    assert.ok(fs.statSync(largeFile).size > 512 * 1024);
    assert.throws(
      () => inspectDoc(largeFile),
      (err: unknown) => {
        assert.ok(err instanceof UsageError);
        assert.equal(err.exitCode, 1);
        assert.match(err.message, /private key/);
        return true;
      }
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('protected filenames are rejected before reading content', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-secret-unread-'));
  try {
    const secretFile = path.join(tmpDir, '.env');
    fs.writeFileSync(secretFile, 'SECRET=hidden\n');

    // Make unreadable on POSIX if non-root
    if (process.platform !== 'win32' && process.getuid && process.getuid() !== 0) {
      fs.chmodSync(secretFile, 0o000);
    }

    try {
      assert.throws(
        () => inspectDoc(secretFile),
        (err: unknown) => {
          assert.ok(err instanceof UsageError);
          assert.equal(err.exitCode, 1);
          // Must match secret filename pattern rejection, NOT "unreadable" error
          assert.match(err.message, /filename matches protected pattern/);
          return true;
        }
      );
    } finally {
      if (process.platform !== 'win32' && process.getuid && process.getuid() !== 0) {
        fs.chmodSync(secretFile, 0o644);
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('PNG → text: false and text buffer detection', () => {
  const inspected = inspectDoc('test/fixtures/docs/sample.png');
  assert.equal(inspected.kind, 'file');
  assert.equal(inspected.text, false);

  const textInspected = inspectDoc('test/fixtures/docs/notes.md');
  assert.equal(textInspected.kind, 'file');
  assert.equal(textInspected.text, true);

  assert.equal(isTextBuffer(Buffer.from('Hello world\n')), true);
  assert.equal(isTextBuffer(Buffer.from([0x00, 0x01, 0x02])), false);
});

test('two notes.md → docs/notes.md, docs/notes-<6hex>.md with collision suffix', () => {
  const file1 = path.resolve('test/fixtures/docs/notes.md');
  const file2 = path.resolve('test/fixtures/docs/sub/notes.md');

  const planned = planDocs([file1, file2]);
  assert.equal(planned.length, 2);

  assert.equal(planned[0].path, 'docs/notes.md');
  const expectedSuffix = suffixForSource(canonicalize(file2));
  assert.equal(planned[1].path, `docs/notes-${expectedSuffix}.md`);

  assert.equal(planned[0].mode, 'snapshot');
  assert.equal(planned[1].mode, 'snapshot');
});

test('deterministic collisions with generated context/reserved docs (context.md)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-context-doc-'));
  try {
    const contextDocPath = path.join(tmpDir, 'context.md');
    fs.writeFileSync(contextDocPath, '# Custom Context\nUser supplied context doc.');

    const planned = planDocs([contextDocPath]);
    assert.equal(planned.length, 1);

    const expectedSuffix = suffixForSource(canonicalize(contextDocPath));
    assert.equal(planned[0].path, `docs/context-${expectedSuffix}.md`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('duplicate canonical sources are deduplicated', () => {
  const file1 = path.resolve('test/fixtures/docs/notes.md');
  const file2 = './test/fixtures/docs/notes.md';

  const planned = planDocs([file1, file2]);
  assert.equal(planned.length, 1);
  assert.equal(planned[0].path, 'docs/notes.md');
});

test('snapshot entry sha/ISO time/mode/realpath source', () => {
  const file = 'test/fixtures/docs/notes.md';
  const canonical = canonicalize(file);
  const content = fs.readFileSync(canonical);
  const expectedSha = sha256(content);

  const inspected = inspectDoc(file);
  assert.equal(inspected.kind, 'file');

  const snapshot = snapshotDoc(inspected, 'docs/notes.md');
  assert.equal(snapshot.mode, 'snapshot');
  assert.equal(snapshot.path, 'docs/notes.md');
  assert.equal(snapshot.source, canonical);
  assert.equal(snapshot.sha256, expectedSha);
  assert.equal(snapshot.added_by, 'user');
  assert.ok(snapshot.fetched_at);
  // Verify fetched_at is ISO timestamp
  assert.ok(!Number.isNaN(Date.parse(snapshot.fetched_at!)));

  // Test optional wsDir write
  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-ws-'));
  try {
    snapshotDoc(inspected, 'docs/written-notes.md', { wsDir: tmpWs });
    const writtenPath = path.join(tmpWs, 'docs/written-notes.md');
    assert.ok(fs.existsSync(writtenPath));
    assert.equal(fs.readFileSync(writtenPath, 'utf8'), content.toString('utf8'));
  } finally {
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});

test('snapshotDoc requires destination in docs/ and rejects context.md collisions', () => {
  const inspected = inspectDoc('test/fixtures/docs/notes.md');

  // Must be in docs/
  assert.throws(
    () => snapshotDoc(inspected, 'notes.md'),
    (err: unknown) => {
      assert.ok(err instanceof UsageError);
      assert.match(err.message, /must be inside 'docs\/'/);
      return true;
    }
  );

  assert.throws(
    () => snapshotDoc(inspected, 'other/notes.md'),
    (err: unknown) => {
      assert.ok(err instanceof UsageError);
      assert.match(err.message, /must be inside 'docs\/'/);
      return true;
    }
  );

  // Must not collide with generated docs/context.md
  assert.throws(
    () => snapshotDoc(inspected, 'docs/context.md'),
    (err: unknown) => {
      assert.ok(err instanceof UsageError);
      assert.match(err.message, /conflicts with reserved generated context/);
      return true;
    }
  );

  assert.throws(
    () => snapshotDoc(inspected, 'docs/Context.md'),
    (err: unknown) => {
      assert.ok(err instanceof UsageError);
      assert.match(err.message, /conflicts with reserved generated context/);
      return true;
    }
  );
});

test('snapshotDoc refuses writing through symlink escaping workspace', () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-snap-symlink-'));
  try {
    const wsDir = path.join(tmpBase, 'workspace');
    const outsideDir = path.join(tmpBase, 'outside');
    fs.mkdirSync(wsDir);
    fs.mkdirSync(outsideDir);

    // Create a symlink wsDir/docs pointing to outsideDir
    fs.symlinkSync(outsideDir, path.join(wsDir, 'docs'));

    const inspected = inspectDoc('test/fixtures/docs/notes.md');

    assert.throws(
      () => snapshotDoc(inspected, 'docs/notes.md', { wsDir }),
      (err: unknown) => {
        assert.ok(err instanceof UsageError);
        assert.match(err.message, /escapes workspace root via symlink/);
        return true;
      }
    );

    // Verify no file was written to outsideDir
    assert.equal(fs.readdirSync(outsideDir).length, 0);
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('URL → reference with "Not fetched in this version"', () => {
  const url = 'https://docs.example.com/api-spec.html';
  const ref = referenceDoc(url);

  assert.equal(ref.mode, 'reference');
  assert.equal(ref.source, url);
  assert.equal(ref.reason, 'Not fetched in this version');
  assert.equal(ref.path, undefined);
  assert.equal(ref.added_by, 'user');

  // Also via planDocs
  const planned = planDocs([url]);
  assert.equal(planned.length, 1);
  assert.equal(planned[0].mode, 'reference');
  assert.equal(planned[0].source, url);
  assert.equal(planned[0].reason, 'Not fetched in this version');
  assert.equal(planned[0].path, undefined);
});

test('symlink to file resolves realpath source correctly', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-symlink-doc-'));
  try {
    const realFile = path.join(tmpDir, 'real.md');
    fs.writeFileSync(realFile, '# Real file');
    const symlinkFile = path.join(tmpDir, 'link.md');
    fs.symlinkSync(realFile, symlinkFile);

    const inspected = inspectDoc(symlinkFile);
    assert.equal(inspected.kind, 'file');
    assert.equal(inspected.source, canonicalize(realFile));
    assert.equal(inspected.text, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('planDocs entries satisfy validateManifest schema', async () => {
  const { validateManifest } = await import('../src/manifest.ts');
  const file1 = path.resolve('test/fixtures/docs/notes.md');
  const url1 = 'https://example.com/api/v2/docs';

  const planned = planDocs([file1, url1]);
  assert.equal(planned.length, 2);

  const manifest = {
    version: 1 as const,
    name: 'schema-test',
    request: 'Test validateManifest compatibility',
    context: [],
    adapters: ['agents' as const],
    repos: [],
    docs: planned.map((p) => ({
      source: p.source,
      path: p.path,
      mode: p.mode,
      added_by: p.added_by,
      sha256: p.sha256,
      fetched_at: p.fetched_at,
      reason: p.reason,
    })),
    scripts: [],
    commands: [],
    discovery: { excluded: [], gaps: [] },
  };

  assert.doesNotThrow(() => validateManifest(manifest));
});
