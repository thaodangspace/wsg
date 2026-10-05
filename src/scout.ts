import { UsageError } from './errors.ts';

export interface ScoutRepoSelection {
  source: string;
  reason?: string;
}

export interface ScoutDocSelection {
  input: string;
  reason?: string;
}

export interface ScoutSelection {
  kind: 'selection';
  repos: ScoutRepoSelection[];
  docs: ScoutDocSelection[];
  gaps?: string[];
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
