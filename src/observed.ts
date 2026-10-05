import fs from 'node:fs';
import path from 'node:path';

/**
 * Durable, bounded record of the exact file lines a read-only tool actually
 * delivered to the scout (read_file slices, rg_search matched lines, and
 * retrieval reads). Evidence is validated against this observed content rather
 * than against the current, possibly unseen, contents of the repository.
 *
 * The store is keyed by canonical repository source and repository-relative
 * path, and maps observed 1-based line numbers to the delivered text. It can be
 * persisted to disk so observations survive a crash and are available when the
 * scout resumes.
 */
export class ObservedEvidenceStore {
  private readonly files = new Map<string, Map<string, Map<number, string>>>();
  private readonly filePath: string | undefined;
  private readonly maxLines: number;
  private totalLines = 0;
  private truncated = false;

  constructor(filePath?: string, options: { maxLines?: number } = {}) {
    this.filePath = filePath;
    this.maxLines = options.maxLines ?? 20000;
    if (filePath) this.load();
  }

  private load(): void {
    if (!this.filePath) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as {
        version?: number;
        files?: Record<string, Record<string, Record<string, string>>>;
      };
      if (!raw || raw.version !== 1 || !raw.files) return;
      for (const [source, byPath] of Object.entries(raw.files)) {
        const pathMap = new Map<string, Map<number, string>>();
        for (const [relPath, byLine] of Object.entries(byPath)) {
          const lineMap = new Map<number, string>();
          for (const [line, text] of Object.entries(byLine)) {
            const n = Number(line);
            if (Number.isInteger(n) && n >= 1 && typeof text === 'string') {
              lineMap.set(n, text);
              this.totalLines++;
            }
          }
          if (lineMap.size > 0) pathMap.set(relPath, lineMap);
        }
        if (pathMap.size > 0) this.files.set(source, pathMap);
      }
    } catch {
      // missing or corrupt: start empty
    }
  }

  persist(): void {
    if (!this.filePath) return;
    try {
      const files: Record<string, Record<string, Record<string, string>>> = {};
      for (const [source, byPath] of this.files) {
        files[source] = {};
        for (const [relPath, byLine] of byPath) {
          const obj: Record<string, string> = {};
          for (const [line, text] of byLine) obj[String(line)] = text;
          files[source][relPath] = obj;
        }
      }
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.filePath, JSON.stringify({ version: 1, files }, null, 2) + '\n', {
        mode: 0o600,
      });
    } catch {
      // Observation persistence is best-effort; validation stays safe by rejecting.
    }
  }

  /** Records contiguous observed lines starting at `startLine`. */
  observe(source: string, relPath: string, startLine: number, lines: readonly string[]): void {
    const normalized = path.posix.normalize(relPath);
    let byPath = this.files.get(source);
    if (!byPath) {
      byPath = new Map();
      this.files.set(source, byPath);
    }
    let byLine = byPath.get(normalized);
    if (!byLine) {
      byLine = new Map();
      byPath.set(normalized, byLine);
    }
    for (let i = 0; i < lines.length; i++) {
      const lineNo = startLine + i;
      if (lineNo < 1) continue;
      if (!byLine.has(lineNo)) {
        if (this.totalLines >= this.maxLines) {
          this.truncated = true;
          continue;
        }
        this.totalLines++;
      }
      byLine.set(lineNo, lines[i]);
    }
    this.persist();
  }

  observeLine(source: string, relPath: string, line: number, text: string): void {
    this.observe(source, relPath, line, [text]);
  }

  has(source: string, relPath: string): boolean {
    const byLine = this.files.get(source)?.get(path.posix.normalize(relPath));
    return !!byLine && byLine.size > 0;
  }

  pathsFor(source: string): string[] {
    return [...(this.files.get(source)?.keys() ?? [])];
  }

  lineCount(): number {
    return this.totalLines;
  }

  getFile(source: string, relPath: string): ReadonlyMap<number, string> | undefined {
    return this.files.get(source)?.get(path.posix.normalize(relPath));
  }

  /**
   * Contiguous observed runs of a file joined with newlines. A quote is only
   * accepted when it appears within a single run, so it can never be assembled
   * from lines that were observed in different, non-adjacent slices.
   */
  runs(source: string, relPath: string): string[] {
    const byLine = this.getFile(source, relPath);
    if (!byLine || byLine.size === 0) return [];
    const numbers = [...byLine.keys()].sort((a, b) => a - b);
    const result: string[] = [];
    let current: string[] = [];
    let previous = -2;
    for (const n of numbers) {
      if (n === previous + 1) {
        current.push(byLine.get(n)!);
      } else {
        if (current.length > 0) result.push(current.join('\n'));
        current = [byLine.get(n)!];
      }
      previous = n;
    }
    if (current.length > 0) result.push(current.join('\n'));
    return result;
  }
}
