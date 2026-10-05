import { UsageError } from './errors.ts';
import type { Intent } from './manifest.ts';

export interface ScoutEvidence {
  /** Repository-relative file path. */
  file: string;
  /** Inclusive 1-based line range. */
  lines?: [number, number];
  summary: string;
  /** Exact quoted snippet used to reject fictional evidence. */
  quote?: string;
}

export interface ScoutRepoSelection {
  source: string;
  reason?: string;
  intent?: Intent;
  addedBy?: 'scout' | 'user';
  evidence?: ScoutEvidence[];
}

export interface ScoutDocSelection {
  input: string;
  reason?: string;
}

export interface ScoutExclusion {
  source: string;
  reason: string;
}

export interface ScoutSelection {
  kind: 'selection';
  repos: ScoutRepoSelection[];
  docs: ScoutDocSelection[];
  gaps?: string[];
  excluded?: ScoutExclusion[];
  context?: string[];
}

export interface ScoutAmbiguous {
  kind: 'ambiguous';
  reason: string;
  candidates: string[];
  guidance?: string;
}

export interface ScoutNone {
  kind: 'none';
  reason: string;
  gaps?: string[];
}

export type ScoutResult = ScoutSelection | ScoutAmbiguous | ScoutNone;

export interface ScoutOptions {
  request: string;
  repos?: string[];
  docs?: string[];
  context?: string[];
  /** Code roots used by discovery-aware scouts. */
  codeRoots?: string[];
  /** Durable state directory used for checkpointing and resume. */
  stateDir?: string;
  /** Maximum number of automatically discovered repositories. */
  maxDiscoveredRepos?: number;
  /** When true, resume an interrupted scout conversation instead of starting over. */
  resume?: boolean;
  env?: Record<string, string | undefined>;
  onProgress?: (message: string) => void;
}

export interface Scout {
  scout(options: ScoutOptions): Promise<ScoutResult>;
}

export class ExplicitScout implements Scout {
  async scout(options: ScoutOptions): Promise<ScoutResult> {
    const repos = (options.repos ?? []).map((source) => ({
      source,
      reason: 'Explicit repository supplied by the user.',
    }));
    const docs = (options.docs ?? []).map((input) => ({
      input,
    }));
    if (repos.length === 0) {
      return {
        kind: 'none',
        reason:
          'No repositories specified. Autonomous discovery is not available in this version; supply repositories using --repo <path>.',
      };
    }
    return {
      kind: 'selection',
      repos,
      docs,
    };
  }
}

/**
 * A deterministic scout seam for tests. It is not part of the product surface;
 * production scouting runs through the Pi Durable harness (`PiScout`).
 */
export class ScriptedScout implements Scout {
  private readonly produce: (options: ScoutOptions) => ScoutResult | Promise<ScoutResult>;

  constructor(
    result: ScoutResult | ((options: ScoutOptions) => ScoutResult | Promise<ScoutResult>)
  ) {
    this.produce = typeof result === 'function' ? result : () => result;
  }

  async scout(options: ScoutOptions): Promise<ScoutResult> {
    return await this.produce(options);
  }
}

export function isScoutResult(value: unknown): value is ScoutResult {
  if (!value || typeof value !== 'object') return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === 'selection' || kind === 'ambiguous' || kind === 'none';
}

export function assertScoutResult(value: unknown): ScoutResult {
  if (!isScoutResult(value)) {
    throw new UsageError('Scout returned an unrecognized result shape');
  }
  return value;
}
