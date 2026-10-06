/**
 * Result serialization for the non-interactive (headless) CLI surface.
 *
 * The versioned JSON contract is defined here, in one place, so every headless
 * caller (JSON or human-readable) renders the same typed `WorkflowResult`. The
 * JSON shape follows FR8 of the approved spec:
 *
 *   { "version": 1, "status": "created" | "planned" | "needs_input" | "failed", ... }
 *
 * - `created`/`planned` carry the workspace name and path (plus a plan summary
 *   for `planned`). `created.partial` marks reconciliation output (exit 3).
 * - `needs_input` carries the concise reason and bounded actionable questions.
 * - `failed` carries a safe error code/message and hints.
 *
 * Nothing here serializes raw repository contents, credentials, or scout
 * state; plan summaries are contents-free by construction.
 *
 * Stdout is reserved for the single JSON document. Human diagnostics and
 * progress always go to stderr.
 */

import type {
  ActionableQuestion,
  PlanSummary,
  PlanSummaryDoc,
  PlanSummaryRepo,
  WorkflowEvent,
  WorkflowResult,
} from './workflow.ts';

/** Current JSON result schema version. Bump only for breaking shape changes. */
export const RESULT_SCHEMA_VERSION = 1;

/** Exit code reserved for `needs_input`, distinct from existing 1/2/3 codes. */
export const NEEDS_INPUT_EXIT_CODE = 4;

export interface OutputWriteStream {
  write: (chunk: string | Uint8Array) => boolean | void;
}

export interface OutputIO {
  stdout?: OutputWriteStream;
  stderr?: OutputWriteStream;
}

function serializeQuestion(question: ActionableQuestion): Record<string, unknown> {
  return {
    id: question.id,
    question: question.question,
    ...(question.candidates && question.candidates.length > 0
      ? { candidates: [...question.candidates] }
      : {}),
  };
}

function serializeRepo(repo: PlanSummaryRepo): Record<string, unknown> {
  return {
    name: repo.name,
    source: repo.source,
    dest: repo.dest,
    branch: repo.branch,
    intent: repo.intent,
    added_by: repo.added_by,
  };
}

function serializeDoc(doc: PlanSummaryDoc): Record<string, unknown> {
  return {
    source: doc.source,
    ...(doc.path ? { path: doc.path } : {}),
    mode: doc.mode,
    added_by: doc.added_by,
  };
}

/** Serializes a validated plan into a contents-free JSON-safe summary. */
export function serializePlan(plan: PlanSummary): Record<string, unknown> {
  return {
    name: plan.name,
    wsDir: plan.wsDir,
    request: plan.request,
    adapters: [...plan.adapters],
    repos: plan.repos.map(serializeRepo),
    docs: plan.docs.map(serializeDoc),
    commands: plan.commands,
    gaps: [...plan.gaps],
  };
}

/**
 * Converts a typed workflow result into the versioned JSON object. Internal
 * fields (for example `needs_input.legacy`) are intentionally dropped.
 */
export function serializeResult(result: WorkflowResult): Record<string, unknown> {
  switch (result.status) {
    case 'created':
      return {
        version: RESULT_SCHEMA_VERSION,
        status: 'created',
        name: result.name,
        wsDir: result.wsDir,
        resumed: result.resumed,
        ...(result.partial ? { partial: true } : {}),
      };
    case 'planned':
      return {
        version: RESULT_SCHEMA_VERSION,
        status: 'planned',
        name: result.name,
        wsDir: result.wsDir,
        resumed: result.resumed,
        ...(result.plan ? { plan: serializePlan(result.plan) } : {}),
      };
    case 'needs_input':
      return {
        version: RESULT_SCHEMA_VERSION,
        status: 'needs_input',
        reason: result.reason,
        questions: result.questions.map(serializeQuestion),
      };
    case 'failed':
      return {
        version: RESULT_SCHEMA_VERSION,
        status: 'failed',
        error: {
          code: result.error.code,
          message: result.error.message,
          hints: [...result.error.hints],
          exitCode: result.error.exitCode,
        },
      };
  }
}

/**
 * Serializes a result as exactly one newline-terminated JSON document. Callers
 * must write this (and nothing else) to stdout.
 */
export function serializeResultJson(result: WorkflowResult): string {
  return `${JSON.stringify(serializeResult(result))}\n`;
}

/** Maps a typed result to its process exit code. */
export function exitCodeForResult(result: WorkflowResult): number {
  switch (result.status) {
    case 'created':
      return result.exitCode;
    case 'planned':
      return 0;
    case 'needs_input':
      return NEEDS_INPUT_EXIT_CODE;
    case 'failed':
      return result.error.exitCode;
  }
}

/** Writes the single JSON document to stdout. */
export function writeResultJson(result: WorkflowResult, io: OutputIO = {}): void {
  const stdout = io.stdout ?? process.stdout;
  stdout.write(serializeResultJson(result));
}

/**
 * Emits a bounded, single-line human progress line to stderr. Message bounding
 * is already enforced by the workflow event sink; this only formats.
 */
export function renderProgress(event: WorkflowEvent, stderr: OutputWriteStream): void {
  stderr.write(`wsg: [${event.stage}] ${event.message}\n`);
}

/**
 * Prints human diagnostics for outcomes that need them (questions for
 * `needs_input`, error plus hints for `failed`). `created`/`planned` summaries
 * are produced by the engine itself, so nothing is printed for them.
 */
export function renderResultDiagnostics(result: WorkflowResult, stderr: OutputWriteStream): void {
  if (result.status === 'needs_input') {
    stderr.write(`wsg: more information needed: ${result.reason}\n`);
    for (const question of result.questions) {
      stderr.write(`  - ${question.question}\n`);
    }
    return;
  }
  if (result.status === 'failed') {
    stderr.write(`wsg: ${result.error.message}\n`);
    for (const hint of result.error.hints) {
      stderr.write(`  ${hint}\n`);
    }
  }
}
