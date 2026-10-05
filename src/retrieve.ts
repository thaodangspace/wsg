import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { canonicalize } from './paths.ts';
import type { DiscoveredRepo } from './discovery.ts';

export const DEFAULT_RETRIEVAL_BUDGET: RetrievalBudget = {
  maxFiles: 60,
  maxBytes: 512 * 1024,
  maxFileBytes: 64 * 1024,
  maxRgMatches: 200,
  maxRgBytes: 256 * 1024,
  rgPerFileMatches: 20,
  rgMaxFileSize: 2 * 1024 * 1024,
};

export interface RetrievalBudget {
  /** Maximum number of files read across all repositories. */
  maxFiles: number;
  /** Maximum total bytes read across all repositories. */
  maxBytes: number;
  /** Maximum bytes read from a single file. */
  maxFileBytes: number;
  /** Maximum number of ripgrep matches retained. */
  maxRgMatches: number;
  /** Maximum bytes of ripgrep stdout retained. */
  maxRgBytes: number;
  /** `rg --max-count` per file. */
  rgPerFileMatches: number;
  /** `rg --max-filesize` in bytes. */
  rgMaxFileSize: number;
}

export interface RetrievedFile {
  relPath: string;
  content: string;
  truncated: boolean;
}

export interface RgMatch {
  relPath: string;
  line: number;
  text: string;
}

export interface RepoEvidenceCorpus {
  source: string;
  name: string;
  files: Map<string, RetrievedFile>;
  matches: RgMatch[];
}

export interface DocMention {
  document: string;
  repoSource: string;
  repoName: string;
  match: string;
}

export interface ReferencedDoc {
  from: string;
  raw: string;
  resolved?: string;
  reason: string;
}

export interface RetrievalStats {
  filesRead: number;
  bytesRead: number;
  rgMatches: number;
  rgBytes: number;
  rgExecuted: boolean;
}

export interface RetrievalResult {
  repos: Map<string, RepoEvidenceCorpus>;
  docMentions: DocMention[];
  referencedDocs: ReferencedDoc[];
  queryTerms: string[];
  gaps: string[];
  stats: RetrievalStats;
}

export interface RetrieveOptions {
  budget?: Partial<RetrievalBudget>;
  /** Absolute paths of readable supplied local documents. */
  suppliedDocs?: readonly string[];
  /** Configured code roots used when resolving local document mentions. */
  codeRoots?: readonly string[];
  rgPath?: string;
}

const README_NAMES = ['README', 'README.md', 'README.rst', 'README.txt', 'readme.md'];
const MANIFEST_NAMES = [
  'package.json',
  'pyproject.toml',
  'go.mod',
  'Cargo.toml',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'Gemfile',
  'composer.json',
  'requirements.txt',
  'tsconfig.json',
];
const INSTRUCTION_NAMES = [
  'AGENTS.md',
  'CLAUDE.md',
  'CONTRIBUTING.md',
  'CONTRIBUTING',
  '.cursorrules',
  '.github/copilot-instructions.md',
];

const STOP_WORDS: ReadonlySet<string> = new Set([
  'the', 'and', 'for', 'with', 'into', 'from', 'that', 'this', 'then', 'than',
  'new', 'old', 'use', 'using', 'add', 'all', 'any', 'are', 'but', 'can',
  'how', 'its', 'not', 'our', 'out', 'per', 'via', 'was', 'will', 'you',
  'your', 'port', 'move', 'migrate', 'migration', 'system', 'code', 'repo',
  'repository', 'project', 'task', 'feature', 'local',
]);

/**
 * Extracts bounded search terms (identifiers, symbols, likely package names)
 * from the request, explicit context, and document text. Deterministic and
 * model-free so retrieval is reproducible.
 */
export function extractQueryTerms(
  request: string,
  context: readonly string[] = [],
  docTexts: readonly string[] = [],
  limit = 40
): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();

  const collect = (text: string) => {
    if (terms.length >= limit) return;
    const tokens = text.match(/[A-Za-z_][A-Za-z0-9_.@/-]*[A-Za-z0-9_]|[A-Za-z0-9_]{3,}/g) ?? [];
    for (const raw of tokens) {
      if (terms.length >= limit) return;
      const token = raw.replace(/^[-._/@]+|[-._/@]+$/g, '');
      if (token.length < 3) continue;
      const lower = token.toLowerCase();
      if (STOP_WORDS.has(lower)) continue;
      if (seen.has(lower)) continue;
      seen.add(lower);
      terms.push(token);
      if (terms.length >= limit) return;
    }
  };

  collect(request);
  for (const line of context) collect(line);
  for (const text of docTexts) collect(text);

  return terms;
}

function decodeUtf8(buf: Buffer): string {
  return buf.toString('utf8');
}

/**
 * Reads at most `maxBytes` from a file, reporting truncation. Never throws on
 * a missing file; returns null with a reason instead.
 */
export function readBoundedFile(
  absPath: string,
  maxBytes: number
): { content: string; truncated: boolean } | { error: string } {
  let fd: number | null = null;
  try {
    const st = fs.lstatSync(absPath);
    if (st.isSymbolicLink()) {
      return { error: 'symbolic links are not followed during retrieval' };
    }
    if (!st.isFile()) {
      return { error: 'not a regular file' };
    }
    fd = fs.openSync(absPath, 'r');
    const buf = Buffer.alloc(maxBytes + 1);
    const read = fs.readSync(fd, buf, 0, maxBytes + 1, 0);
    const truncated = read > maxBytes;
    return { content: decodeUtf8(buf.subarray(0, Math.min(read, maxBytes))), truncated };
  } catch (err: unknown) {
    return { error: (err as Error).message };
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

function execFileAsync(
  file: string,
  args: string[],
  options: { cwd: string; maxBuffer: number; timeoutMs: number }
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { cwd: options.cwd, maxBuffer: options.maxBuffer, timeout: options.timeoutMs, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(err);
          return;
        }
        const anyErr = err as (Error & { code?: number | string }) | null;
        if (err && anyErr && typeof anyErr.code === 'string' && anyErr.code === 'ENOENT') {
          reject(err);
          return;
        }
        // rg exits 1 when there are no matches; that is not an error for us.
        if (
          err &&
          anyErr &&
          (err as { killed?: boolean }).killed !== true &&
          !('code' in err && (anyErr.code === 1 || anyErr.code === null || anyErr.code === undefined))
        ) {
          reject(err);
          return;
        }
        resolve({
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          code: anyErr && typeof anyErr.code === 'number' ? anyErr.code : 0,
        });
      }
    );
  });
}

export interface RgOutcome {
  matches: RgMatch[];
  bytes: number;
  executed: boolean;
  truncated: boolean;
  error?: string;
}

/**
 * Runs a bounded, read-only ripgrep search inside a repository. Fixed-string
 * patterns are used so request text can never be interpreted as a regex.
 */
export async function runRg(
  repoSource: string,
  terms: readonly string[],
  budget: RetrievalBudget,
  rgPath = 'rg'
): Promise<RgOutcome> {
  if (terms.length === 0) {
    return { matches: [], bytes: 0, executed: false, truncated: false };
  }

  const args = [
    '--line-number',
    '--no-heading',
    '--color',
    'never',
    '--fixed-strings',
    '--no-messages',
    '--max-count',
    String(budget.rgPerFileMatches),
    '--max-filesize',
    String(budget.rgMaxFileSize),
    '--glob',
    '!**/node_modules/**',
    '--glob',
    '!**/vendor/**',
    '--glob',
    '!**/dist/**',
    '--glob',
    '!**/build/**',
    '--glob',
    '!**/.git/**',
    ...terms.flatMap((term) => ['-e', term]),
    '--',
    '.',
  ];

  let result: { stdout: string; stderr: string; code: number | null };
  try {
    result = await execFileAsync(rgPath, args, {
      cwd: repoSource,
      maxBuffer: budget.maxRgBytes,
      timeoutMs: 20000,
    });
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { matches: [], bytes: 0, executed: false, truncated: false, error: 'ripgrep (rg) is not installed' };
    }
    return {
      matches: [],
      bytes: 0,
      executed: true,
      truncated: false,
      error: (err as Error).message,
    };
  }

  const matches: RgMatch[] = [];
  let bytes = 0;
  let truncated = false;

  for (const line of result.stdout.split('\n')) {
    if (line.length === 0) continue;
    bytes += Buffer.byteLength(line, 'utf8') + 1;
    if (matches.length >= budget.maxRgMatches || bytes > budget.maxRgBytes) {
      truncated = true;
      break;
    }
    const m = line.match(/^(.+?):(\d+):(.*)$/);
    if (!m) continue;
    let relPath = m[1];
    if (relPath.startsWith('./')) relPath = relPath.slice(2);
    matches.push({ relPath, line: Number(m[2]), text: m[3] });
  }

  return { matches, bytes, executed: true, truncated };
}

function tryReadIntoCorpus(
  corpus: RepoEvidenceCorpus,
  repoSource: string,
  relPath: string,
  budget: RetrievalBudget,
  counters: { filesRead: number; bytesRead: number }
): void {
  if (corpus.files.has(relPath)) return;
  if (counters.filesRead >= budget.maxFiles || counters.bytesRead >= budget.maxBytes) return;
  const remaining = budget.maxBytes - counters.bytesRead;
  const cap = Math.max(1, Math.min(budget.maxFileBytes, remaining));
  const abs = path.resolve(repoSource, relPath);
  const rel = path.relative(repoSource, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return;
  const res = readBoundedFile(abs, cap);
  if ('error' in res) return;
  counters.filesRead++;
  counters.bytesRead += Buffer.byteLength(res.content, 'utf8');
  corpus.files.set(relPath, { relPath, content: res.content, truncated: res.truncated });
}

function discoverStandardFiles(repoSource: string): string[] {
  const names = [...README_NAMES, ...MANIFEST_NAMES, ...INSTRUCTION_NAMES];
  const found: string[] = [];
  for (const name of names) {
    const abs = path.join(repoSource, name);
    try {
      const st = fs.lstatSync(abs);
      if (st.isFile() && !st.isSymbolicLink()) {
        found.push(name);
      }
    } catch {
      // absent
    }
  }
  return found;
}

const MARKDOWN_LINK_RE = /\]\(([^)\s]+)\)/g;
const BACKTICK_PATH_RE = /`([^`\n]+)`/g;

/**
 * Resolves local document mentions of repository names and of local files
 * reachable from a supplied document. Only mentions that resolve inside a
 * configured code root (or the document's own directory) are returned so a
 * document cannot pull arbitrary files into retrieval.
 */
export function resolveLocalDocMentions(
  docText: string,
  docDir: string,
  repos: readonly DiscoveredRepo[],
  codeRoots: readonly string[]
): { repoMentions: DocMention[]; referencedDocs: ReferencedDoc[] } {
  const repoMentionsMap = new Map<string, DocMention>();
  const referencedDocs: ReferencedDoc[] = [];

  for (const repo of repos) {
    const name = repo.name;
    if (name.length < 3) continue;
    const re = new RegExp(`(^|[^A-Za-z0-9_.-])${escapeRegExp(name)}($|[^A-Za-z0-9_.-])`, 'i');
    const directMatch = docText.match(re);
    if (directMatch) {
      repoMentionsMap.set(repo.source, {
        document: '',
        repoSource: repo.source,
        repoName: name,
        match: name,
      });
      continue;
    }
    if (docText.includes(repo.source)) {
      repoMentionsMap.set(repo.source, {
        document: '',
        repoSource: repo.source,
        repoName: name,
        match: repo.source,
      });
    }
  }

  const canonicalRoots = codeRoots.map((r) => {
    try {
      return canonicalize(r);
    } catch {
      return path.resolve(r);
    }
  });

  const candidates = new Set<string>();
  for (const re of [MARKDOWN_LINK_RE, BACKTICK_PATH_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(docText)) !== null) {
      const raw = m[1].trim();
      if (!raw || /^[a-z]+:\/\//i.test(raw) || raw.startsWith('#') || raw.startsWith('mailto:')) {
        continue;
      }
      candidates.add(raw);
      if (candidates.size > 50) break;
    }
  }

  for (const raw of candidates) {
    const resolvedAbs = path.isAbsolute(raw) ? raw : path.resolve(docDir, raw);
    let canonical: string;
    try {
      canonical = canonicalize(resolvedAbs);
    } catch {
      continue;
    }
    const inRoot = canonicalRoots.some((root) => {
      const rel = path.relative(root, canonical);
      return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
    });
    if (!inRoot) continue;
    let st: fs.Stats | null = null;
    try {
      st = fs.statSync(canonical);
    } catch {
      st = null;
    }
    if (!st || !st.isFile()) {
      referencedDocs.push({ from: '', raw, resolved: canonical, reason: 'mentioned path is not a readable file' });
      continue;
    }
    referencedDocs.push({ from: '', raw, resolved: canonical, reason: 'resolved local document mention' });
  }

  return { repoMentions: [...repoMentionsMap.values()], referencedDocs };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Runs the bounded retrieval phase: standard file reads, one ripgrep search
 * per repository, and local document mention resolution. All limits are
 * reported as gaps so callers can surface reduced coverage honestly.
 */
export async function retrieveEvidence(
  request: string,
  context: readonly string[],
  repos: readonly DiscoveredRepo[],
  options: RetrieveOptions = {}
): Promise<RetrievalResult> {
  const budget: RetrievalBudget = { ...DEFAULT_RETRIEVAL_BUDGET, ...(options.budget ?? {}) };
  const gaps: string[] = [];
  const counters = { filesRead: 0, bytesRead: 0 };
  const stats: RetrievalStats = { filesRead: 0, bytesRead: 0, rgMatches: 0, rgBytes: 0, rgExecuted: false };

  const suppliedDocs = options.suppliedDocs ?? [];
  const docTexts: string[] = [];
  for (const doc of suppliedDocs) {
    const res = readBoundedFile(doc, budget.maxFileBytes);
    if (!('error' in res)) docTexts.push(res.content);
  }

  const queryTerms = extractQueryTerms(request, context, docTexts);
  const repoCorpora = new Map<string, RepoEvidenceCorpus>();
  let rgUnavailable = false;

  for (const repo of repos) {
    const corpus: RepoEvidenceCorpus = { source: repo.source, name: repo.name, files: new Map(), matches: [] };

    for (const relPath of discoverStandardFiles(repo.source)) {
      tryReadIntoCorpus(corpus, repo.source, relPath, budget, counters);
    }

    const rg = await runRg(repo.source, queryTerms, budget, options.rgPath);
    if (!rg.executed && rg.error) {
      rgUnavailable = true;
    } else {
      stats.rgExecuted = true;
    }
    if (rg.truncated) {
      gaps.push(`ripgrep results in '${repo.name}' were truncated by the retrieval budget`);
    }
    for (const match of rg.matches) {
      if (stats.rgMatches >= budget.maxRgMatches) break;
      corpus.matches.push(match);
      stats.rgMatches++;
      // Include matched files in the corpus up to the file budget so evidence
      // validation has the surrounding content available for reasoning.
      tryReadIntoCorpus(corpus, repo.source, match.relPath, budget, counters);
    }

    repoCorpora.set(repo.source, corpus);
  }

  if (rgUnavailable) {
    gaps.push("'rg' (ripgrep) is not available; retrieval used bounded file reads only");
  }
  if (counters.filesRead >= budget.maxFiles) {
    gaps.push(`Retrieval read the maximum of ${budget.maxFiles} files; coverage may be incomplete`);
  }
  if (counters.bytesRead >= budget.maxBytes) {
    gaps.push(`Retrieval read the maximum of ${Math.round(budget.maxBytes / 1024)} KiB; coverage may be incomplete`);
  }

  const docMentions: DocMention[] = [];
  const referencedDocs: ReferencedDoc[] = [];
  const mentionRoots: string[] = [];
  for (const root of options.codeRoots ?? []) {
    try {
      mentionRoots.push(canonicalize(root));
    } catch {
      mentionRoots.push(path.resolve(root));
    }
  }

  for (const doc of suppliedDocs) {
    const res = readBoundedFile(doc, budget.maxFileBytes);
    if ('error' in res) continue;
    const docDir = path.dirname(doc);
    const roots = mentionRoots.length > 0 ? [...mentionRoots, docDir] : [docDir];
    const resolved = resolveLocalDocMentions(res.content, docDir, repos, roots);
    for (const mention of resolved.repoMentions) {
      docMentions.push({ ...mention, document: doc });
    }
    for (const ref of resolved.referencedDocs) {
      referencedDocs.push({ ...ref, from: doc });
    }
  }

  stats.filesRead = counters.filesRead;
  stats.bytesRead = counters.bytesRead;

  return { repos: repoCorpora, docMentions, referencedDocs, queryTerms, gaps, stats };
}

export function summarizeRetrieval(result: RetrievalResult): string {
  const lines: string[] = [];
  lines.push(`Query terms: ${result.queryTerms.join(', ') || '(none)'}`);
  for (const corpus of result.repos.values()) {
    lines.push(
      `- ${corpus.name} (${corpus.source}): ${corpus.files.size} file(s), ${corpus.matches.length} match(es)`
    );
  }
  return lines.join('\n');
}
