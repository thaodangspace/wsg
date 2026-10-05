import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import * as YAML from 'yaml';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { parseYamlStrict, type ParseYamlOptions } from './yamlio.ts';
import { UsageError } from './errors.ts';
import { assertConfinedRelative } from './paths.ts';
import { assertValidSlug, isReservedRootName } from './slug.ts';
import { checkBranchName } from './branch.ts';

export const MANIFEST_VERSION = 1;

export const IntentSchema = Type.Union([
  Type.Literal('source'),
  Type.Literal('target'),
  Type.Literal('reference'),
  Type.Literal('shared'),
  Type.Literal('unspecified'),
]);
export type Intent = Static<typeof IntentSchema>;
export const Intent = IntentSchema;

export const AddedBySchema = Type.Union([
  Type.Literal('user'),
  Type.Literal('scout'),
]);
export type AddedBy = Static<typeof AddedBySchema>;
export const AddedBy = AddedBySchema;

export const EvidenceSchema = Type.Object(
  {
    file: Type.String({ minLength: 1 }),
    lines: Type.Optional(
      Type.Tuple([
        Type.Integer({ minimum: 1 }),
        Type.Integer({ minimum: 1 }),
      ])
    ),
    summary: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false }
);
export type Evidence = {
  file: string;
  lines?: [number, number];
  summary: string;
};
export const Evidence = EvidenceSchema;

export const RepoEntrySchema = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    source: Type.String({ minLength: 1 }),
    path: Type.String({ minLength: 1 }),
    base_commit: Type.String({ minLength: 1 }),
    branch: Type.String({ minLength: 1 }),
    intent: IntentSchema,
    added_by: AddedBySchema,
    reason: Type.String(),
    evidence: Type.Optional(Type.Array(EvidenceSchema)),
  },
  { additionalProperties: false }
);
export type RepoEntry = {
  name: string;
  source: string;
  path: string;
  base_commit: string;
  branch: string;
  intent: Intent;
  added_by: AddedBy;
  reason: string;
  evidence: Evidence[];
};
export const RepoEntry = RepoEntrySchema;

export const DocModeSchema = Type.Union([
  Type.Literal('snapshot'),
  Type.Literal('reference'),
]);
export type DocMode = Static<typeof DocModeSchema>;
export const DocMode = DocModeSchema;

export const DocEntrySchema = Type.Object(
  {
    source: Type.String({ minLength: 1 }),
    path: Type.Optional(Type.String({ minLength: 1 })),
    mode: DocModeSchema,
    added_by: AddedBySchema,
    sha256: Type.Optional(Type.String({ minLength: 1 })),
    fetched_at: Type.Optional(Type.String({ minLength: 1 })),
    reason: Type.Optional(Type.String()),
  },
  { additionalProperties: false }
);
export type DocEntry = {
  source: string;
  path?: string;
  mode: DocMode;
  added_by: AddedBy;
  sha256?: string;
  fetched_at?: string;
  reason?: string;
};
export const DocEntry = DocEntrySchema;

export const ScriptEntrySchema = Type.Object(
  {
    source: Type.String({ minLength: 1 }),
    path: Type.String({ minLength: 1 }),
    sha256: Type.Optional(Type.String({ minLength: 1 })),
    added_by: Type.Optional(AddedBySchema),
    reason: Type.Optional(Type.String()),
  },
  { additionalProperties: false }
);
export type ScriptEntry = Static<typeof ScriptEntrySchema>;
export const ScriptEntry = ScriptEntrySchema;

export const CommandEntrySchema = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    cwd: Type.String({ minLength: 1 }),
    argv: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    evidence: Type.Optional(Type.String()),
    wrapper: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false }
);
export type CommandEntry = Static<typeof CommandEntrySchema>;
export const CommandEntry = CommandEntrySchema;

export const ExcludedRepoSchema = Type.Object(
  {
    source: Type.String({ minLength: 1 }),
    reason: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false }
);
export type ExcludedRepo = Static<typeof ExcludedRepoSchema>;
export const ExcludedRepo = ExcludedRepoSchema;

export const DiscoverySchema = Type.Object(
  {
    excluded: Type.Optional(Type.Array(ExcludedRepoSchema)),
    gaps: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false }
);
export interface Discovery {
  excluded: ExcludedRepo[];
  gaps: string[];
}
export const Discovery = DiscoverySchema;

export const ManifestAdapterSchema = Type.Union([
  Type.Literal('agents'),
  Type.Literal('claude'),
]);
export type ManifestAdapter = Static<typeof ManifestAdapterSchema>;

export const ManifestSchema = Type.Object(
  {
    version: Type.Literal(1),
    name: Type.String({ minLength: 1 }),
    request: Type.String(),
    context: Type.Optional(Type.Array(Type.String())),
    adapters: Type.Optional(Type.Array(ManifestAdapterSchema)),
    repos: Type.Array(RepoEntrySchema),
    docs: Type.Array(DocEntrySchema),
    scripts: Type.Optional(Type.Array(ScriptEntrySchema)),
    commands: Type.Optional(Type.Array(CommandEntrySchema)),
    discovery: Type.Optional(DiscoverySchema),
  },
  { additionalProperties: false }
);
export type ManifestRaw = Static<typeof ManifestSchema>;
export const Manifest = ManifestSchema;

export interface Manifest {
  version: 1;
  name: string;
  request: string;
  context: string[];
  adapters: ManifestAdapter[];
  repos: RepoEntry[];
  docs: DocEntry[];
  scripts: ScriptEntry[];
  commands: CommandEntry[];
  discovery: Discovery;
}

export interface ParseManifestOptions extends ParseYamlOptions {}

export function parseManifest(
  text: string,
  options: ParseManifestOptions = {}
): Manifest {
  // Version-first check before shape validation
  const doc = YAML.parseDocument(text);
  const rawData = doc.toJSON();
  if (
    rawData &&
    typeof rawData === 'object' &&
    'version' in rawData &&
    (rawData as Record<string, unknown>).version !== MANIFEST_VERSION
  ) {
    throw new UsageError(
      `Unsupported workspace.yaml version ${(rawData as Record<string, unknown>).version}`
    );
  }

  const raw = parseYamlStrict<ManifestRaw>(text, ManifestSchema, options);

  const manifest: Manifest = {
    version: MANIFEST_VERSION,
    name: raw.name,
    request: raw.request,
    context: Array.isArray(raw.context) ? raw.context : [],
    adapters: Array.isArray(raw.adapters) ? (raw.adapters as ManifestAdapter[]) : [],
    repos: (raw.repos ?? []).map((repo) => ({
      name: repo.name,
      source: repo.source,
      path: repo.path,
      base_commit: repo.base_commit,
      branch: repo.branch,
      intent: repo.intent,
      added_by: repo.added_by,
      reason: repo.reason,
      evidence: Array.isArray(repo.evidence)
        ? repo.evidence.map((ev) => ({
            file: ev.file,
            ...(ev.lines ? { lines: ev.lines } : {}),
            summary: ev.summary,
          }))
        : [],
    })),
    docs: (raw.docs ?? []).map((doc) => ({
      source: doc.source,
      ...(doc.path !== undefined ? { path: doc.path } : {}),
      mode: doc.mode,
      added_by: doc.added_by,
      ...(doc.sha256 !== undefined ? { sha256: doc.sha256 } : {}),
      ...(doc.fetched_at !== undefined ? { fetched_at: doc.fetched_at } : {}),
      ...(doc.reason !== undefined ? { reason: doc.reason } : {}),
    })),
    scripts: Array.isArray(raw.scripts)
      ? raw.scripts.map((s) => ({
          source: s.source,
          path: s.path,
          ...(s.sha256 !== undefined ? { sha256: s.sha256 } : {}),
          ...(s.added_by !== undefined ? { added_by: s.added_by } : {}),
          ...(s.reason !== undefined ? { reason: s.reason } : {}),
        }))
      : [],
    commands: Array.isArray(raw.commands)
      ? raw.commands.map((c) => ({
          name: c.name,
          cwd: c.cwd,
          argv: c.argv,
          ...(c.evidence !== undefined ? { evidence: c.evidence } : {}),
          ...(c.wrapper !== undefined ? { wrapper: c.wrapper } : {}),
        }))
      : [],
    discovery: {
      excluded: Array.isArray(raw.discovery?.excluded)
        ? raw.discovery.excluded.map((e) => ({
            source: e.source,
            reason: e.reason,
          }))
        : [],
      gaps: Array.isArray(raw.discovery?.gaps) ? raw.discovery.gaps : [],
    },
  };

  validateManifest(manifest);

  return manifest;
}

export function normalizeSourcePath(sourcePath: string): string {
  if (typeof sourcePath !== 'string' || sourcePath.length === 0) {
    throw new UsageError('repo source must not be empty');
  }
  if (!path.isAbsolute(sourcePath)) {
    throw new UsageError(`repo source '${sourcePath}' must be an absolute path`);
  }
  if (sourcePath.includes('\0')) {
    throw new UsageError(`repo source '${sourcePath}' contains NUL byte`);
  }
  try {
    return realpathSync(sourcePath);
  } catch {
    return path.resolve(sourcePath);
  }
}

function formatPath(segments: string[]): string {
  let result = '';
  for (const seg of segments) {
    if (/^\d+$/.test(seg)) {
      result += `[${seg}]`;
    } else {
      result = result ? `${result}.${seg}` : seg;
    }
  }
  return result;
}

type SchemaError = ReturnType<typeof Value.Errors> extends Iterable<infer E>
  ? E
  : never;

function formatSchemaErrors(errors: SchemaError[]): string[] {
  const formatted: string[] = [];
  for (const err of errors) {
    if (err.keyword === 'additionalProperties') {
      continue;
    }
    if (err.keyword === 'const' && err.schemaPath.includes('/anyOf/')) {
      continue;
    }
    const isUnknownKey =
      err.keyword === 'boolean' &&
      err.schemaPath.endsWith('/additionalProperties');
    const segments = err.instancePath.split('/').filter(Boolean);
    const pathStr = formatPath(segments);
    const msg = isUnknownKey
      ? `unknown key '${pathStr}'`
      : pathStr
        ? `${pathStr}: ${err.message}`
        : err.message;
    formatted.push(msg);
  }
  if (formatted.length === 0) {
    for (const err of errors) {
      formatted.push(err.message);
    }
  }
  return formatted;
}

export function validateManifest(manifest: Manifest): Manifest {
  if (
    manifest &&
    typeof manifest === 'object' &&
    'version' in manifest &&
    (manifest as unknown as Record<string, unknown>).version !== MANIFEST_VERSION
  ) {
    throw new UsageError(`Unsupported workspace.yaml version ${(manifest as unknown as Record<string, unknown>).version}`);
  }

  // Strict schema validation using TypeBox
  const rawErrors = [...Value.Errors(ManifestSchema, manifest)];
  if (rawErrors.length > 0) {
    const formatted = formatSchemaErrors(rawErrors);
    const [first, ...rest] = formatted;
    throw new UsageError(first, rest);
  }

  assertValidSlug(manifest.name, 'Workspace name');

  if (typeof manifest.request !== 'string' || manifest.request.trim().length === 0) {
    throw new UsageError('Workspace request must not be empty');
  }

  const seenRepoNames = new Set<string>();
  const seenRepoPaths = new Set<string>();
  const seenRepoSources = new Set<string>();
  const normalizedRepoEntries: Array<{ name: string; path: string; lowerPath: string }> = [];

  for (let i = 0; i < manifest.repos.length; i++) {
    const repo = manifest.repos[i];
    const repoLabel = repo.name || `repos[${i}]`;

    assertValidSlug(repo.name, `repo name`);

    const lowerName = repo.name.toLowerCase();
    if (seenRepoNames.has(lowerName)) {
      throw new UsageError(`duplicate repo name '${repo.name}'`);
    }
    seenRepoNames.add(lowerName);

    // Source must be an absolute path per spec §5
    if (!path.isAbsolute(repo.source)) {
      throw new UsageError(
        `repo '${repoLabel}' source '${repo.source}' must be an absolute path`
      );
    }
    const canonicalSource = normalizeSourcePath(repo.source);
    const lowerSource = canonicalSource.toLowerCase();
    if (seenRepoSources.has(lowerSource)) {
      throw new UsageError(`duplicate repo source '${repo.source}'`);
    }
    seenRepoSources.add(lowerSource);

    // Relative confined path validation
    assertConfinedRelative(repo.path, `repo '${repoLabel}' path`);

    // Normalize path for collision and overlap detection
    const normalizedPath = path.posix.normalize(repo.path).replace(/\/+$/, '');

    // Reserved root name or subtree check (case-insensitive)
    const firstSegment = normalizedPath.split('/')[0];
    if (isReservedRootName(firstSegment)) {
      throw new UsageError(
        `repo '${repoLabel}' path '${repo.path}' must not occupy reserved root name or subtree '${firstSegment}'`
      );
    }

    const lowerPath = normalizedPath.toLowerCase();
    if (seenRepoPaths.has(lowerPath)) {
      throw new UsageError(`duplicate repo path '${repo.path}'`);
    }
    seenRepoPaths.add(lowerPath);

    // Overlapping repo destinations check
    for (const existing of normalizedRepoEntries) {
      if (
        lowerPath.startsWith(`${existing.lowerPath}/`) ||
        existing.lowerPath.startsWith(`${lowerPath}/`)
      ) {
        throw new UsageError(
          `overlapping repo paths: repo '${repo.name}' path '${repo.path}' and repo '${existing.name}' path '${existing.path}' overlap`
        );
      }
    }
    normalizedRepoEntries.push({
      name: repo.name,
      path: repo.path,
      lowerPath,
    });

    if (!/^[0-9a-fA-F]{40}$/.test(repo.base_commit)) {
      throw new UsageError(
        `repo '${repoLabel}' base_commit '${repo.base_commit}' must be a 40-character hexadecimal git commit SHA`
      );
    }

    if (!checkBranchName(repo.branch)) {
      throw new UsageError(
        `repo '${repoLabel}' branch '${repo.branch}' is not a valid git branch name`
      );
    }

    if (typeof repo.reason !== 'string' || repo.reason.trim().length === 0) {
      throw new UsageError(`repo '${repoLabel}' reason must not be empty`);
    }

    for (let j = 0; j < (repo.evidence ?? []).length; j++) {
      const ev = repo.evidence[j];
      assertConfinedRelative(ev.file, `repo '${repoLabel}' evidence[${j}].file`);
      if (ev.lines) {
        if (ev.lines[0] > ev.lines[1]) {
          throw new UsageError(
            `repo '${repoLabel}' evidence[${j}].lines start (${ev.lines[0]}) must be <= end (${ev.lines[1]})`
          );
        }
      }
    }
  }

  const seenDocPaths = new Set<string>();

  for (let i = 0; i < manifest.docs.length; i++) {
    const doc = manifest.docs[i];
    const docLabel = doc.source || `docs[${i}]`;

    if (doc.mode === 'reference') {
      if (doc.path !== undefined && doc.path !== null && doc.path !== '') {
        throw new UsageError(
          `reference doc '${docLabel}' must not have a 'path'`
        );
      }
    } else if (doc.mode === 'snapshot') {
      if (!doc.path) {
        throw new UsageError(
          `snapshot doc '${docLabel}' must have a 'path'`
        );
      }
      assertConfinedRelative(doc.path, `snapshot doc '${docLabel}' path`);
      if (seenDocPaths.has(doc.path)) {
        throw new UsageError(`duplicate doc path '${doc.path}'`);
      }
      seenDocPaths.add(doc.path);

      if (!doc.sha256) {
        throw new UsageError(
          `snapshot doc '${docLabel}' must have a 'sha256' content hash`
        );
      }
      if (!/^[0-9a-fA-F]{64}$/.test(doc.sha256)) {
        throw new UsageError(
          `snapshot doc '${docLabel}' sha256 '${doc.sha256}' must be a 64-character hexadecimal SHA-256 hash`
        );
      }
    }
  }

  const seenScriptPaths = new Set<string>();
  for (let i = 0; i < (manifest.scripts ?? []).length; i++) {
    const script = manifest.scripts[i];
    assertConfinedRelative(script.path, `script path`);
    if (seenScriptPaths.has(script.path)) {
      throw new UsageError(`duplicate script path '${script.path}'`);
    }
    seenScriptPaths.add(script.path);

    if (script.sha256 && !/^[0-9a-fA-F]{64}$/.test(script.sha256)) {
      throw new UsageError(
        `script '${script.path}' sha256 '${script.sha256}' must be a 64-character hexadecimal SHA-256 hash`
      );
    }
  }

  const validRepoPaths = new Set(manifest.repos.map((r) => r.path));

  for (let i = 0; i < (manifest.commands ?? []).length; i++) {
    const cmd = manifest.commands[i];
    const cmdLabel = cmd.name || `commands[${i}]`;

    assertConfinedRelative(cmd.cwd, `command '${cmdLabel}' cwd`);

    if (!validRepoPaths.has(cmd.cwd)) {
      throw new UsageError(
        `command '${cmdLabel}' cwd '${cmd.cwd}' does not match any repo path in the workspace`
      );
    }

    if (cmd.wrapper) {
      assertConfinedRelative(cmd.wrapper, `command '${cmdLabel}' wrapper`);
    }
  }

  return manifest;
}

export function serializeManifest(manifest: Manifest): string {
  validateManifest(manifest);

  const doc = new YAML.Document();

  const reqText = manifest.request.endsWith('\n')
    ? manifest.request
    : `${manifest.request}\n`;
  const reqScalar = new YAML.Scalar(reqText);
  reqScalar.type = YAML.Scalar.BLOCK_LITERAL;

  const ordered: Record<string, unknown> = {
    version: manifest.version,
    name: manifest.name,
    request: reqScalar,
  };

  if (manifest.context && manifest.context.length > 0) {
    ordered.context = manifest.context;
  }

  if (manifest.adapters && manifest.adapters.length > 0) {
    ordered.adapters = manifest.adapters;
  }

  ordered.repos = manifest.repos.map((repo) => {
    const r: Record<string, unknown> = {
      name: repo.name,
      source: repo.source,
      path: repo.path,
      base_commit: repo.base_commit,
      branch: repo.branch,
      intent: repo.intent,
      added_by: repo.added_by,
      reason: repo.reason,
      evidence: (repo.evidence ?? []).map((ev) => {
        const e: Record<string, unknown> = {
          file: ev.file,
        };
        if (ev.lines !== undefined) {
          e.lines = ev.lines;
        }
        e.summary = ev.summary;
        return e;
      }),
    };
    return r;
  });

  ordered.docs = manifest.docs.map((doc) => {
    const d: Record<string, unknown> = {
      source: doc.source,
    };
    if (doc.path !== undefined) {
      d.path = doc.path;
    }
    d.mode = doc.mode;
    d.added_by = doc.added_by;
    if (doc.sha256 !== undefined) {
      d.sha256 = doc.sha256;
    }
    if (doc.fetched_at !== undefined) {
      d.fetched_at = doc.fetched_at;
    }
    if (doc.reason !== undefined) {
      d.reason = doc.reason;
    }
    return d;
  });

  if (manifest.scripts && manifest.scripts.length > 0) {
    ordered.scripts = manifest.scripts.map((s) => {
      const sc: Record<string, unknown> = {
        source: s.source,
        path: s.path,
      };
      if (s.sha256 !== undefined) {
        sc.sha256 = s.sha256;
      }
      if (s.added_by !== undefined) {
        sc.added_by = s.added_by;
      }
      if (s.reason !== undefined) {
        sc.reason = s.reason;
      }
      return sc;
    });
  } else if (manifest.scripts !== undefined) {
    ordered.scripts = [];
  }

  if (manifest.commands && manifest.commands.length > 0) {
    ordered.commands = manifest.commands.map((c) => {
      const cmd: Record<string, unknown> = {
        name: c.name,
        cwd: c.cwd,
        argv: c.argv,
      };
      if (c.evidence !== undefined) {
        cmd.evidence = c.evidence;
      }
      if (c.wrapper !== undefined) {
        cmd.wrapper = c.wrapper;
      }
      return cmd;
    });
  }

  if (
    manifest.discovery &&
    ((manifest.discovery.excluded && manifest.discovery.excluded.length > 0) ||
      (manifest.discovery.gaps && manifest.discovery.gaps.length > 0))
  ) {
    ordered.discovery = {
      excluded: (manifest.discovery.excluded ?? []).map((exc) => ({
        source: exc.source,
        reason: exc.reason,
      })),
      gaps: manifest.discovery.gaps ?? [],
    };
  }

  doc.contents = ordered as any;
  return doc.toString();
}
