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
import { applyWrapperModes } from './commands.ts';
import { writeFileAtomic, ensureDir, sha256, listBasenames } from './fsx.ts';
import { writeWorkspaceFile } from './staging.ts';
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

export interface RefreshSourceData {
  doc: DocEntry;
  /** Successfully read/fetched snapshot bytes. */
  content?: Buffer;
  truncated?: boolean;
  /** Reason a snapshot source could not be read/fetched. */
  failure?: string;
  /** A readable reference that can be upgraded to a snapshot. */
  upgrade?: { content: Buffer; contentType: string; truncated: boolean; finalUrl: string };
  /** A local reference that is intentionally left as-is. */
  localReference?: boolean;
}

export interface RefreshPlan {
  selected: DocEntry[];
  sources: RefreshSourceData[];
  warnings: string[];
}

export interface PlannedRefreshWrite {
  relPath: string;
  content: Buffer;
  expectedPriorSha?: string;
}

export interface RefreshDecision {
  updatedManifest: Manifest;
  results: RefreshEntryResult[];
  writes: PlannedRefreshWrite[];
  proposals: Array<{ relPath: string; content: Buffer }>;
  partial: boolean;
  warnings: string[];
}

function getCwd(io?: CliIO): string {
  if (io?.cwd) {
    return typeof io.cwd === 'function' ? io.cwd() : io.cwd;
  }
  return process.cwd();
}

function manifestPathFor(wsDir: string): string {
  return path.join(wsDir, 'workspace.yaml');
}

function readManifestFrom(wsDir: string): Manifest {
  const manifestPath = manifestPathFor(wsDir);
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

/**
 * Read phase for `wsg refresh`: selects documents and gathers fresh source
 * bytes. Performs no writes. A failed local read or URL fetch is recorded as a
 * failure so the apply phase can retain the last snapshot and report partial.
 */
export async function planRefresh(
  manifest: Manifest,
  _wsDir: string,
  options: RefreshOptions,
  io: CliIO = {}
): Promise<RefreshPlan> {
  const cwd = getCwd(io);
  const selectors = options.selectors ?? [];
  const selected = selectDocs(manifest, selectors, cwd);
  const selectedSources = new Set(selected.map((d) => d.source));

  const sources: RefreshSourceData[] = [];
  const warnings: string[] = [];

  for (const doc of manifest.docs) {
    if (!selectedSources.has(doc.source)) continue;
    const isUrl = classifyDocInput(doc.source) === 'url';

    if (doc.mode === 'snapshot' && doc.path) {
      if (isUrl) {
        const outcome = await fetchUrlText(doc.source, {
          fetchImpl: options.fetchImpl,
          timeoutMs: options.fetchTimeoutMs,
          maxBytes: options.fetchMaxBytes,
        });
        if (outcome.kind === 'reference') {
          sources.push({ doc, failure: `fetch failed (${outcome.reason})` });
          continue;
        }
        if (!isTextBuffer(outcome.content)) {
          sources.push({ doc, failure: 'fetched binary content' });
          continue;
        }
        if (outcome.truncated) {
          warnings.push(`URL '${doc.source}' was truncated at the fetch byte limit`);
        }
        sources.push({ doc, content: outcome.content, truncated: outcome.truncated });
        continue;
      }

      const inspected = readLocalSnapshotSource(doc);
      if (inspected instanceof Error) {
        sources.push({ doc, failure: `source unreadable (${inspected.message})` });
        continue;
      }
      sources.push({ doc, content: inspected.content });
      continue;
    }

    // Reference doc.
    if (!isUrl) {
      sources.push({ doc, localReference: true });
      continue;
    }

    const outcome = await fetchUrlText(doc.source, {
      fetchImpl: options.fetchImpl,
      timeoutMs: options.fetchTimeoutMs,
      maxBytes: options.fetchMaxBytes,
    });
    if (outcome.kind === 'reference') {
      sources.push({ doc, failure: `fetch failed (${outcome.reason})` });
      continue;
    }
    if (!isTextBuffer(outcome.content)) {
      sources.push({ doc, failure: 'fetched binary content' });
      continue;
    }
    if (outcome.truncated) {
      warnings.push(`URL '${doc.source}' was truncated at the fetch byte limit`);
    }
    sources.push({
      doc,
      upgrade: {
        content: outcome.content,
        contentType: outcome.contentType,
        truncated: outcome.truncated,
        finalUrl: outcome.finalUrl || doc.source,
      },
    });
  }

  return { selected, sources, warnings };
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
 * Decision phase for `wsg refresh`. Reads the current on-disk snapshot state
 * (immediately before the caller writes) and returns the exact writes and
 * proposals to perform. Never writes. Allocates upgraded-reference paths
 * against both the manifest and the actual filesystem so untracked user files
 * are never chosen.
 */
export function computeRefreshDecisions(
  manifest: Manifest,
  plan: RefreshPlan,
  wsDir: string
): RefreshDecision {
  const results: RefreshEntryResult[] = [];
  const writes: PlannedRefreshWrite[] = [];
  const proposals: Array<{ relPath: string; content: Buffer }> = [];
  const updatedBySource = new Map<string, DocEntry>();
  const warnings = [...plan.warnings];
  let partial = false;

  const usedDoc = usedDocBasenames(
    manifest.docs.map((d) => d.path ?? '').filter(Boolean)
  );
  for (const name of listBasenames(path.join(wsDir, 'docs'))) usedDoc.add(name);

  for (const data of plan.sources) {
    const doc = data.doc;

    if (doc.mode === 'snapshot' && doc.path) {
      if (data.content === undefined) {
        partial = true;
        results.push({
          source: doc.source,
          path: doc.path,
          outcome: 'retained',
          detail: `${data.failure ?? 'fetch failed'}; kept last snapshot`,
        });
        continue;
      }

      const decision = decideSnapshotUpdate(doc, wsDir, data.content);
      if (decision.write) {
        writes.push({
          relPath: decision.write.relPath,
          content: decision.write.content,
          ...(doc.sha256 ? { expectedPriorSha: doc.sha256 } : {}),
        });
      }
      if (decision.proposal) {
        proposals.push({ relPath: decision.proposal.relPath, content: decision.proposal.content });
        partial = true;
      }
      if (decision.newEntry) {
        updatedBySource.set(doc.source, decision.newEntry);
      }
      results.push({
        source: doc.source,
        path: doc.path,
        outcome: decision.outcome,
        detail: decision.detail,
      });
      continue;
    }

    // Reference doc.
    if (data.upgrade) {
      const basename = deriveUrlBasename(data.upgrade.finalUrl, data.upgrade.contentType);
      const relPath = allocateDocPath(basename, doc.source, usedDoc);
      const newEntry: DocEntry = {
        source: doc.source,
        path: relPath,
        mode: 'snapshot',
        added_by: doc.added_by,
        sha256: sha256(data.upgrade.content),
        fetched_at: new Date().toISOString(),
      };
      updatedBySource.set(doc.source, newEntry);
      writes.push({ relPath, content: data.upgrade.content });
      results.push({
        source: doc.source,
        path: relPath,
        outcome: 'upgraded',
        detail: 'reference upgraded to snapshot',
      });
      continue;
    }

    if (data.localReference) {
      results.push({
        source: doc.source,
        outcome: 'unchanged',
        detail: 'local reference left as-is',
      });
      continue;
    }

    // Reference fetch failed: retained; a failed requested refresh is partial.
    partial = true;
    const updated: DocEntry = data.failure
      ? { ...doc, ...(doc.reason !== data.failure ? { reason: data.failure } : {}) }
      : doc;
    if (updated !== doc) updatedBySource.set(doc.source, updated);
    results.push({
      source: doc.source,
      outcome: 'retained',
      detail: `${data.failure ?? 'fetch failed'}; kept reference`,
    });
  }

  const updatedManifest: Manifest = {
    ...manifest,
    docs: manifest.docs.map((doc) => updatedBySource.get(doc.source) ?? doc),
  };

  return { updatedManifest, results, writes, proposals, partial, warnings };
}

function printResults(writeStdout: (chunk: string) => void, decision: RefreshDecision): void {
  if (decision.results.length === 0) {
    writeStdout('No documents to refresh; regenerating workspace context.\n');
  } else {
    writeStdout(`Documents refreshed (${decision.results.length}):\n`);
    for (const result of decision.results) {
      const location = result.path ? ` ${result.path}` : '';
      writeStdout(`  - ${result.source}${location}: ${result.outcome} (${result.detail})\n`);
    }
  }
  const commands = decision.updatedManifest.commands ?? [];
  if (commands.length > 0) {
    writeStdout(`Commands discovered (${commands.length}, not executed):\n`);
    for (const cmd of commands) {
      const wrapper = cmd.wrapper ? ` -> ${cmd.wrapper}` : '';
      writeStdout(
        `  - ${cmd.name}: ${cmd.argv.join(' ')} (cwd: ${cmd.cwd})${wrapper}\n`
      );
    }
  }
  const gaps = decision.updatedManifest.discovery.gaps ?? [];
  if (gaps.length > 0) {
    writeStdout(`Gaps and unresolved questions (${gaps.length}):\n`);
    for (const gap of gaps) {
      writeStdout(`  - ${gap}\n`);
    }
  }
  for (const warning of decision.warnings) {
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

  if (options.dryRun) {
    const manifest = readManifestFrom(wsDir);
    const plan = await planRefresh(manifest, wsDir, options, io);
    const decision = computeRefreshDecisions(manifest, plan, wsDir);
    validateManifest(decision.updatedManifest);
    printResults(writeStdout, decision);
    return decision.partial ? 3 : 0;
  }

  initWsgDir(wsDir);
  const lock = acquireLock(wsDir, {
    onWarning: (msg) => writeStderr(`${msg}\n`),
  });
  let lockData: LockData | undefined = lock;

  try {
    const existing = readOperation(wsDir);
    if (existing?.operation && existing.operation.status !== 'complete') {
      throw new ConflictError(
        `Workspace '${wsDir}' has an incomplete '${existing.operation.command}' operation. Finish it with --resume before refreshing.`
      );
    }

    const manifest = readManifestFrom(wsDir);
    const baselineManifestSha = sha256(fs.readFileSync(manifestPathFor(wsDir)));

    // Fetch/read under the writer lock so no other WSG writer can change the
    // manifest or a snapshot while we plan.
    const plan = await planRefresh(manifest, wsDir, options, io);
    const decision = computeRefreshDecisions(manifest, plan, wsDir);
    validateManifest(decision.updatedManifest);
    printResults(writeStdout, decision);

    // Catch an external manifest edit made during planning (e.g. a slow URL
    // fetch) before writing any snapshot, so the conflict is side-effect-free
    // where possible. A second check after the writes still guards them.
    if (sha256(fs.readFileSync(manifestPathFor(wsDir))) !== baselineManifestSha) {
      throw new ConflictError(
        `workspace.yaml changed while the refresh was planning; refusing to overwrite it.`,
        ['Re-run wsg refresh to plan against the current manifest.']
      );
    }

    const tmpDir = resolveInside(wsDir, path.posix.join('.wsg', 'tmp', crypto.randomUUID()));
    ensureDir(tmpDir);

    for (const write of decision.writes) {
      writeWorkspaceFile(wsDir, tmpDir, write.relPath, write.content, {
        expectedPriorSha: write.expectedPriorSha,
      });
    }
    for (const proposal of decision.proposals) {
      writeSnapshotProposal(wsDir, proposal.relPath, proposal.content);
    }

    // Always regenerate context/adapters/README from the saved manifest, even
    // when there are no documents. Recompute the opaque/unread set from the
    // on-disk snapshots so a binary snapshot with a text extension keeps its
    // `(unread)` marker and Unresolved Documents entry across a refresh (the
    // manifest does not persist that per-document hint).
    const unreadDocs = new Set<string>();
    for (const doc of decision.updatedManifest.docs) {
      if (doc.mode !== 'snapshot' || !doc.path) continue;
      try {
        const finalPath = resolveInside(wsDir, doc.path);
        if (fs.existsSync(finalPath) && !isTextBuffer(fs.readFileSync(finalPath))) {
          unreadDocs.add(doc.path);
        }
      } catch {
        // Unreadable snapshot: fall back to the renderer's extension check.
      }
    }
    const generatedFiles = renderAll(decision.updatedManifest, { unreadDocs });
    const journal = readOperation(wsDir);
    const reconcileResult = reconcileGenerated(wsDir, generatedFiles, journal?.owned ?? {});
    applyWrapperModes(wsDir, generatedFiles, reconcileResult.owned);

    const currentManifestSha = sha256(fs.readFileSync(manifestPathFor(wsDir)));
    if (currentManifestSha !== baselineManifestSha) {
      throw new ConflictError(
        `workspace.yaml changed while the refresh was running; refusing to overwrite it.`,
        ['Re-run wsg refresh to plan against the current manifest.']
      );
    }

    writeFileAtomic(manifestPathFor(wsDir), serializeManifest(decision.updatedManifest));

    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }

    const partial =
      decision.partial || reconcileResult.partial || reconcileResult.proposals.length > 0;
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
