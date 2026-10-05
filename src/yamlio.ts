import * as YAML from 'yaml';
import { type TSchema } from 'typebox';
import { Value } from 'typebox/value';
import { UsageError } from './errors.ts';

export interface ParseYamlOptions {
  filename?: string;
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

function findNodeOrKey(
  doc: YAML.Document,
  segments: string[],
  isKey: boolean
): YAML.Node | YAML.Pair | null {
  let current: unknown = doc.contents;
  if (!current) return null;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const isLast = i === segments.length - 1;

    if (YAML.isMap(current)) {
      const pair = current.items.find((p) => {
        const keyNode = p.key as { value?: unknown } | null | undefined;
        return (
          keyNode &&
          (keyNode.value === seg || String(keyNode.value) === seg)
        );
      });
      if (!pair) return current as YAML.Node;
      if (isLast) {
        return (isKey ? pair.key : (pair.value ?? pair.key)) as YAML.Node;
      }
      current = pair.value;
    } else if (YAML.isSeq(current)) {
      const idx = Number(seg);
      if (isNaN(idx) || !current.items[idx]) return current as YAML.Node;
      if (isLast) {
        return current.items[idx] as YAML.Node;
      }
      current = current.items[idx];
    } else {
      return current as YAML.Node;
    }
  }

  return current as YAML.Node;
}

export function parseYamlStrict<T = unknown>(
  text: string,
  schema: TSchema,
  options: ParseYamlOptions = {}
): T {
  const lineCounter = new YAML.LineCounter();
  const doc = YAML.parseDocument(text, {
    lineCounter,
    uniqueKeys: true,
  });

  const filePrefix = options.filename ? `${options.filename}:` : '';

  if (doc.errors.length > 0) {
    const first = doc.errors[0];
    const pos =
      first.linePos?.[0] ??
      (first.pos ? lineCounter.linePos(first.pos[0]) : { line: 1, col: 1 });
    const loc = `${filePrefix}${pos.line}:${pos.col}`;
    const cleanMsg =
      first.code === 'DUPLICATE_KEY'
        ? `duplicate key in YAML: ${first.message}`
        : first.message;
    throw new UsageError(`${loc}: ${cleanMsg}`);
  }

  const rawData = doc.toJSON();
  const data = rawData === null && doc.contents === null ? {} : rawData;

  const rawErrors = [...Value.Errors(schema, data)];
  if (rawErrors.length > 0) {
    const formattedErrors: string[] = [];

    for (const err of rawErrors) {
      if (err.keyword === 'additionalProperties') {
        // Redundant with individual boolean/additionalProperties errors
        continue;
      }

      const isUnknownKey =
        err.keyword === 'boolean' &&
        err.schemaPath.endsWith('/additionalProperties');
      const segments = err.instancePath.split('/').filter(Boolean);
      const pathStr = formatPath(segments);
      const node = findNodeOrKey(doc, segments, isUnknownKey);

      let line = 1;
      let col = 1;
      if (node && 'range' in node && Array.isArray(node.range) && node.range[0] !== undefined) {
        const pos = lineCounter.linePos(node.range[0]);
        line = pos.line;
        col = pos.col;
      }

      const msg = isUnknownKey
        ? `unknown key '${pathStr}'`
        : pathStr
          ? `${pathStr}: ${err.message}`
          : err.message;

      formattedErrors.push(`${filePrefix}${line}:${col}: ${msg}`);
    }

    if (formattedErrors.length === 0) {
      // Fallback if only additionalProperties was emitted
      const first = rawErrors[0];
      formattedErrors.push(`${filePrefix}1:1: ${first.message}`);
    }

    const [first, ...rest] = formattedErrors;
    throw new UsageError(first, rest);
  }

  return data as T;
}
