import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';
import { UsageError, ConflictError } from './errors.ts';
import { findWorkspaceRoot, expandHome, canonicalize, resolveInside } from './paths.ts';
import {
  parseManifest,
  serializeManifest,
  validateManifest,
  type Manifest,
  type DocEntry,
} from './manifest.ts';
import {
  classifyDocInput,
  inspectDoc,
  allocateDocPath,
  usedDocBasenames,
  isTextBuffer,
  type InspectedFileDoc,
} from './documents.ts';
import { fetchUrlText } from './remote.ts';
import {
  initWsgDir,
  acquireLock,
  releaseLock,
  readOperation,
  type LockData,
} from './operation.ts';
import { reconcileGenerated } from './ownership.ts';
import { renderAll } from './generate.ts';
import { writeFileAtomic, ensureDir, sha256 } from './fsx.ts';
import { deriveUrlBasename } from './add.ts';
import { writeSnapshotProposal } from './create.ts';
import type { CliIO } from './cli.ts';

export const REFRESH_HELP_TEXT = `Usage: wsg refresh [doc-path-or-url] [options]

Update selected document snapshots (or all documents when no selector is
given) and regenerate the workspace context. Repository worktrees, branches,
and Git revisions are never changed, and refresh never prunes attachments.

Options:
  --workspace <dir>  Workspace directory (default: nearest ancestor workspace.yaml)
  --dry-run          Print the plan without mutating the workspace
  -h, --help         Show help
`;

export interface RefreshOptions {
  selectors?: string[];
  workspace?: string;
  dryRun?: boolean;
  fetchImpl?: typeof fetch;
  fetchTimeoutMs?: number;
  fetchMaxBytes?: number;
}

export type RefreshOutcome =
  | 'unchanged'
  | 'updated'
  | 'restored'
  | 'upgraded'
  | 'proposed'
  | 'retained'
  | 'failed';

export interface RefreshEntryResult {
  source: string;
  path?: string;
  outcome: RefreshOutcome;
  detail: string;
}

export interface RefreshPlan {
  docs: DocEntry[];
  results: RefreshEntryResult[];
  /** Relative snapshot paths to (re)write. */
  writes: Map<string, Buffer>;
  /** Relative proposal paths to write (never clobbering existing proposals). */
  proposals: Map<string, Buffer>;
  /** Newly snapshotted docs whose bytes should be removed from disk? (never) */
  partial: boolean;
  warnings: string[];
}

function getCwd(io?: CliIO): string {
  if (io?.cwd) {
    return typeof io.cwd === 'function' ? io.cwd() : io.cwd;
  }
  return process.cwd();
}

function readManifestFrom(wsDir: string): Manifest {
  const manifestPath = path.join(wsDir, 'workspace.yaml');
  let text: string;
  try {
    text = fs.readFileSync(manifestPath, 'utf8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new UsageError(`No workspace.yaml found at '${manifestPath}'.`, [
        `Run 'wsg refresh --workspace <workspace-dir>' or run from inside a workspace.`,
      ]);
    }
    throw err;
  }
  return parseManifest(text, { filename: manifestPath });
}

function selectorMatches(doc: DocEntry, selector: string, cwd: string): boolean {
  if (doc.path && doc.path === selector) return true;
  if (doc.source === selector) return true;
  if (doc.path && path.posix.basename(doc.path) === selector) return true;

  const normalizedSelector = selector.replace(/\\/g, '/');
  if (doc.path && path.posix.basename(doc.path) === path.posix.basename(normalizedSelector)) {
    return true;
  }

  // Resolve local selectors against the caller's cwd and compare canonical
  // sources so `wsg refresh ~/docs/x.md` matches a snapshot.
  if (classifyDocInput(selector) !== 'url') {
    const expanded = expandHome(selector);
    const resolved = path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
    try {
      if (canonicalize(resolved) === doc.source) return true;
    } catch {
      // ignore
    }
  }
  return false;
}

export function selectDocs(
  manifest: Manifest,
  selectors: readonly string[],
  cwd: string
): DocEntry[] {
  if (selectors.length === 0) {
    return manifest.docs.map((d) => d);
  }
  const selected: DocEntry[] = [];
  const seen = new Set<string>();
  for (const selector of selectors) {
    const matches = manifest.docs.filter((doc) => selectorMatches(doc, selector, cwd));
    if (matches.length === 0) {
      const available = manifest.docs
        .map((d) => d.path ?? d.source)
        .join(', ');
      throw new UsageError(
        `No document matches '${selector}' in workspace '${manifest.name}'.`,
        [`Available documents: ${available || '(none)'}`]
      );
    }
    for (const doc of matches) {
      if (seen.has(doc.source)) continue;
      seen.add(doc.source);
      selected.push(doc);
    }
  }
  return selected;
}

function readLocalSnapshotSource(doc: DocEntry): InspectedFileDoc | Error {
  try {
    const inspected = inspectDoc(doc.source);
    if (inspected.kind !== 'file') {
      return new Error('source is not a local file');
    }
    return inspected;
  } catch (err: unknown) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

interface SnapshotDecision {
  outcome: RefreshOutcome;
  detail: string;
  write?: { relPath: string; content: Buffer };
  proposal?: { relPath: string; content: Buffer };
  newEntry?: DocEntry;
}

function decideSnapshotUpdate(
  doc: DocEntry,
  wsDir: string,
  sourceContent: Buffer
): SnapshotDecision {
  const relPath = doc.path as string;
  const finalPath = resolveInside(wsDir, relPath);
  const sourceHash = sha256(sourceContent);

  let diskContent: Buffer | null = null;
  if (fs.existsSync(finalPath)) {
    try {
      diskContent = fs.readFileSync(finalPath);
    } catch {
      diskContent = null;
    }
  }
  const diskHash = diskContent ? sha256(diskContent) : null;
  const recordedHash = doc.sha256;
  const now = () => new Date().toISOString();

  // Source unchanged since the last successful snapshot. A user edit is kept
  // silently; a deleted snapshot is restored from the source.
  if (recordedHash !== undefined && recordedHash === sourceHash) {
    if (diskContent === null) {
      return {
        outcome: 'restored',
        detail: 'restored missing snapshot from unchanged source',
        write: { relPath, content: sourceContent },
      };
    }
    if (diskHash === sourceHash) {
      return { outcome: 'unchanged', detail: 'snapshot already matches source' };
    }
    return {
      outcome: 'unchanged',
      detail: 'source unchanged; kept user-edited snapshot',
    };
  }

  // Source changed (or no recorded hash).
  if (diskContent !== null && diskHash === sourceHash) {
    // A previous run already copied the new bytes (e.g. after a crash).
    return {
      outcome: recordedHash === sourceHash ? 'unchanged' : 'updated',
      detail: 'snapshot already matches new source; reconciled manifest hash',
      newEntry: { ...doc, sha256: sourceHash, fetched_at: now() },
    };
  }

  // Untouched or missing snapshot: safe to apply the current source bytes.
  if (diskContent === null || diskHash === recordedHash) {
    return {
      outcome: diskContent === null ? 'restored' : 'updated',
      detail:
        diskContent === null
          ? 'restored missing snapshot from source'
          : 'source changed; snapshot updated',
      write: { relPath, content: sourceContent },
      newEntry: { ...doc, sha256: sourceHash, fetched_at: now() },
    };
  }

  // User edited the snapshot and the source also changed: never overwrite.
  return {
    outcome: 'proposed',
    detail: 'snapshot edited by user and source changed; wrote .wsg-new proposal',
    proposal: { relPath, content: sourceContent },
  };
}

/**
 * Computes a `wsg refresh` plan. Read-only: it may fetch URLs and read local
 * files, but performs no writes. A failed local read or URL fetch retains the
 * last snapshot and marks the plan partial.
 */
export async function planRefresh(
  manifest: Manifest,
  wsDir: string,
  options: RefreshOptions,
  io: CliIO = {}
): Promise<RefreshPlan> {
  const cwd = getCwd(io);
  const selectors = options.selectors ?? [];
  const selected = selectDocs(manifest, selectors, cwd);
  const selectedSources = new Set(selected.map((d) => d.source));

  const results: RefreshEntryResult[] = [];
  const writes = new Map<string, Buffer>();
  const proposals = new Map<string, Buffer>();
  const warnings: string[] = [];
  let partial = false;

  // Doc paths already used, so a reference upgraded to a snapshot avoids
  // collisions with every other document in the workspace.
  const usedDoc = usedDocBasenames(
    manifest.docs.map((d) => d.path ?? '').filter(Boolean)
  );

  const updatedBySource = new Map<string, DocEntry>();

  for (const doc of manifest.docs) {
    if (!selectedSources.has(doc.source)) continue;

    if (doc.mode === 'snapshot' && doc.path) {
      if (classifyDocInput(doc.source) === 'url') {
        const outcome = await fetchUrlText(doc.source, {
          fetchImpl: options.fetchImpl,
          timeoutMs: options.fetchTimeoutMs,
          maxBytes: options.fetchMaxBytes,
        });
        if (outcome.kind === 'reference') {
          partial = true;
          results.push({
            source: doc.source,
            path: doc.path,
            outcome: 'retained',
            detail: `fetch failed (${outcome.reason}); kept last snapshot`,
          });
          continue;
        }
        if (!isTextBuffer(outcome.content)) {
          partial = true;
          results.push({
            source: doc.source,
            path: doc.path,
            outcome: 'retained',
            detail: 'fetched binary content; kept last snapshot',
          });
          continue;
        }
        if (outcome.truncated) {
          warnings.push(`URL '${doc.source}' was truncated at the fetch byte limit`);
        }
        const decision = decideSnapshotUpdate(doc, wsDir, outcome.content);
        applyDecision(decision, doc, results, writes, proposals);
        if (decision.newEntry) updatedBySource.set(doc.source, decision.newEntry);
        if (decision.outcome === 'proposed') partial = true;
        continue;
      }

      const inspected = readLocalSnapshotSource(doc);
      if (inspected instanceof Error) {
        partial = true;
        results.push({
          source: doc.source,
          path: doc.path,
          outcome: 'retained',
          detail: `source unreadable (${inspected.message}); kept last snapshot`,
        });
        continue;
      }
      const decision = decideSnapshotUpdate(doc, wsDir, inspected.content);
      applyDecision(decision, doc, results, writes, proposals);
      if (decision.newEntry) updatedBySource.set(doc.source, decision.newEntry);
      if (decision.outcome === 'proposed') partial = true;
      continue;
    }

    // Reference doc: upgrade to a snapshot when it becomes readable text.
    if (classifyDocInput(doc.source) !== 'url') {
      results.push({
        source: doc.source,
        outcome: 'unchanged',
        detail: 'local reference left as-is',
      });
      continue;
    }

    const outcome = await fetchUrlText(doc.source, {
      fetchImpl: options.fetchImpl,
      timeoutMs: options.fetchTimeoutMs,
      maxBytes: options.fetchMaxBytes,
    });
    if (outcome.kind === 'reference') {
      const reason = outcome.reason;
      partial = true;
      results.push({
        source: doc.source,
        outcome: 'retained',
        detail: `fetch failed (${reason}); kept reference`,
      });
      if (doc.reason !== reason) {
        updatedBySource.set(doc.source, { ...doc, reason });
      }
      continue;
    }
    if (!isTextBuffer(outcome.content)) {
      partial = true;
      results.push({
        source: doc.source,
        outcome: 'retained',
        detail: 'fetched binary content; kept reference',
      });
      continue;
    }

    const basename = deriveUrlBasename(outcome.finalUrl || doc.source, outcome.contentType);
    const relPath = allocateDocPath(basename, doc.source, usedDoc);
    const newEntry: DocEntry = {
      source: doc.source,
      path: relPath,
      mode: 'snapshot',
      added_by: doc.added_by,
      sha256: sha256(outcome.content),
      fetched_at: new Date().toISOString(),
    };
    updatedBySource.set(doc.source, newEntry);
    writes.set(relPath, outcome.content);
    if (outcome.truncated) {
      warnings.push(`URL '${doc.source}' was truncated at the fetch byte limit`);
    }
    results.push({
      source: doc.source,
      path: relPath,
      outcome: 'upgraded',
      detail: 'reference upgraded to snapshot',
    });
  }

  const docs = manifest.docs.map((doc) => updatedBySource.get(doc.source) ?? doc);

  return { docs, results, writes, proposals, partial, warnings };
}

function applyDecision(
  decision: SnapshotDecision,
  doc: DocEntry,
  results: RefreshEntryResult[],
  writes: Map<string, Buffer>,
  proposals: Map<string, Buffer>
): void {
  if (decision.write) {
    writes.set(decision.write.relPath, decision.write.content);
  }
  if (decision.proposal) {
    proposals.set(decision.proposal.relPath, decision.proposal.content);
  }
  results.push({
    source: doc.source,
    path: doc.path,
    outcome: decision.outcome,
    detail: decision.detail,
  });
}

function printResults(writeStdout: (chunk: string) => void, plan: RefreshPlan): void {
  if (plan.results.length === 0) {
    writeStdout('No documents to refresh.\n');
    return;
  }
  writeStdout(`Documents refreshed (${plan.results.length}):\n`);
  for (const result of plan.results) {
    const location = result.path ? ` ${result.path}` : '';
    writeStdout(`  - ${result.source}${location}: ${result.outcome} (${result.detail})\n`);
  }
  for (const warning of plan.warnings) {
    writeStdout(`  ! ${warning}\n`);
  }
}

/**
 * Public entry point for `wsg refresh`.
 */
export async function runRefresh(
  optionsOrArgs: RefreshOptions | string[],
  io: CliIO = {}
): Promise<number> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const writeStdout = (chunk: string) => stdout.write(chunk);
  const writeStderr = (chunk: string) => stderr.write(chunk);

  let options: RefreshOptions;

  if (Array.isArray(optionsOrArgs)) {
    const { values, positionals } = parseArgs({
      args: optionsOrArgs,
      options: {
        workspace: { type: 'string' },
        'dry-run': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: true,
      strict: true,
    });
    if (values.help) {
      writeStdout(REFRESH_HELP_TEXT);
      return 0;
    }
    options = {
      selectors: positionals,
      workspace: values.workspace,
      dryRun: values['dry-run'],
    };
  } else {
    options = optionsOrArgs;
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
      [`Run 'wsg refresh --workspace <workspace-dir>' or run from inside a workspace.`]
    );
  }

  const manifest = readManifestFrom(wsDir);
  const plan = await planRefresh(manifest, wsDir, options, io);
  const updatedManifest: Manifest = { ...manifest, docs: plan.docs };
  validateManifest(updatedManifest);

  printResults(writeStdout, plan);

  if (options.dryRun) {
    return plan.partial ? 3 : 0;
  }

  if (plan.results.length === 0 && plan.writes.size === 0 && plan.proposals.size === 0) {
    // Nothing selected: still safe no-op.
    return plan.partial ? 3 : 0;
  }

  initWsgDir(wsDir);

  // Refuse to run alongside an incomplete create/add operation.
  const existing = readOperation(wsDir);
  if (existing?.operation && existing.operation.status !== 'complete') {
    throw new ConflictError(
      `Workspace '${wsDir}' has an incomplete '${existing.operation.command}' operation. Finish it with --resume before refreshing.`
    );
  }

  const lock = acquireLock(wsDir, {
    onWarning: (msg) => writeStderr(`${msg}\n`),
  });
  let lockData: LockData | undefined = lock;

  try {
    const tmpDir = resolveInside(wsDir, path.posix.join('.wsg', 'tmp', crypto.randomUUID()));
    ensureDir(tmpDir);

    for (const [relPath, content] of plan.writes) {
      writeWorkspaceFile(wsDir, tmpDir, relPath, content);
    }
    for (const [relPath, content] of plan.proposals) {
      writeSnapshotProposal(wsDir, relPath, content);
    }

    const generatedFiles = renderAll(updatedManifest);
    const journal = readOperation(wsDir);
    const reconcileResult = reconcileGenerated(wsDir, generatedFiles, journal?.owned ?? {});

    writeFileAtomic(path.join(wsDir, 'workspace.yaml'), serializeManifest(updatedManifest));

    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }

    const partial = plan.partial || reconcileResult.partial || reconcileResult.proposals.length > 0;
    writeStdout(`\nWorkspace ${manifest.name} refreshed at ${wsDir}\n`);
    if (partial) {
      writeStdout(
        `Note: Some sources could not be refreshed and/or generated files required reconciliation; prior context was retained.\n`
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

function writeWorkspaceFile(wsDir: string, tmpDir: string, relPath: string, content: Buffer): void {
  const stagingPath = resolveInside(tmpDir, relPath);
  const finalPath = resolveInside(wsDir, relPath);
  ensureDir(path.dirname(stagingPath));
  writeFileAtomic(stagingPath, content, { tmpDir });
  ensureDir(path.dirname(finalPath));
  fs.renameSync(stagingPath, finalPath);
}
