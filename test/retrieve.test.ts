import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestRepo } from './helpers/git-fixture.ts';
import { enumerateRepos } from '../src/discovery.ts';
import { retrieveEvidence, extractQueryTerms } from '../src/retrieve.ts';

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('extractQueryTerms is deterministic, drops stop words, and caps output', () => {
  const terms = extractQueryTerms('Port the EMR MedicalRecord from mono to modular', ['target uses PatientModule'], [], 3);
  assert.equal(terms.length, 3);
  assert.ok(terms.includes('EMR'));
  assert.ok(terms.includes('MedicalRecord'));
  assert.ok(!terms.includes('the'));
});

test('retrieves standard files, rg matches, and local document mentions', async () => {
  const codeRoot = tmp('wsg-ret-');
  const legacy = createTestRepo({
    prefix: 'wsg-ret-legacy-',
    files: {
      'src/MedicalRecord.ts': 'export class MedicalRecord {}\n',
      'package.json': JSON.stringify({ name: 'legacy-platform' }),
    },
  });
  fs.symlinkSync(legacy.dir, path.join(codeRoot, 'legacy-platform'));

  const docDir = tmp('wsg-ret-doc-');
  const docPath = path.join(docDir, 'migration.md');
  fs.writeFileSync(docPath, '# Migration\nMove legacy-platform into the modular target.\n');

  try {
    const discovery = enumerateRepos([codeRoot]);
    const result = await retrieveEvidence(
      'port EMR MedicalRecord to modular',
      [],
      discovery.repos,
      { codeRoots: [codeRoot], suppliedDocs: [docPath] }
    );

    const corpus = result.repos.get(fs.realpathSync(legacy.dir));
    assert.ok(corpus, 'corpus for the discovered repo must exist');
    assert.ok(corpus.files.has('package.json'));
    assert.ok(corpus.matches.some((m) => m.relPath === 'src/MedicalRecord.ts'));
    assert.ok(
      result.docMentions.some((m) => m.repoName === 'legacy-platform'),
      `expected a document mention, got ${JSON.stringify(result.docMentions)}`
    );
  } finally {
    legacy.cleanup();
    fs.rmSync(codeRoot, { recursive: true, force: true });
    fs.rmSync(docDir, { recursive: true, force: true });
  }
});

test('reports an rg-unavailable gap without throwing', async () => {
  const codeRoot = tmp('wsg-ret-norg-');
  const repo = createTestRepo({ prefix: 'wsg-ret-norg-src-' });
  fs.symlinkSync(repo.dir, path.join(codeRoot, 'repo'));

  try {
    const discovery = enumerateRepos([codeRoot]);
    const result = await retrieveEvidence('some task term', [], discovery.repos, {
      codeRoots: [codeRoot],
      rgPath: 'definitely-not-ripgrep-binary',
    });
    assert.ok(
      result.gaps.some((g) => g.includes('ripgrep') || g.includes('rg')),
      `expected an rg gap, got ${JSON.stringify(result.gaps)}`
    );
  } finally {
    repo.cleanup();
    fs.rmSync(codeRoot, { recursive: true, force: true });
  }
});

test('byte and match budgets produce truncation gaps', async () => {
  const codeRoot = tmp('wsg-ret-budget-');
  const repo = createTestRepo({
    prefix: 'wsg-ret-budget-src-',
    files: {
      'big.txt': `needle ${'x'.repeat(5000)}\n`,
      'README.md': '# repo\n',
    },
  });
  fs.symlinkSync(repo.dir, path.join(codeRoot, 'repo'));

  try {
    const discovery = enumerateRepos([codeRoot]);
    const result = await retrieveEvidence('needle', [], discovery.repos, {
      codeRoots: [codeRoot],
      budget: { maxFiles: 1, maxBytes: 128, maxFileBytes: 64, maxRgMatches: 0, maxRgBytes: 16 },
    });
    assert.ok(result.gaps.length > 0, 'exhausted budgets must be reported as gaps');
    assert.ok(result.stats.filesRead <= 1);
  } finally {
    repo.cleanup();
    fs.rmSync(codeRoot, { recursive: true, force: true });
  }
});
