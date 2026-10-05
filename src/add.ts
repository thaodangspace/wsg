import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';
import { UsageError, ConflictError } from './errors.ts';
import { findWorkspaceRoot, expandHome, canonicalize, canonicalizeExistingPrefix, resolveInside } from './paths.ts';
import {
  parseManifest,
  serializeManifest,
  validateManifest,
  normalizeSourcePath,
  type Manifest,
  type DocEntry,
  type ScriptEntry,
  type RepoEntry,
  type Intent,
  type AddedBy,
  type Evidence,
} from './manifest.ts';
import {
  classifyDocInput,
  inspectDoc,
  isTextBuffer,
  allocateDocPath,
  usedDocBasenames,
  sanitizeBasename,
  type InspectedFileDoc,
} from './documents.ts';
import { suffixForSource, assignEntryNames } from './slug.ts';
import { repoInfo, branchExists, worktreeAddNewBranch, worktreeAddExisting, detectGaps } from './git.ts';
import {
  initWsgDir,
  acquireLock,
  releaseLock,
  readOperation,
  writeOperation,
  markStep,
  type LockData,
  type Step,
  type Operation,
  type OperationFile,
} from './operation.ts';
import { reconcileGenerated } from './ownership.ts';
import { renderAll } from './generate.ts';
import { writeFileAtomic, ensureDir, sha256, listBasenames } from './fsx.ts';
import { stageFile, commitStagedFile, writeWorkspaceFile } from './staging.ts';
import { faultPoint } from './faults.ts';
import {
  inspectWorktreeRecovery,
  resolveStagingDir,
  writeSnapshotProposal,
  assertSafeOperationId,
  type WorktreeRecoveryDecision,
} from './create.ts';
import { fetchUrlText, isHtmlContentType } from './remote.ts';
import type { CliIO } from './cli.ts';

export const ADD_HELP_TEXT = `Usage: wsg add <path-or-url> [options]

Attach an explicit repository, document, script, or URL reference to an existing
workspace and regenerate the affected context. Relative paths resolve against
the caller's current directory.

Options:
  --as <kind>        Force the input type: repo | doc | script | reference
  --workspace <dir>  Workspace directory (default: nearest ancestor workspace.yaml)
  --dry-run          Print the plan without mutating the workspace
  --resume           Resume an interrupted add operation
  -h, --help         Show help
`;

export type AddKind = 'repo' | 'doc' | 'script' | 'reference';

export interface AddOptions {
  inputs: string[];
  as?: AddKind;
  workspace?: string;
  dryRun?: boolean;
  resume?: boolean;
  /** Overridable fetch implementation (tests). */
  fetchImpl?: typeof fetch;
  fetchTimeoutMs?: number;
  fetchMaxBytes?: number;
  _afterLockAcquired?: (wsDir: string) => void;
  _beforeWorktreeStep?: (repo: PlannedRepo) => void;
}

export interface PlannedRepo {
  name: string;
  source: string;
  dest: string;
  branch: string;
  base_commit: string;
  dirty: boolean;
  dirtyFiles: string[];
  reason: string;
  intent: Intent;
  added_by: AddedBy;
  evidence: Evidence[];
}

export interface PlannedDocWrite {
  entry: DocEntry;
  content?: Buffer;
  text?: boolean;
}

export interface PlannedScriptWrite {
  entry: ScriptEntry;
  content: Buffer;
  text: boolean;
}

export interface AddPlan {
  repos: PlannedRepo[];
  docs: PlannedDocWrite[];
  scripts: PlannedScriptWrite[];
  noops: string[];
  warnings: string[];
}

export interface AddRecordedPlan {
  wsName: string;
  inputs: string[];
  /** Canonical identities of the inputs at plan time (realpath / trimmed URL). */
  inputIds: string[];
  as?: AddKind;
  repos: PlannedRepo[];
  docs: Array<DocEntry & { text?: boolean }>;
  scripts: Array<ScriptEntry & { text?: boolean }>;
  noops: string[];
  warnings: string[];
}

const ADD_KINDS: ReadonlySet<string> = new Set(['repo', 'doc', 'script', 'reference']);

function getCwd(io?: CliIO): string {
  if (io?.cwd) {
    return typeof io.cwd === 'function' ? io.cwd() : io.cwd;
  }
  return process.cwd();
}

function manifestPathFor(wsDir: string): string {
  return path.join(wsDir, 'workspace.yaml');
}

export function resolveInputPath(input: string, cwd: string): string {
  const expanded = expandHome(input);
  return path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
}

/** Normalizes an add input for dedupe/equality comparison. */
export function normalizeAddInput(input: string, cwd: string): string {
  if (classifyDocInput(input) === 'url') {
    return input.trim();
  }
  return canonicalizeExistingPrefix(resolveInputPath(input, cwd));
}

function sortedEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

function detectKind(input: string, cwd: string, as?: AddKind): AddKind {
  if (as) {
    if (!ADD_KINDS.has(as)) {
      throw new UsageError(`Unknown --as kind '${as}'. Allowed: repo, doc, script, reference.`);
    }
    return as;
  }
  if (classifyDocInput(input) === 'url') {
    return 'doc';
  }
  const resolved = resolveInputPath(input, cwd);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new UsageError(`Input '${input}' does not exist`);
    }
    throw new UsageError(`Cannot access input '${input}': ${(err as Error).message}`);
  }
  if (stat.isDirectory()) {
    return 'repo';
  }
  if (stat.isFile()) {
    return 'doc';
  }
  throw new UsageError(`Input '${input}' is neither a regular file nor a directory`);
}

/**
 * Deterministically allocates a `scripts/<basename>` path for a canonical
 * source, avoiding already-used basenames.
 */
export function allocateScriptPath(
  rawBasename: string,
  canonicalSource: string,
  usedLowerBasenames: Set<string>
): string {
  const safe = sanitizeBasename(rawBasename);
  const ext = path.extname(safe);
  const baseName = ext.length > 0 ? safe.slice(0, -ext.length) : safe;

  const lowerRaw = safe.toLowerCase();
  if (!usedLowerBasenames.has(lowerRaw)) {
    usedLowerBasenames.add(lowerRaw);
    return `scripts/${safe}`;
  }

  const suffix = suffixForSource(canonicalSource);
  let candidate = `${baseName}-${suffix}${ext}`;
  let counter = 1;
  while (usedLowerBasenames.has(candidate.toLowerCase())) {
    candidate = `${baseName}-${suffix}-${counter}${ext}`;
    counter++;
  }
  usedLowerBasenames.add(candidate.toLowerCase());
  return `scripts/${candidate}`;
}

function usedScriptBasenames(entries: readonly ScriptEntry[]): Set<string> {
  const used = new Set<string>();
  for (const entry of entries) {
    const base = path.posix.basename(entry.path);
    if (base) used.add(base.toLowerCase());
  }
  return used;
}

/**
 * Derives a safe, extension-bearing basename for a URL snapshot.
 */
export function deriveUrlBasename(url: string, contentType: string): string {
  let last = '';
  let host = 'page';
  try {
    const parsed = new URL(url);
    host = sanitizeBasename(parsed.hostname) || 'page';
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length > 0) {
      try {
        last = decodeURIComponent(segments[segments.length - 1]);
      } catch {
        last = segments[segments.length - 1];
      }
    }
  } catch {
    // fall through to defaults
  }
  last = sanitizeBasename(last);
  const hasExtension = /\.[A-Za-z0-9]{1,8}$/.test(last);
  if (last && hasExtension) {
    return last;
  }
  const lower = contentType.toLowerCase();
  const ext = isHtmlContentType(lower)
    ? '.html'
    : lower.includes('json')
      ? '.json'
      : lower.includes('xml')
        ? '.xml'
        : '.txt';
  return last ? `${last}${ext}` : `${host}${ext}`;
}

export function referenceEntry(source: string, reason: string, addedBy: AddedBy = 'user'): DocEntry {
  return { source, mode: 'reference', added_by: addedBy, reason };
}

function repoEntryFromPlan(repo: PlannedRepo): RepoEntry {
  return {
    name: repo.name,
    source: repo.source,
    path: repo.name,
    base_commit: repo.base_commit,
    branch: repo.branch,
    intent: repo.intent,
    added_by: repo.added_by,
    reason: repo.reason,
    evidence: repo.evidence,
  };
}

/** Used basenames on disk for a workspace subdirectory (lowercased). */
function diskBasenames(wsDir: string, sub: string): Set<string> {
  return listBasenames(path.join(wsDir, sub));
}

/**
 * Plans the attachments for `wsg add`. Performs read-only inspection and
 * bounded URL fetches; it never mutates the workspace. Duplicate canonical
 * sources (within the batch or already present in the manifest) are no-ops.
 * Destination allocation considers files already present on disk so untracked
 * user files are never chosen as a target.
 */
export async function planAdditions(
  manifest: Manifest,
  wsDir: string,
  options: AddOptions,
  io: CliIO = {}
): Promise<AddPlan> {
  const cwd = getCwd(io);
  const repos: PlannedRepo[] = [];
  const docs: PlannedDocWrite[] = [];
  const scripts: PlannedScriptWrite[] = [];
  const noops: string[] = [];
  const warnings: string[] = [];

  const seenRepoSources = new Set(manifest.repos.map((r) => normalizeSourcePath(r.source)));
  const seenDocSources = new Set(manifest.docs.map((d) => d.source));
  const seenScriptSources = new Set(manifest.scripts.map((s) => s.source));

  const usedDoc = usedDocBasenames(manifest.docs.map((d) => d.path ?? '').filter(Boolean));
  for (const name of diskBasenames(wsDir, 'docs')) usedDoc.add(name);

  const usedScript = usedScriptBasenames(manifest.scripts);
  for (const name of diskBasenames(wsDir, 'scripts')) usedScript.add(name);

  const reservedRepoNames = new Set<string>(
    manifest.repos.map((r) => r.name.toLowerCase())
  );
  for (const name of listBasenames(wsDir)) reservedRepoNames.add(name);

  const newRepoCandidates: Array<{ input: string; source: string; info: ReturnType<typeof repoInfo> }> = [];
  const pendingDocs: Array<
    | { kind: 'file'; input: string; inspected: InspectedFileDoc }
    | { kind: 'url'; input: string; url: string; forceReference: boolean }
  > = [];
  const pendingScripts: Array<{ input: string; inspected: InspectedFileDoc }> = [];

  for (const input of options.inputs) {
    const kind = detectKind(input, cwd, options.as);

    if (kind === 'repo') {
      const resolved = resolveInputPath(input, cwd);
      const info = repoInfo(resolved);
      const canonicalInput = canonicalize(resolved);
      if (canonicalInput !== info.toplevel) {
        throw new UsageError(
          `Path '${input}' is a subdirectory of git repository at '${info.toplevel}'. Please specify the repository root: --as repo ${info.toplevel}`
        );
      }
      if (seenRepoSources.has(info.toplevel)) {
        noops.push(`${info.toplevel} (repository already attached)`);
        continue;
      }
      seenRepoSources.add(info.toplevel);
      newRepoCandidates.push({ input, source: info.toplevel, info });
      continue;
    }

    if (kind === 'reference') {
      if (classifyDocInput(input) !== 'url') {
        throw new UsageError(`--as reference is only valid for http(s) URLs (received '${input}')`);
      }
      const url = input.trim();
      if (seenDocSources.has(url)) {
        noops.push(`${url} (document already attached)`);
        continue;
      }
      seenDocSources.add(url);
      pendingDocs.push({ kind: 'url', input, url, forceReference: true });
      continue;
    }

    if (kind === 'script') {
      const resolved = resolveInputPath(input, cwd);
      const inspected = inspectDoc(resolved);
      if (inspected.kind !== 'file') {
        throw new UsageError(`Script input '${input}' must be a local file`);
      }
      if (seenScriptSources.has(inspected.source)) {
        noops.push(`${inspected.source} (script already attached)`);
        continue;
      }
      if (seenDocSources.has(inspected.source)) {
        throw new UsageError(
          `File '${input}' is already attached as a document; refusing to attach it again as a script`
        );
      }
      seenScriptSources.add(inspected.source);
      pendingScripts.push({ input, inspected });
      continue;
    }

    // kind === 'doc'
    if (classifyDocInput(input) === 'url') {
      const url = input.trim();
      if (seenDocSources.has(url)) {
        noops.push(`${url} (document already attached)`);
        continue;
      }
      seenDocSources.add(url);
      pendingDocs.push({ kind: 'url', input, url, forceReference: false });
      continue;
    }

    const resolved = resolveInputPath(input, cwd);
    const inspected = inspectDoc(resolved);
    if (inspected.kind !== 'file') {
      throw new UsageError(`Document input '${input}' must be a local file`);
    }
    if (seenDocSources.has(inspected.source)) {
      noops.push(`${inspected.source} (document already attached)`);
      continue;
    }
    if (seenScriptSources.has(inspected.source)) {
      throw new UsageError(
        `File '${input}' is already attached as a script; refusing to attach it again as a document`
      );
    }
    seenDocSources.add(inspected.source);
    pendingDocs.push({ kind: 'file', input, inspected });
  }

  // Assign repo entry names deterministically, avoiding existing names, disk
  // entries, and reserved root names.
  if (newRepoCandidates.length > 0) {
    const names = assignEntryNames(
      newRepoCandidates.map((c) => c.source),
      { reservedNames: [...reservedRepoNames] }
    );
    for (const candidate of newRepoCandidates) {
      const name = names.get(candidate.source);
      if (!name) {
        throw new UsageError(`Failed to allocate a workspace entry name for '${candidate.input}'`);
      }
      const branch = `wsg/${manifest.name}/${name}`;
      repos.push({
        name,
        source: candidate.source,
        dest: path.join(wsDir, name),
        branch,
        base_commit: candidate.info.headCommit,
        dirty: candidate.info.dirty,
        dirtyFiles: candidate.info.dirtyFiles,
        reason: 'Explicit repository supplied by the user.',
        intent: 'unspecified',
        added_by: 'user',
        evidence: [],
      });
      for (const gap of detectGaps(candidate.source)) {
        warnings.push(gap);
      }
    }
  }

  // Materialize doc plans (URL fetch is bounded and never throws for network
  // failures; inaccessible/nontext URLs fall back to honest references).
  const fetchedAt = new Date().toISOString();
  for (const pending of pendingDocs) {
    if (pending.kind === 'file') {
      const relPath = allocateDocPath(pending.inspected.basename, pending.inspected.source, usedDoc);
      docs.push({
        entry: {
          source: pending.inspected.source,
          path: relPath,
          mode: 'snapshot',
          added_by: 'user',
          sha256: pending.inspected.sha256,
          fetched_at: fetchedAt,
        },
        content: pending.inspected.content,
        text: pending.inspected.text,
      });
      continue;
    }

    if (pending.forceReference) {
      docs.push({
        entry: referenceEntry(pending.url, 'Explicitly attached as a reference'),
      });
      continue;
    }

    const outcome = await fetchUrlText(pending.url, {
      fetchImpl: options.fetchImpl,
      timeoutMs: options.fetchTimeoutMs,
      maxBytes: options.fetchMaxBytes,
    });

    if (outcome.kind === 'reference') {
      docs.push({ entry: referenceEntry(pending.url, outcome.reason) });
      continue;
    }

    if (!isTextBuffer(outcome.content)) {
      docs.push({ entry: referenceEntry(pending.url, 'binary content; not snapshotted') });
      continue;
    }

    const basename = deriveUrlBasename(outcome.finalUrl || pending.url, outcome.contentType);
    const relPath = allocateDocPath(basename, pending.url, usedDoc);
    docs.push({
      entry: {
        source: pending.url,
        path: relPath,
        mode: 'snapshot',
        added_by: 'user',
        sha256: sha256(outcome.content),
        fetched_at: fetchedAt,
      },
      content: outcome.content,
      text: true,
    });
    if (outcome.truncated) {
      warnings.push(`URL '${pending.url}' was truncated at the fetch byte limit`);
    }
  }

  for (const pending of pendingScripts) {
    const relPath = allocateScriptPath(pending.inspected.basename, pending.inspected.source, usedScript);
    scripts.push({
      entry: {
        source: pending.inspected.source,
        path: relPath,
        sha256: pending.inspected.sha256,
        added_by: 'user',
        reason: 'Explicitly attached script; never executed by WSG.',
      },
      content: pending.inspected.content,
      text: pending.inspected.text,
    });
  }

  return { repos, docs, scripts, noops, warnings };
}

function buildUpdatedManifest(manifest: Manifest, plan: AddPlan): Manifest {
  return {
    version: 1,
    name: manifest.name,
    request: manifest.request,
    context: [...manifest.context],
    adapters: [...manifest.adapters],
    repos: [...manifest.repos, ...plan.repos.map(repoEntryFromPlan)],
    docs: [...manifest.docs, ...plan.docs.map((d) => d.entry)],
    scripts: [...manifest.scripts, ...plan.scripts.map((s) => s.entry)],
    commands: [...manifest.commands],
    discovery: {
      excluded: [...manifest.discovery.excluded],
      gaps: [...manifest.discovery.gaps, ...plan.warnings],
    },
  };
}

function unreadDocsFor(plan: AddPlan): Set<string> {
  const unread = new Set<string>();
  for (const doc of plan.docs) {
    if (doc.entry.path && doc.text === false) {
      unread.add(doc.entry.path);
    }
  }
  return unread;
}

/**
 * Rejects every deterministic destination conflict under the lock and before
 * any Git mutation: pre-existing branches, worktree destinations, and
 * doc/script destinations that already hold different content.
 */
export function preflightAddPlan(wsDir: string, plan: AddPlan): void {
  for (const repo of plan.repos) {
    if (branchExists(repo.source, repo.branch)) {
      throw new ConflictError(
        `Branch '${repo.branch}' already exists in repository '${repo.source}'.`,
        [
          `To inspect the existing branch: git -C "${repo.source}" log -1 "${repo.branch}"`,
          `Remove the branch if it is not part of a workspace, then retry.`,
        ]
      );
    }
    if (fs.existsSync(repo.dest)) {
      throw new ConflictError(`Worktree destination '${repo.dest}' already exists.`);
    }
  }

  for (const doc of plan.docs) {
    if (doc.entry.mode !== 'snapshot' || !doc.entry.path || !doc.content) continue;
    const finalPath = resolveInside(wsDir, doc.entry.path);
    if (!fs.existsSync(finalPath)) continue;
    if (doc.entry.sha256 && sha256(fs.readFileSync(finalPath)) === doc.entry.sha256) continue;
    throw new ConflictError(
      `Refusing to overwrite existing document '${doc.entry.path}': destination already contains different content.`,
      [`Move or rename the existing file, then retry the add.`]
    );
  }

  for (const script of plan.scripts) {
    const finalPath = resolveInside(wsDir, script.entry.path);
    if (!fs.existsSync(finalPath)) continue;
    if (script.entry.sha256 && sha256(fs.readFileSync(finalPath)) === script.entry.sha256) continue;
    throw new ConflictError(
      `Refusing to overwrite existing script '${script.entry.path}': destination already contains different content.`,
      [`Move or rename the existing file, then retry the add.`]
    );
  }
}

function planToRecorded(
  wsName: string,
  options: AddOptions,
  plan: AddPlan,
  inputIds: string[]
): AddRecordedPlan {
  return {
    wsName,
    inputs: [...options.inputs],
    inputIds: [...inputIds],
    ...(options.as ? { as: options.as } : {}),
    repos: plan.repos.map((r) => ({ ...r })),
    docs: plan.docs.map((d) => ({ ...d.entry, ...(typeof d.text === 'boolean' ? { text: d.text } : {}) })),
    scripts: plan.scripts.map((s) => ({
      ...s.entry,
      ...(typeof s.text === 'boolean' ? { text: s.text } : {}),
    })),
    noops: [...plan.noops],
    warnings: [...plan.warnings],
  };
}

export function extractAddPlan(op: Operation, fallbackName: string): AddRecordedPlan {
  const raw = (op.plan ?? {}) as Record<string, unknown>;
  const rawRepos = Array.isArray(raw.repos) ? (raw.repos as any[]) : [];
  const rawDocs = Array.isArray(raw.docs) ? (raw.docs as any[]) : [];
  const rawScripts = Array.isArray(raw.scripts) ? (raw.scripts as any[]) : [];

  return {
    wsName: (raw.wsName as string) ?? fallbackName,
    inputs: Array.isArray(raw.inputs) ? (raw.inputs as string[]) : [],
    inputIds: Array.isArray(raw.inputIds) ? (raw.inputIds as string[]) : [],
    ...(typeof raw.as === 'string' ? { as: raw.as as AddKind } : {}),
    repos: rawRepos.map((r) => ({
      name: r.name,
      source: normalizeSourcePath(r.source),
      dest: r.dest,
      branch: r.branch,
      base_commit: r.base_commit,
      dirty: r.dirty === true,
      dirtyFiles: Array.isArray(r.dirtyFiles) ? (r.dirtyFiles as string[]) : [],
      reason: r.reason ?? 'Explicit repository supplied by the user.',
      intent: (r.intent as Intent) ?? 'unspecified',
      added_by: (r.added_by as AddedBy) ?? 'user',
      evidence: Array.isArray(r.evidence) ? (r.evidence as Evidence[]) : [],
    })),
    docs: rawDocs.map((d) => ({
      source: d.source,
      ...(d.path ? { path: d.path as string } : {}),
      mode: d.mode,
      added_by: (d.added_by as AddedBy) ?? 'user',
      ...(d.sha256 ? { sha256: d.sha256 as string } : {}),
      ...(d.fetched_at ? { fetched_at: d.fetched_at as string } : {}),
      ...(d.reason ? { reason: d.reason as string } : {}),
      ...(typeof d.text === 'boolean' ? { text: d.text as boolean } : {}),
    })),
    scripts: rawScripts.map((s) => ({
      source: s.source,
      path: s.path,
      ...(s.sha256 ? { sha256: s.sha256 as string } : {}),
      ...(s.added_by ? { added_by: s.added_by as AddedBy } : {}),
      ...(s.reason ? { reason: s.reason as string } : {}),
      ...(typeof s.text === 'boolean' ? { text: s.text as boolean } : {}),
    })),
    noops: Array.isArray(raw.noops) ? (raw.noops as string[]) : [],
    warnings: Array.isArray(raw.warnings) ? (raw.warnings as string[]) : [],
  };
}

function manifestFromRecorded(manifest: Manifest, recorded: AddRecordedPlan): Manifest {
  const existingRepoSources = new Set(manifest.repos.map((r) => normalizeSourcePath(r.source)));
  const existingDocSources = new Set(manifest.docs.map((d) => d.source));
  const existingScriptSources = new Set(manifest.scripts.map((s) => s.source));

  const newRepos = recorded.repos
    .filter((r) => !existingRepoSources.has(r.source))
    .map(repoEntryFromPlan);
  const newDocs = recorded.docs
    .filter((d) => !existingDocSources.has(d.source))
    .map((d) => {
      const out: DocEntry = {
        source: d.source,
        mode: d.mode,
        added_by: d.added_by,
      };
      if (d.path !== undefined) out.path = d.path;
      if (d.sha256 !== undefined) out.sha256 = d.sha256;
      if (d.fetched_at !== undefined) out.fetched_at = d.fetched_at;
      if (d.reason !== undefined) out.reason = d.reason;
      return out;
    });
  const newScripts = recorded.scripts
    .filter((s) => !existingScriptSources.has(s.source))
    .map((s) => {
      const out: ScriptEntry = { source: s.source, path: s.path };
      if (s.sha256 !== undefined) out.sha256 = s.sha256;
      if (s.added_by !== undefined) out.added_by = s.added_by;
      if (s.reason !== undefined) out.reason = s.reason;
      return out;
    });

  return {
    version: 1,
    name: manifest.name,
    request: manifest.request,
    context: [...manifest.context],
    adapters: [...manifest.adapters],
    repos: [...manifest.repos, ...newRepos],
    docs: [...manifest.docs, ...newDocs],
    scripts: [...manifest.scripts, ...newScripts],
    commands: [...manifest.commands],
    discovery: {
      excluded: [...manifest.discovery.excluded],
      gaps: [...manifest.discovery.gaps, ...recorded.warnings],
    },
  };
}

function buildSteps(plan: AddPlan): Step[] {
  const steps: Step[] = [];
  for (const repo of plan.repos) {
    steps.push({
      id: `worktree:${repo.name}`,
      type: 'worktree',
      status: 'planned',
      detail: {
        source: repo.source,
        dest: repo.dest,
        branch: repo.branch,
        base_commit: repo.base_commit,
      },
    });
  }
  for (const doc of plan.docs) {
    if (doc.entry.mode === 'snapshot' && doc.entry.path) {
      steps.push({
        id: `snapshot:${doc.entry.path}`,
        type: 'snapshot',
        status: 'planned',
        detail: {
          source: doc.entry.source,
          dest: doc.entry.path,
          sha256: doc.entry.sha256,
          ...(typeof doc.text === 'boolean' ? { text: doc.text } : {}),
        },
      });
    }
  }
  for (const script of plan.scripts) {
    steps.push({
      id: `script:${script.entry.path}`,
      type: 'snapshot',
      status: 'planned',
      detail: {
        source: script.entry.source,
        dest: script.entry.path,
        sha256: script.entry.sha256,
        ...(typeof script.text === 'boolean' ? { text: script.text } : {}),
      },
    });
  }
  steps.push({ id: 'generate', type: 'generate', status: 'planned' });
  steps.push({ id: 'publish-manifest', type: 'publish-manifest', status: 'planned' });
  return steps;
}

function printPlan(
  writeStdout: (chunk: string) => void,
  manifest: Manifest,
  plan: AddPlan
): void {
  writeStdout(`Workspace: ${manifest.name}\n`);
  if (plan.noops.length > 0) {
    writeStdout(`Already attached (${plan.noops.length}):\n`);
    for (const item of plan.noops) {
      writeStdout(`  - ${item}\n`);
    }
  }
  if (plan.repos.length > 0) {
    writeStdout(`Repositories to add (${plan.repos.length}):\n`);
    for (const repo of plan.repos) {
      writeStdout(
        `  - ${repo.name}: ${repo.source} -> ${repo.name} (branch: ${repo.branch}, base: ${repo.base_commit.slice(0, 8)})\n`
      );
    }
  }
  if (plan.docs.length > 0) {
    writeStdout(`Documents to add (${plan.docs.length}):\n`);
    for (const doc of plan.docs) {
      if (doc.entry.mode === 'snapshot') {
        writeStdout(
          `  - ${doc.entry.path} (mode: snapshot, sha256: ${doc.entry.sha256?.slice(0, 8)}) <- ${doc.entry.source}\n`
        );
      } else {
        writeStdout(`  - ${doc.entry.source} (mode: reference) - ${doc.entry.reason}\n`);
      }
    }
  }
  if (plan.scripts.length > 0) {
    writeStdout(`Scripts to add (${plan.scripts.length}, not executed):\n`);
    for (const script of plan.scripts) {
      writeStdout(`  - ${script.entry.path} (sha256: ${script.entry.sha256?.slice(0, 8)}) <- ${script.entry.source}\n`);
    }
  }
  if (plan.warnings.length > 0) {
    writeStdout(`Warnings:\n`);
    for (const warning of plan.warnings) {
      writeStdout(`  - ${warning}\n`);
    }
  }
}

function hasAdditions(plan: AddPlan): boolean {
  return plan.repos.length > 0 || plan.docs.length > 0 || plan.scripts.length > 0;
}

function readManifestFrom(wsDir: string): Manifest {
  const manifestPath = manifestPathFor(wsDir);
  let text: string;
  try {
    text = fs.readFileSync(manifestPath, 'utf8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new UsageError(`No workspace.yaml found at '${manifestPath}'.`, [
        `Run 'wsg add --workspace <workspace-dir>' or run from inside a workspace.`,
      ]);
    }
    throw err;
  }
  return parseManifest(text, { filename: manifestPath });
}

/**
 * Applies a validated add plan while the caller already holds the writer lock.
 * Stages all recorded bytes before any Git mutation, rechecks branch/destination
 * state immediately before each mutation, and publishes workspace.yaml last.
 */
function applyAddLocked(
  wsDir: string,
  opId: string,
  baseManifest: Manifest,
  baselineManifestSha: string,
  plan: AddPlan,
  options: AddOptions,
  inputIds: string[],
  io: CliIO,
  writeStdout: (chunk: string) => void,
  writeStderr: (chunk: string) => void
): number {
  const updatedManifest = buildUpdatedManifest(baseManifest, plan);
  validateManifest(updatedManifest);

  const recordPlan = planToRecorded(baseManifest.name, options, plan, inputIds);

  const steps = buildSteps(plan);
  const op: Operation = {
    id: opId,
    command: 'add',
    status: 'running',
    startedAt: new Date().toISOString(),
    args: {
      inputs: options.inputs,
      ...(options.as ? { as: options.as } : {}),
    },
    plan: recordPlan as unknown as Record<string, unknown>,
    steps,
  };
  const previous = readOperation(wsDir);
  if (previous?.operation && previous.operation.status !== 'complete') {
    throw new ConflictError(
      `Workspace '${wsDir}' already has a running '${previous.operation.command}' operation. Use --resume to continue it.`
    );
  }
  const opFile: OperationFile = {
    version: 1,
    owned: previous?.owned ?? {},
    operation: op,
  };
  writeOperation(wsDir, opFile);
  faultPoint('after-lock', io.env);

  // Durably stage all recorded doc/script bytes BEFORE any step mutation.
  const tmpDir = resolveStagingDir(wsDir, opId);
  ensureDir(tmpDir);
  for (const doc of plan.docs) {
    if (doc.entry.mode === 'snapshot' && doc.entry.path && doc.content) {
      stageFile(tmpDir, doc.entry.path, doc.content);
    }
  }
  for (const script of plan.scripts) {
    stageFile(tmpDir, script.entry.path, script.content);
  }
  faultPoint('after-stage', io.env);

  // Commit doc/script bytes BEFORE any Git mutation so a destination conflict
  // can never leave a worktree/branch behind.
  for (const doc of plan.docs) {
    if (doc.entry.mode !== 'snapshot' || !doc.entry.path || !doc.content) continue;
    markStep(wsDir, `snapshot:${doc.entry.path}`, 'started');
    commitStagedFile(wsDir, tmpDir, doc.entry.path, doc.content);
    markStep(wsDir, `snapshot:${doc.entry.path}`, 'done');
  }
  for (const script of plan.scripts) {
    markStep(wsDir, `script:${script.entry.path}`, 'started');
    commitStagedFile(wsDir, tmpDir, script.entry.path, script.content);
    markStep(wsDir, `script:${script.entry.path}`, 'done');
  }

  // Repositories: create only new worktrees/branches, rechecking state under
  // the lock immediately before mutation.
  for (const repo of plan.repos) {
    if (options._beforeWorktreeStep) {
      options._beforeWorktreeStep(repo);
    }

    const branchAppeared = branchExists(repo.source, repo.branch);
    const destAppeared = fs.existsSync(repo.dest);
    if (branchAppeared || destAppeared) {
      throw new ConflictError(
        branchAppeared
          ? `Branch '${repo.branch}' appeared in repository '${repo.source}' after preflight; refusing to mutate.`
          : `Worktree destination '${repo.dest}' appeared after preflight; refusing to mutate.`,
        ['Re-run wsg add once the conflicting state is resolved.']
      );
    }

    markStep(wsDir, `worktree:${repo.name}`, 'started', {
      detail: {
        source: repo.source,
        dest: repo.dest,
        branch: repo.branch,
        base_commit: repo.base_commit,
        branchExistedBefore: false,
        destExistedBefore: false,
      },
    });
    worktreeAddNewBranch(repo.source, repo.branch, repo.dest, repo.base_commit);
    faultPoint('after-worktree', io.env);
    markStep(wsDir, `worktree:${repo.name}`, 'done');
  }

  // Regenerate context/adapters/README under ownership rules.
  markStep(wsDir, 'generate', 'started');
  const generatedFiles = renderAll(updatedManifest, { unreadDocs: unreadDocsFor(plan) });
  const journal = readOperation(wsDir);
  const reconcileResult = reconcileGenerated(wsDir, generatedFiles, journal?.owned ?? {});
  markStep(wsDir, 'generate', 'done');
  faultPoint('after-generate', io.env);

  // Refuse to publish over a manifest that changed since we planned (e.g. a
  // hand edit during a slow fetch).
  const currentManifestSha = sha256(fs.readFileSync(manifestPathFor(wsDir)));
  if (currentManifestSha !== baselineManifestSha) {
    throw new ConflictError(
      `workspace.yaml changed while the add was running; refusing to overwrite it.`,
      ['Re-run wsg add to plan against the current manifest.']
    );
  }

  // Publish manifest last.
  markStep(wsDir, 'publish-manifest', 'started');
  writeFileAtomic(manifestPathFor(wsDir), serializeManifest(updatedManifest));
  markStep(wsDir, 'publish-manifest', 'done');

  const finished = readOperation(wsDir);
  if (finished?.operation) {
    finished.operation.status = 'complete';
    finished.operation.completedAt = new Date().toISOString();
    writeOperation(wsDir, finished);
  }
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }

  writeStdout(`\nAttached to workspace ${baseManifest.name} at ${wsDir}\n`);
  if (reconcileResult.partial || reconcileResult.proposals.length > 0) {
    writeStdout(
      `Note: Some generated files required reconciliation; preserved edits and wrote .wsg-new proposals.\n`
    );
    return 3;
  }
  return 0;
}

async function executeAddResume(
  wsDir: string,
  options: AddOptions,
  io: CliIO,
  writeStdout: (chunk: string) => void,
  writeStderr: (chunk: string) => void
): Promise<number> {
  const cwd = getCwd(io);

  initWsgDir(wsDir);
  const lock = acquireLock(wsDir, {
    onWarning: (msg) => writeStderr(`${msg}\n`),
  });
  let lockData: LockData | undefined = lock;

  try {
    // Re-read and revalidate the operation identity under the lock.
    const opFile = readOperation(wsDir);
    if (!opFile?.operation) {
      throw new ConflictError(`Workspace '${wsDir}' does not contain an operation journal. Cannot resume.`);
    }
    const op = opFile.operation;
    if (op.command !== 'add') {
      throw new ConflictError(
        `Operation journal in '${wsDir}' is for command '${op.command}', not 'add'. Cannot resume.`
      );
    }
    if (op.status === 'complete') {
      throw new ConflictError(`Add operation in '${wsDir}' is already marked complete.`);
    }
    assertSafeOperationId(op.id);

    const recorded = extractAddPlan(op, path.basename(wsDir));

    // Compare supplied canonical identities (resolved against THIS cwd) with the
    // canonical identities recorded at plan time. A relative spelling that names
    // a different source is rejected.
    const suppliedIds = options.inputs.map((i) => normalizeAddInput(i, cwd));
    if (recorded.inputIds.length === 0) {
      throw new ConflictError(
        `Interrupted add operation in '${wsDir}' has no recorded input identities; start a new add.`
      );
    }
    if (!sortedEqual(suppliedIds, recorded.inputIds) || options.as !== recorded.as) {
      throw new ConflictError('Supplied add inputs do not match the interrupted operation.', [
        `Recorded: ${recorded.inputIds.join(', ')}`,
        `Supplied: ${suppliedIds.join(', ')}`,
      ]);
    }

    const baseManifest = readManifestFrom(wsDir);
    const updatedManifest = manifestFromRecorded(baseManifest, recorded);
    validateManifest(updatedManifest);

    const tmpDir = resolveStagingDir(wsDir, op.id);

    const stagedBytes = (relPath: string): Buffer | null => {
      let stagingPath: string;
      try {
        stagingPath = resolveInside(tmpDir, relPath);
      } catch {
        return null;
      }
      try {
        if (!fs.existsSync(stagingPath)) return null;
        return fs.readFileSync(stagingPath);
      } catch {
        return null;
      }
    };

    const sourceBytes = async (source: string): Promise<Buffer | null> => {
      if (classifyDocInput(source) === 'url') {
        const outcome = await fetchUrlText(source, {
          fetchImpl: options.fetchImpl,
          timeoutMs: options.fetchTimeoutMs,
          maxBytes: options.fetchMaxBytes,
        });
        return outcome.kind === 'text' ? outcome.content : null;
      }
      try {
        return fs.readFileSync(source);
      } catch {
        return null;
      }
    };

    // Preflight worktree recovery for every recorded repo before mutation.
    const decisions: WorktreeRecoveryDecision[] = [];
    for (const repo of recorded.repos) {
      const step = op.steps.find((s) => s.id === `worktree:${repo.name}`) ?? {
        id: `worktree:${repo.name}`,
        type: 'worktree',
        status: 'planned',
        detail: {
          source: repo.source,
          dest: repo.dest,
          branch: repo.branch,
          base_commit: repo.base_commit,
        },
      };
      decisions.push(inspectWorktreeRecovery(step, repo));
    }

    // Preflight snapshot/script recovery. Target-first intact checks mean an
    // already-written snapshot/script is adopted even if its source is gone.
    type Recovery =
      | { kind: 'intact'; relPath: string; stepId: string }
      | { kind: 'restore'; relPath: string; stepId: string; content: Buffer }
      | { kind: 'proposal'; relPath: string; stepId: string; content: Buffer };
    const recoveries: Recovery[] = [];
    let partial = false;

    const resolveRecordedBytes = async (
      relPath: string,
      source: string,
      sha: string | undefined,
      label: string
    ): Promise<Buffer> => {
      const fromStage = stagedBytes(relPath);
      if (fromStage && sha && sha256(fromStage) === sha) {
        return fromStage;
      }
      const fromSource = await sourceBytes(source);
      if (fromSource && sha && sha256(fromSource) === sha) {
        return fromSource;
      }
      throw new ConflictError(
        `Cannot reproduce recorded ${label} '${relPath}' from staged bytes or source '${source}'; refusing to resume add.`,
        [
          `Expected recorded sha256 ${sha ?? '(missing)'}.`,
          `Restore the original source or start a new attachment.`,
        ]
      );
    };

    for (const doc of recorded.docs) {
      if (doc.mode !== 'snapshot' || !doc.path) continue;
      const relPath = doc.path;
      const stepId = `snapshot:${relPath}`;
      const finalPath = resolveInside(wsDir, relPath);
      const exists = fs.existsSync(finalPath);
      if (exists && doc.sha256 && sha256(fs.readFileSync(finalPath)) === doc.sha256) {
        recoveries.push({ kind: 'intact', relPath, stepId });
        continue;
      }
      const content = await resolveRecordedBytes(relPath, doc.source, doc.sha256, 'snapshot');
      if (exists) {
        recoveries.push({ kind: 'proposal', relPath, stepId, content });
        partial = true;
      } else {
        recoveries.push({ kind: 'restore', relPath, stepId, content });
      }
    }

    for (const script of recorded.scripts) {
      const relPath = script.path;
      const stepId = `script:${relPath}`;
      const finalPath = resolveInside(wsDir, relPath);
      const exists = fs.existsSync(finalPath);
      if (exists && script.sha256 && sha256(fs.readFileSync(finalPath)) === script.sha256) {
        recoveries.push({ kind: 'intact', relPath, stepId });
        continue;
      }
      const content = await resolveRecordedBytes(relPath, script.source, script.sha256, 'script');
      if (exists) {
        recoveries.push({ kind: 'proposal', relPath, stepId, content });
        partial = true;
      } else {
        recoveries.push({ kind: 'restore', relPath, stepId, content });
      }
    }

    ensureDir(tmpDir);

    for (const decision of decisions) {
      if (decision.action === 'adopt') {
        markStep(wsDir, decision.stepId, 'done', { detail: { recovered: 'adopt' } });
      } else if (decision.action === 'worktreeAddExisting') {
        markStep(wsDir, decision.stepId, 'started');
        worktreeAddExisting(decision.source, decision.branch, decision.dest);
        faultPoint('after-worktree', io.env);
        markStep(wsDir, decision.stepId, 'done', { detail: { recovered: 'worktreeAddExisting' } });
      } else {
        markStep(wsDir, decision.stepId, 'started', {
          detail: { branchExistedBefore: false, destExistedBefore: false },
        });
        worktreeAddNewBranch(decision.source, decision.branch, decision.dest, decision.base_commit);
        faultPoint('after-worktree', io.env);
        markStep(wsDir, decision.stepId, 'done', { detail: { recovered: 'retry' } });
      }
    }

    for (const rec of recoveries) {
      if (rec.kind === 'intact') {
        markStep(wsDir, rec.stepId, 'done', { detail: { recovered: 'intact' } });
      } else if (rec.kind === 'restore') {
        markStep(wsDir, rec.stepId, 'started');
        writeWorkspaceFile(wsDir, tmpDir, rec.relPath, rec.content);
        markStep(wsDir, rec.stepId, 'done', { detail: { recovered: 'restore' } });
      } else {
        markStep(wsDir, rec.stepId, 'done', { detail: { recovered: 'edited-proposal' } });
        writeSnapshotProposal(wsDir, rec.relPath, rec.content);
      }
    }

    markStep(wsDir, 'generate', 'started');
    const unread = new Set<string>();
    for (const doc of recorded.docs) {
      if (doc.path && doc.text === false) unread.add(doc.path);
    }
    const generatedFiles = renderAll(updatedManifest, { unreadDocs: unread });
    const journal = readOperation(wsDir);
    const reconcileResult = reconcileGenerated(wsDir, generatedFiles, journal?.owned ?? {});
    markStep(wsDir, 'generate', 'done');
    faultPoint('after-generate', io.env);

    markStep(wsDir, 'publish-manifest', 'started');
    writeFileAtomic(manifestPathFor(wsDir), serializeManifest(updatedManifest));
    markStep(wsDir, 'publish-manifest', 'done');

    const finished = readOperation(wsDir);
    if (finished?.operation) {
      finished.operation.status = 'complete';
      finished.operation.completedAt = new Date().toISOString();
      writeOperation(wsDir, finished);
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }

    writeStdout(`\nResumed add for workspace ${baseManifest.name} at ${wsDir}\n`);
    if (partial || reconcileResult.partial || reconcileResult.proposals.length > 0) {
      writeStdout(
        `Note: Some files required reconciliation; preserved edits and wrote .wsg-new proposals.\n`
      );
      return 3;
    }
    return 0;
  } finally {
    if (lockData) {
      try {
        releaseLock(wsDir, lockData);
      } catch {
        // ignore
      }
      lockData = undefined;
    }
  }
}

/**
 * Public entry point for `wsg add`. Accepts either AddOptions or string[] args.
 */
export async function runAdd(
  optionsOrArgs: AddOptions | string[],
  io: CliIO = {}
): Promise<number> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const writeStdout = (chunk: string) => stdout.write(chunk);
  const writeStderr = (chunk: string) => stderr.write(chunk);

  let options: AddOptions;

  if (Array.isArray(optionsOrArgs)) {
    const { values, positionals } = parseArgs({
      args: optionsOrArgs,
      options: {
        as: { type: 'string' },
        workspace: { type: 'string' },
        'dry-run': { type: 'boolean' },
        resume: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: true,
      strict: true,
    });

    if (values.help) {
      writeStdout(ADD_HELP_TEXT);
      return 0;
    }

    if (positionals.length === 0) {
      throw new UsageError('add requires at least one path or URL: wsg add <path-or-url>');
    }

    if (values.as !== undefined && !ADD_KINDS.has(values.as)) {
      throw new UsageError(`Unknown --as kind '${values.as}'. Allowed: repo, doc, script, reference.`);
    }

    options = {
      inputs: positionals,
      ...(values.as ? { as: values.as as AddKind } : {}),
      workspace: values.workspace,
      dryRun: values['dry-run'],
      resume: values.resume,
    };
  } else {
    options = optionsOrArgs;
    if (options.as !== undefined && !ADD_KINDS.has(options.as)) {
      throw new UsageError(`Unknown --as kind '${options.as}'. Allowed: repo, doc, script, reference.`);
    }
  }

  const cwd = getCwd(io);
  let explicitWorkspace = options.workspace;
  if (
    explicitWorkspace !== undefined &&
    !path.isAbsolute(explicitWorkspace) &&
    !explicitWorkspace.startsWith('~')
  ) {
    explicitWorkspace = path.resolve(cwd, explicitWorkspace);
  }
  const wsDir = findWorkspaceRoot({ startDir: cwd, workspace: explicitWorkspace });
  if (!wsDir) {
    throw new UsageError(
      `No workspace.yaml found in '${cwd}' or any parent directory.`,
      [`Run 'wsg add --workspace <workspace-dir>' or run from inside a workspace.`]
    );
  }

  if (options.resume) {
    return await executeAddResume(wsDir, options, io, writeStdout, writeStderr);
  }

  // Dry run: read-only planning, no lock, no mutation.
  if (options.dryRun) {
    const manifest = readManifestFrom(wsDir);
    const plan = await planAdditions(manifest, wsDir, options, io);
    if (plan.warnings.length > 0) {
      for (const warning of plan.warnings) writeStderr(`wsg: warning: ${warning}\n`);
    }
    printPlan(writeStdout, manifest, plan);
    if (!hasAdditions(plan)) {
      writeStdout(`\nNothing to add; all inputs are already attached to '${manifest.name}'.\n`);
      return 0;
    }
    validateManifest(buildUpdatedManifest(manifest, plan));
    preflightAddPlan(wsDir, plan);
    return 0;
  }

  // Real run: acquire the writer lock BEFORE reading the manifest and planning
  // so a concurrent writer can never be silently dropped.
  initWsgDir(wsDir);
  const opId = crypto.randomUUID();
  const lock = acquireLock(wsDir, {
    opId,
    onWarning: (msg) => writeStderr(`${msg}\n`),
  });
  let lockData: LockData | undefined = lock;

  try {
    if (options._afterLockAcquired) {
      options._afterLockAcquired(wsDir);
    }

    const existing = readOperation(wsDir);
    if (existing?.operation && existing.operation.status !== 'complete') {
      throw new ConflictError(
        `Workspace '${wsDir}' has an incomplete '${existing.operation.command}' operation. Use --resume to continue it.`
      );
    }

    const manifest = readManifestFrom(wsDir);
    const baselineManifestSha = sha256(fs.readFileSync(manifestPathFor(wsDir)));

    const plan = await planAdditions(manifest, wsDir, options, io);

    if (plan.warnings.length > 0) {
      for (const warning of plan.warnings) writeStderr(`wsg: warning: ${warning}\n`);
    }
    printPlan(writeStdout, manifest, plan);

    if (!hasAdditions(plan)) {
      writeStdout(`\nNothing to add; all inputs are already attached to '${manifest.name}'.\n`);
      return 0;
    }

    validateManifest(buildUpdatedManifest(manifest, plan));
    preflightAddPlan(wsDir, plan);

    const inputIds = options.inputs.map((i) => normalizeAddInput(i, cwd));
    return applyAddLocked(
      wsDir,
      opId,
      manifest,
      baselineManifestSha,
      plan,
      options,
      inputIds,
      io,
      writeStdout,
      writeStderr
    );
  } finally {
    if (lockData) {
      try {
        releaseLock(wsDir, lockData);
      } catch {
        // ignore
      }
      lockData = undefined;
    }
  }
}
