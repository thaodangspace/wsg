import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reconcileGenerated } from '../src/ownership.ts';
import { sha256 } from '../src/fsx.ts';
import { initWsgDir, readOperation, writeOperation, type OwnedFileEntry } from '../src/operation.ts';
import { UsageError } from '../src/errors.ts';

test('fresh → written + recorded', () => {
  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-owner-fresh-'));
  try {
    const files = new Map<string, string>([
      ['docs/context.md', '# Generated Context\nInitial version.'],
      ['README.md', '# Workspace\nInitial readme.'],
    ]);

    const owned: Record<string, OwnedFileEntry> = {};
    const result = reconcileGenerated(tmpWs, files, owned);

    assert.equal(result.partial, false);
    assert.deepEqual(result.written.sort(), ['README.md', 'docs/context.md']);
    assert.deepEqual(result.proposals, []);

    // Check files exist on disk with correct content
    assert.equal(
      fs.readFileSync(path.join(tmpWs, 'docs/context.md'), 'utf8'),
      '# Generated Context\nInitial version.'
    );
    assert.equal(
      fs.readFileSync(path.join(tmpWs, 'README.md'), 'utf8'),
      '# Workspace\nInitial readme.'
    );

    // Check owned record
    assert.ok(owned['docs/context.md']);
    assert.equal(
      owned['docs/context.md'].sha256,
      sha256('# Generated Context\nInitial version.')
    );
    assert.ok(owned['README.md']);
    assert.equal(
      owned['README.md'].sha256,
      sha256('# Workspace\nInitial readme.')
    );
  } finally {
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});

test('unchanged owned → overwritten', () => {
  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-owner-unchanged-'));
  try {
    // 1. Initial generation (fresh)
    const initialFiles = {
      'docs/context.md': '# Generated Context v1',
      'README.md': '# Workspace v1',
    };
    const owned: Record<string, OwnedFileEntry> = {};
    reconcileGenerated(tmpWs, initialFiles, owned);

    // 2. Second generation with updated content (unchanged by user)
    const updatedFiles = {
      'docs/context.md': '# Generated Context v2',
      'README.md': '# Workspace v2',
    };
    const result = reconcileGenerated(tmpWs, updatedFiles, owned);

    assert.equal(result.partial, false);
    assert.deepEqual(result.written.sort(), ['README.md', 'docs/context.md']);
    assert.deepEqual(result.proposals, []);

    // Files on disk are overwritten with v2
    assert.equal(
      fs.readFileSync(path.join(tmpWs, 'docs/context.md'), 'utf8'),
      '# Generated Context v2'
    );
    assert.equal(
      fs.readFileSync(path.join(tmpWs, 'README.md'), 'utf8'),
      '# Workspace v2'
    );

    // Owned hashes updated to v2
    assert.equal(
      owned['docs/context.md'].sha256,
      sha256('# Generated Context v2')
    );
    assert.equal(
      owned['README.md'].sha256,
      sha256('# Workspace v2')
    );
  } finally {
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});

test('edited → untouched + .wsg-new + partial: true', () => {
  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-owner-edited-'));
  try {
    // 1. Initial generation
    const initialFiles = {
      'docs/context.md': '# Generated Context v1',
      'README.md': '# Workspace v1',
    };
    const owned: Record<string, OwnedFileEntry> = {};
    reconcileGenerated(tmpWs, initialFiles, owned);

    // 2. User edits docs/context.md
    const userEdits = '# Generated Context v1\nUser added manual notes here!';
    fs.writeFileSync(path.join(tmpWs, 'docs/context.md'), userEdits);

    // 3. Reconcile with v2 content
    const v2Files = {
      'docs/context.md': '# Generated Context v2',
      'README.md': '# Workspace v2',
    };
    const result = reconcileGenerated(tmpWs, v2Files, owned);

    assert.equal(result.partial, true);
    assert.deepEqual(result.written, ['README.md']); // README was unchanged, so overwritten
    assert.deepEqual(result.proposals, ['docs/context.md.wsg-new']);

    // User edits remain untouched in docs/context.md!
    assert.equal(
      fs.readFileSync(path.join(tmpWs, 'docs/context.md'), 'utf8'),
      userEdits
    );

    // Proposal was written to docs/context.md.wsg-new
    assert.equal(
      fs.readFileSync(path.join(tmpWs, 'docs/context.md.wsg-new'), 'utf8'),
      '# Generated Context v2'
    );

    // README.md was overwritten with v2
    assert.equal(
      fs.readFileSync(path.join(tmpWs, 'README.md'), 'utf8'),
      '# Workspace v2'
    );

    // owned hash for docs/context.md remains at v1 (or unmodified, not updated to v2)
    assert.equal(
      owned['docs/context.md'].sha256,
      sha256('# Generated Context v1')
    );
  } finally {
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});

test('unowned pre-existing file on disk is not clobbered and writes .wsg-new', () => {
  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-owner-unowned-'));
  try {
    // User already created README.md before WSG ran
    const preexistingContent = '# Existing Manual Readme';
    fs.writeFileSync(path.join(tmpWs, 'README.md'), preexistingContent);

    const files = {
      'README.md': '# Generated Workspace Readme',
    };
    const owned: Record<string, OwnedFileEntry> = {};

    const result = reconcileGenerated(tmpWs, files, owned);

    assert.equal(result.partial, true);
    assert.deepEqual(result.proposals, ['README.md.wsg-new']);

    // Pre-existing file is untouched
    assert.equal(
      fs.readFileSync(path.join(tmpWs, 'README.md'), 'utf8'),
      preexistingContent
    );

    // Proposal file written
    assert.equal(
      fs.readFileSync(path.join(tmpWs, 'README.md.wsg-new'), 'utf8'),
      '# Generated Workspace Readme'
    );
  } finally {
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});

test('identical content on disk is marked unmodified without rewriting or proposals', () => {
  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-owner-identical-'));
  try {
    const files = {
      'README.md': '# Workspace',
    };
    const owned: Record<string, OwnedFileEntry> = {};

    // 1. Initial write
    reconcileGenerated(tmpWs, files, owned);

    // 2. Reconcile with identical content
    const result = reconcileGenerated(tmpWs, files, owned);

    assert.equal(result.partial, false);
    assert.deepEqual(result.written, []);
    assert.deepEqual(result.unmodified, ['README.md']);
    assert.deepEqual(result.proposals, []);
  } finally {
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});

test('mixed batch: fresh, unchanged, and edited in single reconcile call', () => {
  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-owner-mixed-'));
  try {
    const owned: Record<string, OwnedFileEntry> = {
      'file1.md': { sha256: sha256('v1'), generatedAt: new Date().toISOString() },
      'file2.md': { sha256: sha256('v1'), generatedAt: new Date().toISOString() },
    };
    fs.writeFileSync(path.join(tmpWs, 'file1.md'), 'v1'); // unchanged
    fs.writeFileSync(path.join(tmpWs, 'file2.md'), 'v1-edited'); // edited by user
    // file3.md does not exist -> fresh

    const files = {
      'file1.md': 'v2',
      'file2.md': 'v2',
      'file3.md': 'v2',
    };

    const result = reconcileGenerated(tmpWs, files, owned);

    assert.equal(result.partial, true);
    assert.deepEqual(result.written.sort(), ['file1.md', 'file3.md']);
    assert.deepEqual(result.proposals, ['file2.md.wsg-new']);

    assert.equal(fs.readFileSync(path.join(tmpWs, 'file1.md'), 'utf8'), 'v2');
    assert.equal(fs.readFileSync(path.join(tmpWs, 'file2.md'), 'utf8'), 'v1-edited');
    assert.equal(fs.readFileSync(path.join(tmpWs, 'file2.md.wsg-new'), 'utf8'), 'v2');
    assert.equal(fs.readFileSync(path.join(tmpWs, 'file3.md'), 'utf8'), 'v2');
  } finally {
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});

test('updates .wsg/operation.json on disk if present', () => {
  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-owner-journal-'));
  try {
    initWsgDir(tmpWs);
    writeOperation(tmpWs, {
      version: 1,
      owned: {},
      operation: {
        id: 'op-123',
        command: 'create',
        status: 'running',
        startedAt: new Date().toISOString(),
        steps: [],
      },
    });

    const files = [
      { path: 'docs/context.md', content: '# Context' },
      { path: 'AGENTS.md', content: '# Agents' },
    ];

    const result = reconcileGenerated(tmpWs, files);

    assert.equal(result.partial, false);
    assert.equal(result.written.length, 2);

    // Check operation.json updated on disk
    const op = readOperation(tmpWs);
    assert.ok(op);
    assert.ok(op.owned['docs/context.md']);
    assert.ok(op.owned['AGENTS.md']);
    assert.equal(op.owned['docs/context.md'].sha256, sha256('# Context'));
    assert.equal(op.owned['AGENTS.md'].sha256, sha256('# Agents'));
  } finally {
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});

test('reconcileGenerated rejects non-confined relative paths', () => {
  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-owner-sec-'));
  try {
    assert.throws(
      () => reconcileGenerated(tmpWs, { '../escape.txt': 'evil' }),
      (err: unknown) => {
        assert.ok(err instanceof UsageError);
        assert.match(err.message, /path traversal/);
        return true;
      }
    );
  } finally {
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});
