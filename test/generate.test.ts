import test from 'node:test';
import assert from 'node:assert/strict';
import {
  renderContext,
  renderReadme,
  renderAdapter,
  plannedGeneratedFiles,
  renderAll,
} from '../src/generate.ts';
import type { Manifest } from '../src/manifest.ts';
import { UsageError } from '../src/errors.ts';

const SAMPLE_MANIFEST: Manifest = {
  version: 1,
  name: 'billing-migration',
  request: 'Migrate Stripe billing integration to unified payment service',
  context: [
    'Billing v1 is deprecated as of Q3',
    'Ensure webhook idempotency keys are preserved',
  ],
  adapters: ['agents', 'claude'],
  repos: [
    {
      name: 'billing-api',
      source: '/Users/test/code/billing-api',
      path: 'billing-api',
      branch: 'wsg/billing-migration/billing-api',
      base_commit: '0123456789abcdef0123456789abcdef01234567',
      intent: 'source',
      added_by: 'user',
      reason: 'Contains legacy billing logic',
      evidence: [
        {
          file: 'src/stripe.ts',
          lines: [10, 45],
          summary: 'Stripe charge and customer creation logic',
        },
      ],
    },
    {
      name: 'payments-core',
      source: '/Users/test/code/payments-core',
      path: 'payments-core',
      branch: 'wsg/billing-migration/payments-core',
      base_commit: 'abcdef0123456789abcdef0123456789abcdef01',
      intent: 'target',
      added_by: 'user',
      reason: 'Destination service for unified payments',
      evidence: [],
    },
  ],
  docs: [
    {
      source: '/Users/test/docs/migration-plan.md',
      path: 'docs/migration-plan.md',
      mode: 'snapshot',
      added_by: 'user',
      sha256: 'a'.repeat(64),
      fetched_at: '2026-03-30T10:00:00.000Z',
    },
    {
      source: '/Users/test/docs/architecture.png',
      path: 'docs/architecture.png',
      mode: 'snapshot',
      added_by: 'user',
      sha256: 'b'.repeat(64),
      fetched_at: '2026-03-30T10:00:00.000Z',
    },
    {
      source: 'https://docs.stripe.com/api/payment_intents',
      mode: 'reference',
      added_by: 'user',
      reason: 'Not fetched in this version',
    },
  ],
  scripts: [],
  commands: [],
  discovery: {
    excluded: [],
    gaps: [
      'Submodule payment-protos not initialized',
      'No staging credentials for end-to-end webhook replay',
    ],
  },
};

test('context contains request, context lines, repo name/path/branch/base/intent, docs with mode and (unread), gaps, empty Commands (discovered, not verified)', () => {
  const context = renderContext(SAMPLE_MANIFEST);

  // Request & title
  assert.match(context, /# Workspace Context: billing-migration/);
  assert.match(context, /Migrate Stripe billing integration to unified payment service/);

  // Context lines
  assert.match(context, /Billing v1 is deprecated as of Q3/);
  assert.match(context, /Ensure webhook idempotency keys are preserved/);

  // Repo name/path/branch/base/intent & evidence
  assert.match(context, /### billing-api/);
  assert.match(context, /- Path: `billing-api`/);
  assert.match(context, /- Branch: `wsg\/billing-migration\/billing-api`/);
  assert.match(context, /- Base commit: `0123456789abcdef0123456789abcdef01234567`/);
  assert.match(context, /- Intent: source/);
  assert.match(context, /Stripe charge and customer creation logic/);

  assert.match(context, /### payments-core/);
  assert.match(context, /- Path: `payments-core`/);
  assert.match(context, /- Intent: target/);

  // Docs with mode and (unread)
  assert.match(context, /`docs\/migration-plan\.md` \(mode: snapshot\)/);
  // PNG is non-text, so it must have (unread)
  assert.match(context, /`docs\/architecture\.png` \(mode: snapshot\) \(unread\)/);
  // Reference doc must have (unread)
  assert.match(context, /\(mode: reference\) \(unread\) — Not fetched in this version/);

  // Gaps
  assert.match(context, /## Gaps and Unresolved Questions/);
  assert.match(context, /Submodule payment-protos not initialized/);
  assert.match(context, /No staging credentials for end-to-end webhook replay/);

  // Empty Commands (discovered, not verified)
  assert.match(context, /## Commands \(discovered, not verified\)/);
  assert.match(context, /None discovered\./);
});

test('adapter points to docs/context.md and mentions repo-local instructions', () => {
  // agents adapter
  const agentsContent = renderAdapter('agents', SAMPLE_MANIFEST);
  assert.match(agentsContent, /# Agent Instructions/);
  assert.match(agentsContent, /docs\/context\.md/);
  assert.match(agentsContent, /Repository-local instructions and workflows also apply/);

  // claude adapter
  const claudeContent = renderAdapter('claude', SAMPLE_MANIFEST);
  assert.match(claudeContent, /# Claude Instructions/);
  assert.match(claudeContent, /docs\/context\.md/);
  assert.match(claudeContent, /Repository-local instructions and workflows also apply/);
});

test('renderReadme explains how to use assembled directory with coding harness', () => {
  const readme = renderReadme(SAMPLE_MANIFEST);
  assert.match(readme, /# billing-migration/);
  assert.match(readme, /docs\/context\.md/);
  assert.match(readme, /Using with Coding Harnesses/);
  assert.match(readme, /Repository-local instructions/);
  assert.match(readme, /`billing-api\/`: source repository/);
});

test('planned file lists for agents, agents,claude, none', () => {
  // agents
  const agentsOnly = plannedGeneratedFiles('agents');
  assert.deepEqual(agentsOnly, ['docs/context.md', 'README.md', 'AGENTS.md']);

  // agents,claude
  const both = plannedGeneratedFiles('agents,claude');
  assert.deepEqual(both, ['docs/context.md', 'README.md', 'AGENTS.md', 'CLAUDE.md']);

  // array input
  const bothArr = plannedGeneratedFiles(['agents', 'claude']);
  assert.deepEqual(bothArr, ['docs/context.md', 'README.md', 'AGENTS.md', 'CLAUDE.md']);

  // none
  const none = plannedGeneratedFiles('none');
  assert.deepEqual(none, ['docs/context.md', 'README.md']);

  const noneArr = plannedGeneratedFiles(['none']);
  assert.deepEqual(noneArr, ['docs/context.md', 'README.md']);

  // from manifest
  assert.deepEqual(plannedGeneratedFiles(SAMPLE_MANIFEST), [
    'docs/context.md',
    'README.md',
    'AGENTS.md',
    'CLAUDE.md',
  ]);
});

test('renderAll renders all planned files into a Map', () => {
  const files = renderAll(SAMPLE_MANIFEST);
  assert.ok(files instanceof Map);
  assert.equal(files.size, 4);

  assert.ok(files.has('docs/context.md'));
  assert.ok(files.has('README.md'));
  assert.ok(files.has('AGENTS.md'));
  assert.ok(files.has('CLAUDE.md'));

  assert.match(files.get('docs/context.md')!, /# Workspace Context: billing-migration/);
  assert.match(files.get('README.md')!, /# billing-migration/);
  assert.match(files.get('AGENTS.md')!, /Agent Instructions/);
  assert.match(files.get('CLAUDE.md')!, /Claude Instructions/);

  // With none adapter
  const manifestNone: Manifest = {
    ...SAMPLE_MANIFEST,
    adapters: [],
  };
  const filesNone = renderAll(manifestNone);
  assert.equal(filesNone.size, 2);
  assert.ok(filesNone.has('docs/context.md'));
  assert.ok(filesNone.has('README.md'));
  assert.ok(!filesNone.has('AGENTS.md'));
  assert.ok(!filesNone.has('CLAUDE.md'));
});

test('renderAll renders command wrappers and rejects a wrapper that would overwrite a generated file', () => {
  const withWrapper: Manifest = {
    ...SAMPLE_MANIFEST,
    commands: [
      {
        name: 'test-billing-api',
        cwd: 'billing-api',
        argv: ['npm', 'run', 'test'],
        evidence: 'package.json scripts.test',
        wrapper: 'scripts/test-billing-api.sh',
      },
    ],
  };
  const files = renderAll(withWrapper);
  assert.ok(files.has('scripts/test-billing-api.sh'));
  assert.match(files.get('scripts/test-billing-api.sh')!, /^#!\/bin\/sh/);
  assert.match(files.get('scripts/test-billing-api.sh')!, /exec 'npm' 'run' 'test'/);

  // A wrapper that collides (case-insensitively) with a generated output must
  // never silently replace the canonical context.
  const collision: Manifest = {
    ...SAMPLE_MANIFEST,
    commands: [
      {
        name: 'evil',
        cwd: 'billing-api',
        argv: ['npm', 'run', 'test'],
        wrapper: 'docs/Context.md',
      },
    ],
  };
  assert.throws(
    () => renderAll(collision),
    (err: unknown) => {
      assert(err instanceof UsageError);
      assert.match(err.message, /Duplicate generated output/);
      return true;
    }
  );
});
