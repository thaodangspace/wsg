import { UsageError } from './errors.ts';
import { containsSecretContent } from './documents.ts';

export const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
export const DEFAULT_FETCH_MAX_BYTES = 1_048_576; // 1 MiB
export const DEFAULT_FETCH_MAX_REDIRECTS = 5;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface FetchTextOptions {
  /** Abort and fall back to a reference after this many milliseconds of wall time. */
  timeoutMs?: number;
  /** Hard cap on bytes read from the response body. */
  maxBytes?: number;
  /** Maximum number of HTTP redirects to follow. */
  maxRedirects?: number;
  /** Overridable fetch implementation (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export type FetchTextOutcome =
  | {
      kind: 'text';
      source: string;
      finalUrl: string;
      contentType: string;
      content: Buffer;
      /** True when the body was cut off at maxBytes. */
      truncated: boolean;
    }
  | {
      kind: 'reference';
      source: string;
      reason: string;
    };

/**
 * Returns true when a content type is plausibly human-readable text that WSG is
 * willing to snapshot. HTML is accepted but converted to text before storage.
 */
export function isTextContentType(contentType: string | null | undefined): boolean {
  const raw = (contentType ?? '').split(';')[0].trim().toLowerCase();
  if (raw.length === 0) {
    // Missing content type: assume text and let the byte/NUL checks decide.
    return true;
  }
  if (raw.startsWith('text/')) {
    return true;
  }
  if (
    raw === 'application/json' ||
    raw === 'application/xml' ||
    raw === 'application/xhtml+xml' ||
    raw === 'application/ld+json' ||
    raw === 'application/javascript' ||
    raw === 'application/x-javascript'
  ) {
    return true;
  }
  return raw.endsWith('+json') || raw.endsWith('+xml');
}

export function isHtmlContentType(contentType: string | null | undefined): boolean {
  const raw = (contentType ?? '').split(';')[0].trim().toLowerCase();
  return raw === 'text/html' || raw === 'application/xhtml+xml';
}

const ENTITY_MAP: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
  '#34': '"',
  '#38': '&',
  '#60': '<',
  '#62': '>',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    const key = body.toLowerCase();
    if (ENTITY_MAP[key] !== undefined) {
      return ENTITY_MAP[key];
    }
    let code: number | undefined;
    if (key.startsWith('#x')) {
      code = parseInt(key.slice(2), 16);
    } else if (key.startsWith('#')) {
      code = parseInt(key.slice(1), 10);
    }
    if (code === undefined || !Number.isInteger(code)) {
      return match;
    }
    // Bound to valid Unicode scalar values. Surrogate halves and out-of-range
    // code points must not reach String.fromCodePoint (which throws RangeError).
    if (code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
      return match;
    }
    try {
      return String.fromCodePoint(code);
    } catch {
      return match;
    }
  });
}

/**
 * Conservative HTML-to-text conversion: drop script/style/comment content,
 * strip remaining tags, decode common entities, and collapse blank runs. This
 * is intentionally lossy, never executes scripts, never fetches subresources,
 * and never throws.
 */
export function htmlToText(html: string): string {
  let text = html.replace(/<!--[\s\S]*?-->/g, ' ');
  text = text.replace(/<(script|style|noscript|template|head)[\s\S]*?<\/\1\s*>/gi, ' ');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/(p|div|li|tr|h[1-6]|section|article|header|footer)\s*>/gi, '\n');
  text = text.replace(/<[^>]*>/g, ' ');
  try {
    text = decodeEntities(text);
  } catch {
    // Defensive: entity decoding must never abort a whole refresh. Fall back
    // to the tag-stripped text, which is already safe.
  }
  text = text.replace(/[ \t\f\v]+/g, ' ');
  text = text.replace(/ *\n */g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  return `${text.trim()}\n`;
}

function abortError(): Error {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError') {
      return 'request timed out';
    }
    return err.message || err.name;
  }
  return String(err);
}

async function cancelBody(body: ReadableStream<Uint8Array> | null | undefined): Promise<void> {
  if (!body) return;
  try {
    await body.cancel();
  } catch {
    // ignore
  }
}

/**
 * Reads at most `maxBytes` from the response body. Races each read against the
 * abort signal so a server that sends headers and then stalls cannot hang the
 * operation past the overall deadline.
 */
async function readBoundedBody(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  signal: AbortSignal
): Promise<{ content: Buffer; truncated: boolean }> {
  if (!body) {
    return { content: Buffer.alloc(0), truncated: false };
  }

  const abortRejection = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    signal.addEventListener('abort', () => reject(abortError()), { once: true });
  });

  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;

  try {
    for (;;) {
      if (signal.aborted) throw abortError();
      const { done, value } = await Promise.race([reader.read(), abortRejection]);
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      const remaining = maxBytes - total;
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      if (value.byteLength >= remaining) {
        chunks.push(Buffer.from(value.subarray(0, remaining)));
        total += remaining;
        truncated = true;
        break;
      }
      chunks.push(Buffer.from(value));
      total += value.byteLength;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
  }
  return { content: Buffer.concat(chunks), truncated };
}

/**
 * Fetches a public HTTP(S) URL with finite limits and returns either accessible
 * text or an honest reference fallback. A single wall-clock deadline bounds the
 * entire operation: every redirect, the response headers, and the full body.
 * Network, timeout, redirect, size, and content-type failures never throw; they
 * return `kind: 'reference'` with a reason. Hostile or malformed URLs are
 * rejected before any network call.
 */
export async function fetchUrlText(
  url: string,
  options: FetchTextOptions = {}
): Promise<FetchTextOutcome> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_FETCH_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_FETCH_MAX_REDIRECTS;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UsageError(`URL '${url}' is not a valid absolute URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UsageError(
      `URL '${url}' uses unsupported protocol '${parsed.protocol}'; only http and https are supported`
    );
  }

  if (typeof fetchImpl !== 'function') {
    return { kind: 'reference', source: url, reason: 'No fetch implementation available' };
  }

  const source = url.trim();
  const controller = new AbortController();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(abortError());
    }, timeoutMs);
    // Do not keep the Node event loop alive solely for the deadline.
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as unknown as { unref: () => void }).unref();
    }
  });
  const race = <T>(promise: Promise<T>): Promise<T> =>
    Promise.race([promise, deadline]);

  try {
    let current = parsed;

    for (let hop = 0; hop <= maxRedirects; hop++) {
      let response: Response;
      try {
        response = await race(
          fetchImpl(current.toString(), {
            redirect: 'manual',
            signal: controller.signal,
            headers: {
              accept:
                'text/plain, text/markdown, text/html, application/json, application/xml;q=0.9, */*;q=0.1',
              'user-agent': 'wsg/0.1 (+workspace-assembler)',
            },
          })
        );
      } catch (err: unknown) {
        return { kind: 'reference', source, reason: `fetch failed: ${describeError(err)}` };
      }

      if (REDIRECT_STATUSES.has(response.status)) {
        await cancelBody(response.body);
        const location = response.headers.get('location');
        if (!location) {
          return { kind: 'reference', source, reason: 'redirect response without a Location header' };
        }
        if (hop === maxRedirects) {
          return {
            kind: 'reference',
            source,
            reason: `too many redirects (limit ${maxRedirects})`,
          };
        }
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          return { kind: 'reference', source, reason: `invalid redirect location '${location}'` };
        }
        if (next.protocol !== 'http:' && next.protocol !== 'https:') {
          return {
            kind: 'reference',
            source,
            reason: `unsupported redirect protocol '${next.protocol}'`,
          };
        }
        current = next;
        continue;
      }

      if (!response.ok) {
        await cancelBody(response.body);
        return { kind: 'reference', source, reason: `HTTP ${response.status}` };
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (!isTextContentType(contentType)) {
        await cancelBody(response.body);
        return {
          kind: 'reference',
          source,
          reason: `unsupported content type '${contentType || 'unknown'}'`,
        };
      }

      let body: { content: Buffer; truncated: boolean };
      try {
        body = await race(readBoundedBody(response.body, maxBytes, controller.signal));
      } catch (err: unknown) {
        return {
          kind: 'reference',
          source,
          reason: `failed reading response body: ${describeError(err)}`,
        };
      }

      let content = body.content;
      if (isHtmlContentType(contentType) && content.length > 0) {
        try {
          content = Buffer.from(htmlToText(content.toString('utf8')), 'utf8');
        } catch {
          // htmlToText is total, but never let conversion abort the update.
          content = Buffer.from(content.toString('utf8').replace(/<[^>]*>/g, ' '), 'utf8');
        }
      }

      if (containsSecretContent(content)) {
        return {
          kind: 'reference',
          source,
          reason: 'content looked like a private key; not snapshotted',
        };
      }

      return {
        kind: 'text',
        source,
        finalUrl: current.toString(),
        contentType: contentType || 'text/plain',
        content,
        truncated: body.truncated,
      };
    }

    return { kind: 'reference', source, reason: `too many redirects (limit ${maxRedirects})` };
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
