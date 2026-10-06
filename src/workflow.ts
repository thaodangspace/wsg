/**
 * Workspace-creation workflow contract and UI-free coordinator.
 *
 * This module owns the typed boundary between the read-only planning phase and
 * the mutating assembly phase, and (Phase 2) the single reusable decision and
 * event model shared by headless and interactive clients.
 *
 * Boundary rules (see the approved spec + implementation plan):
 * - `prepareCreate` runs request validation, discovery, retrieval, scouting,
 *   evidence validation, and document/command planning. It may write durable
 *   scout state under `<workspace-root>/.wsg-scout/<name>/` (an explicitly
 *   allowed planning side effect) but must not create a workspace directory,
 *   a Git worktree or branch, or publish `workspace.yaml`.
 * - `assemblePrepared` runs only on a `ready` result and performs the
 *   deterministic materialization (worktree/snapshot/generate/publish) under
 *   the existing collision, lock, resume, and dirty-evidence protections.
 * - Only actionable uncertainty becomes `needs_input`. Authentication, budget,
 *   invalid-evidence, and configuration failures remain thrown `WsgError`s and
 *   keep their existing exit classification.
 *
 * The coordinator (`runCreateWorkflow`) terminates as `created`, `planned`,
 * `needs_input`, or `failed`. It routes a clear-only unattended policy directly
 * to assembly and pauses an interactive policy at the plan for explicit
 * approval. Success is always derived from the real return values of planning
 * and assembly, never from an emitted event.
 */

import { WsgError, UsageError } from './errors.ts';
import type { CliIO } from './cli.ts';
import { assemblePrepared, executeResume, prepareCreate } from './create.ts';
import type { CreateAssembly, CreateOptions, CreatePlan, RepoPlan } from './create.ts';

// ---------------------------------------------------------------------------
// Planning / assembly boundary (Phase 1)
// ---------------------------------------------------------------------------

/** A single bounded, actionable follow-up question derived from uncertainty. */
export interface ActionableQuestion {
  /** Stable, machine-readable identifier for the question. */
  id: string;
  /** Human-facing question text. */
  question: string;
  /** Observed candidates when the uncertainty is a specific choice. */
  candidates?: string[];
}

/** Planning succeeded: a validated assembly is ready to materialize. */
export interface ReadyCreate {
  kind: 'ready';
  assembly: CreateAssembly;
  /**
   * Durable scout state directory to copy into the workspace runtime storage
   * after a successful autonomous assembly. Absent for explicit-input create.
   */
  scoutStateDir?: string;
}

/** Planning stopped on actionable uncertainty; no mutation has happened. */
export interface NeedsInput {
  kind: 'needs_input';
  /** Concise explanation of what is missing or ambiguous. */
  reason: string;
  /** Bounded set of actionable questions for the human or calling agent. */
  questions: ActionableQuestion[];
  /**
   * How the legacy `wsg create` command classified this uncertainty. Used only
   * to preserve existing exit codes and hint text while the public entry points
   * migrate to typed outcomes.
   */
  legacy: {
    classification: 'usage' | 'conflict';
    hints: string[];
  };
}

export type PrepareResult = ReadyCreate | NeedsInput;

/**
 * Options that affect deterministic assembly. Narrower than `CreateOptions` so
 * a caller can assemble a prepared plan without re-supplying the planning
 * request, and so the boundary is explicit about what assembly may consult.
 */
export type AssemblyOptions = Pick<
  CreateOptions,
  'dryRun' | '_afterLockAcquired' | '_beforeWorktreeStep' | '_beforeSnapshotWrite'
>;

// ---------------------------------------------------------------------------
// Progress events (Phase 2)
// ---------------------------------------------------------------------------

/**
 * Workflow stages reported to an injected event sink. Messages are always
 * bounded and must never contain scout credentials or observed file contents.
 */
export type WorkflowStage =
  | 'discovery'
  | 'retrieval'
  | 'scout'
  | 'validation'
  | 'plan'
  | 'assembly'
  | 'completion'
  | 'error';

export type WorkflowEventStatus = 'started' | 'progress' | 'completed' | 'failed';

export interface WorkflowEvent {
  stage: WorkflowStage;
  status: WorkflowEventStatus;
  /** Bounded, redacted human-readable summary. */
  message: string;
  /** Workspace name, when known. */
  name?: string;
  /** Workspace directory, when known. */
  wsDir?: string;
  /** Bounded count of repositories involved, when relevant. */
  repos?: number;
  /** Bounded count of documents involved, when relevant. */
  docs?: number;
}

export type EventSink = (event: WorkflowEvent) => void;

export const MAX_EVENT_MESSAGE_LENGTH = 240;

/**
 * Normalizes an event message: strips control characters/newlines and bounds
 * the length. This is the single chokepoint that keeps progress payloads small
 * and free of terminal-corrupting or multi-line repository content.
 */
export function safeEventMessage(text: string): string {
  const single = String(text)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (single.length <= MAX_EVENT_MESSAGE_LENGTH) return single;
  return `${single.slice(0, MAX_EVENT_MESSAGE_LENGTH - 1)}\u2026`;
}

/**
 * Emits a bounded event to the sink. A client sink must never be able to break
 * the workflow, so sink errors are swallowed.
 */
export function emitEvent(sink: EventSink | undefined, event: WorkflowEvent): void {
  if (!sink) return;
  try {
    sink({ ...event, message: safeEventMessage(event.message) });
  } catch {
    // A misbehaving client sink must not abort creation.
  }
}

// ---------------------------------------------------------------------------
// Plan summary and typed results
// ---------------------------------------------------------------------------

export interface PlanSummaryRepo {
  name: string;
  source: string;
  dest: string;
  branch: string;
  intent: string;
  added_by: string;
}

export interface PlanSummaryDoc {
  source: string;
  path?: string;
  mode: string;
  added_by: string;
}

export interface PlanSummary {
  name: string;
  wsDir: string;
  request: string;
  adapters: string[];
  repos: PlanSummaryRepo[];
  docs: PlanSummaryDoc[];
  commands: number;
  gaps: string[];
}

/** Builds a UI-facing, contents-free summary of a validated assembly. */
export function summarizePlan(assembly: CreateAssembly): PlanSummary {
  return {
    name: assembly.wsName,
    wsDir: assembly.wsDir,
    request: assembly.request,
    adapters: [...assembly.adapters],
    repos: assembly.repos.map((r) => ({
      name: r.name,
      source: r.source,
      dest: r.dest,
      branch: r.branch,
      intent: r.intent,
      added_by: r.added_by,
    })),
    docs: assembly.docs.map((d) => ({
      source: d.source,
      ...(d.path ? { path: d.path } : {}),
      mode: d.mode,
      added_by: d.added_by,
    })),
    commands: assembly.commands.length,
    gaps: [...assembly.gaps],
  };
}

export interface CreatedResult {
  status: 'created';
  version: 1;
  name: string;
  wsDir: string;
  /** True when the workspace came from an interrupted operation, not fresh planning. */
  resumed: boolean;
  exitCode: number;
  /** True when generated files needed reconciliation (exit 3). */
  partial: boolean;
}

export interface PlannedResult {
  status: 'planned';
  version: 1;
  name: string;
  wsDir: string;
  resumed: boolean;
  /** Present for fresh dry-run planning; absent for dry-run resume recovery. */
  plan?: PlanSummary;
  exitCode: 0;
}

export interface NeedsInputResult {
  status: 'needs_input';
  version: 1;
  reason: string;
  questions: ActionableQuestion[];
  /** Internal (not serialized): legacy create error classification. */
  legacy?: NeedsInput['legacy'];
}

export interface FailedResult {
  status: 'failed';
  version: 1;
  error: {
    /** Stable machine code: usage | conflict | partial | cancelled | internal. */
    code: string;
    /** Bounded, safe message. */
    message: string;
    hints: string[];
    /** Original exit classification (1/2/3). */
    exitCode: number;
  };
}

export type WorkflowResult = CreatedResult | PlannedResult | NeedsInputResult | FailedResult;

// ---------------------------------------------------------------------------
// Decision policy
// ---------------------------------------------------------------------------

export type ApprovalDecision = 'approve' | 'decline';

/**
 * `unattended` assembles a clear plan immediately (clear-only automation).
 * `interactive` pauses at the plan and requires an explicit approval decision.
 */
export type ApprovalPolicy =
  | { mode: 'unattended' }
  | {
      mode: 'interactive';
      approve: (plan: PlanSummary) => Promise<ApprovalDecision> | ApprovalDecision;
    };

export interface WorkflowConfig {
  /** Defaults to `{ mode: 'unattended' }`. */
  policy?: ApprovalPolicy;
  /** Injected, bounded progress sink. Optional. */
  events?: EventSink;
  /**
   * When true, a failure rethrows the original `WsgError` instead of returning
   * a `failed` result. Used by the legacy `create` command adapter so exit codes
   * and error types are preserved exactly.
   */
  throwOnFailure?: boolean;
  /**
   * Cooperative cancellation. Checked before planning and again before assembly
   * (including after interactive approval); when aborted, the workflow returns
   * `failed` with code `cancelled` and never assembles. Cancellation during
   * assembly is not attempted here: the existing lock/journal/resume safety
   * governs an interrupted operation.
   */
  signal?: AbortSignal;
}

export interface ResolvedWorkspace {
  wsName: string;
  wsDir: string;
}

// ---------------------------------------------------------------------------
// Coordinator
// ---------------------------------------------------------------------------

/**
 * Runs the shared workspace-creation workflow. Planning and assembly are the
 * same engine used by `wsg create`; this function adds typed outcomes, progress
 * events, and the approval policy. It never assembles on `needs_input`,
 * failure, or decline.
 */
export async function runCreateWorkflow(
  options: CreateOptions,
  io: CliIO = {},
  config: WorkflowConfig = {}
): Promise<WorkflowResult> {
  const sink: EventSink | undefined = config.events
    ? (event) => emitEvent(config.events, event)
    : undefined;

  if (options.resume) {
    return await runResumeWorkflow(options, io, config, sink);
  }
  return await runFreshWorkflow(options, io, config, sink);
}

async function runFreshWorkflow(
  options: CreateOptions,
  io: CliIO,
  config: WorkflowConfig,
  sink: EventSink | undefined
): Promise<WorkflowResult> {
  const policy = config.policy ?? { mode: 'unattended' };

  if (config.signal?.aborted) {
    return cancelledResult(config);
  }

  let prepared: PrepareResult;
  try {
    prepared = await prepareCreate(options, io, sink);
  } catch (err) {
    return failureResult(err, config);
  }

  if (config.signal?.aborted) {
    return cancelledResult(config);
  }

  if (prepared.kind === 'needs_input') {
    return {
      status: 'needs_input',
      version: 1,
      reason: prepared.reason,
      questions: prepared.questions,
      legacy: prepared.legacy,
    };
  }

  const plan = summarizePlan(prepared.assembly);
  emitEvent(config.events, {
    stage: 'plan',
    status: 'completed',
    message: `plan ready for ${plan.name}`,
    name: plan.name,
    wsDir: plan.wsDir,
    repos: plan.repos.length,
    docs: plan.docs.length,
  });

  if (policy.mode === 'interactive') {
    let decision: ApprovalDecision;
    try {
      decision = await policy.approve(plan);
    } catch (err) {
      return failureResult(err, config);
    }
    if (decision !== 'approve') {
      emitEvent(config.events, {
        stage: 'plan',
        status: 'failed',
        message: `plan declined for ${plan.name}; no workspace created`,
        name: plan.name,
        wsDir: plan.wsDir,
      });
      return {
        status: 'failed',
        version: 1,
        error: {
          code: 'cancelled',
          message: 'Workspace creation was declined; no workspace was created.',
          hints: [],
          exitCode: 1,
        },
      };
    }
  }

  if (config.signal?.aborted) {
    return cancelledResult(config);
  }

  try {
    const code = await assemblePrepared(prepared, options, io, sink);

    if (options.dryRun) {
      emitEvent(config.events, {
        stage: 'completion',
        status: 'completed',
        message: `dry run complete for ${plan.name}; no workspace created`,
        name: plan.name,
        wsDir: plan.wsDir,
      });
      return {
        status: 'planned',
        version: 1,
        name: plan.name,
        wsDir: plan.wsDir,
        resumed: false,
        plan,
        exitCode: 0,
      };
    }

    emitEvent(config.events, {
      stage: 'completion',
      status: 'completed',
      message: `workspace created at ${prepared.assembly.wsDir}`,
      name: prepared.assembly.wsName,
      wsDir: prepared.assembly.wsDir,
    });
    return {
      status: 'created',
      version: 1,
      name: prepared.assembly.wsName,
      wsDir: prepared.assembly.wsDir,
      resumed: false,
      exitCode: code,
      partial: code === 3,
    };
  } catch (err) {
    return failureResult(err, config);
  }
}

/**
 * Consolidates an existing user request with clarifying answers from follow-up questions.
 */
export function consolidateClarification(request: string, answer: string): string {
  const trimmed = answer.trim();
  if (!trimmed) return request;
  if (!request.trim()) return trimmed;
  return `${request.trim()}\nClarification: ${trimmed}`;
}

async function runResumeWorkflow(
  options: CreateOptions,
  io: CliIO,
  config: WorkflowConfig,
  sink: EventSink | undefined
): Promise<WorkflowResult> {
  if (config.signal?.aborted) {
    return cancelledResult(config);
  }
  let resolved: ResolvedWorkspace | undefined;
  try {
    const code = await executeResume(options, io, sink, (info) => {
      resolved = info;
    });
    const name = resolved?.wsName ?? options.name ?? '';
    const wsDir = resolved?.wsDir ?? '';

    if (options.dryRun) {
      emitEvent(config.events, {
        stage: 'completion',
        status: 'completed',
        message: 'dry run resume complete; no workspace modified',
        name,
        wsDir,
      });
      return { status: 'planned', version: 1, name, wsDir, resumed: true, exitCode: 0 };
    }

    emitEvent(config.events, {
      stage: 'completion',
      status: 'completed',
      message: `workspace resumed at ${wsDir}`,
      name,
      wsDir,
    });
    return {
      status: 'created',
      version: 1,
      name,
      wsDir,
      resumed: true,
      exitCode: code,
      partial: code === 3,
    };
  } catch (err) {
    return failureResult(err, config);
  }
}

function cancelledResult(config: WorkflowConfig): FailedResult {
  emitEvent(config.events, {
    stage: 'completion',
    status: 'failed',
    message: 'workflow cancelled; no workspace created',
  });
  if (config.throwOnFailure) {
    throw new UsageError('Workspace creation was cancelled.');
  }
  return {
    status: 'failed',
    version: 1,
    error: {
      code: 'cancelled',
      message: 'Workspace creation was cancelled; no workspace was created.',
      hints: [],
      exitCode: 1,
    },
  };
}

/**
 * Builds a safe `failed` result from a thrown value, preserving the existing
 * error classification and exit codes. Exported so the headless CLI can emit a
 * parseable JSON failure for errors thrown before the coordinator runs (for
 * example option-parsing usage errors).
 */
export function toFailedResult(err: unknown): FailedResult {
  const wsg = err instanceof WsgError ? err : undefined;
  const exitCode = wsg?.exitCode ?? 1;
  const code = wsg
    ? exitCode === 2
      ? 'conflict'
      : exitCode === 3
        ? 'partial'
        : 'usage'
    : 'internal';
  const message = err instanceof Error ? err.message : String(err);
  const hints = wsg?.hints ?? [];

  return {
    status: 'failed',
    version: 1,
    error: { code, message, hints, exitCode },
  };
}

function failureResult(err: unknown, config: WorkflowConfig): FailedResult {
  const result = toFailedResult(err);

  emitEvent(config.events, {
    stage: 'error',
    status: 'failed',
    message: `creation failed: ${result.error.message}`,
  });

  if (config.throwOnFailure) throw err;

  return result;
}

export { prepareCreate, assemblePrepared, executeResume } from './create.ts';
export type { CreateAssembly, CreateOptions, CreatePlan, RepoPlan } from './create.ts';
