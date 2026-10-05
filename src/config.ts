import { Type, type Static } from 'typebox';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseYamlStrict } from './yamlio.ts';
import { expandHome } from './paths.ts';
import { UsageError } from './errors.ts';

export const ScoutConfigSchema = Type.Object(
  {
    provider: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
  },
  { additionalProperties: false }
);

export const ConfigSchema = Type.Object(
  {
    code_roots: Type.Optional(Type.Array(Type.String())),
    workspace_root: Type.Optional(Type.String()),
    adapters: Type.Optional(
      Type.Array(Type.Union([Type.Literal('agents'), Type.Literal('claude')]))
    ),
    max_discovered_repos: Type.Optional(Type.Integer({ minimum: 1 })),
    scout: Type.Optional(ScoutConfigSchema),
  },
  { additionalProperties: false }
);

export type Config = Static<typeof ConfigSchema>;

export type AdapterName = 'agents' | 'claude';

export interface ResolvedSettings {
  code_roots: string[];
  workspace_root: string;
  adapters: AdapterName[];
  max_discovered_repos: number;
  scout: {
    provider: string;
    model?: string;
  };
}

export interface CliSettingsInput {
  root?: string;
  '--root'?: string;
  workspace_root?: string;
  code_root?: string | string[];
  '--code-root'?: string | string[];
  code_roots?: string[];
  codeRoots?: string[];
  for?: string | AdapterName[];
  '--for'?: string | AdapterName[];
  adapters?: AdapterName[];
  max_discovered_repos?: number;
  maxDiscoveredRepos?: number;
}

export function getDefaultSettings(): ResolvedSettings {
  return {
    code_roots: [expandHome('~/code')],
    workspace_root: expandHome('~/wsg'),
    adapters: ['agents'],
    max_discovered_repos: 5,
    scout: {
      provider: 'openai',
    },
  };
}

export function parseAdaptersFlag(value: string): AdapterName[] {
  const trimmed = value.trim();
  if (trimmed === 'none') {
    return [];
  }
  const parts = trimmed
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (parts.length === 0) {
    return ['agents'];
  }

  const result: AdapterName[] = [];
  for (const part of parts) {
    if (part === 'agents' || part === 'claude') {
      if (!result.includes(part)) {
        result.push(part);
      }
    } else {
      throw new UsageError(
        `Invalid adapter '${part}'. Allowed adapters: 'agents', 'claude', or 'none'.`
      );
    }
  }
  return result;
}

export function resolveSettings(
  cli?: CliSettingsInput,
  config?: Config
): ResolvedSettings {
  const defaults = getDefaultSettings();

  // 1. workspace_root: CLI > config > default
  const cliRoot = cli?.root ?? cli?.['--root'] ?? cli?.workspace_root;
  const workspace_root = cliRoot
    ? expandHome(cliRoot)
    : config?.workspace_root
      ? expandHome(config.workspace_root)
      : defaults.workspace_root;

  // 2. code_roots: CLI > config > default
  const rawCliCodeRoots =
    cli?.code_root ??
    cli?.['--code-root'] ??
    cli?.code_roots ??
    cli?.codeRoots;

  let code_roots: string[];
  if (rawCliCodeRoots) {
    const arr = Array.isArray(rawCliCodeRoots)
      ? rawCliCodeRoots
      : [rawCliCodeRoots];
    code_roots = arr.map((r) => expandHome(r));
  } else if (config?.code_roots && config.code_roots.length > 0) {
    code_roots = config.code_roots.map((r) => expandHome(r));
  } else {
    code_roots = defaults.code_roots;
  }

  // 3. adapters: CLI > config > default
  const rawCliAdapters =
    cli?.for ?? cli?.['--for'] ?? cli?.adapters;

  let adapters: AdapterName[];
  if (typeof rawCliAdapters === 'string') {
    adapters = parseAdaptersFlag(rawCliAdapters);
  } else if (Array.isArray(rawCliAdapters)) {
    adapters = [...rawCliAdapters];
  } else if (config?.adapters) {
    adapters = [...config.adapters];
  } else {
    adapters = defaults.adapters;
  }

  // 4. max_discovered_repos
  const cliMax = cli?.max_discovered_repos ?? cli?.maxDiscoveredRepos;
  const max_discovered_repos =
    cliMax !== undefined
      ? cliMax
      : config?.max_discovered_repos !== undefined
        ? config.max_discovered_repos
        : defaults.max_discovered_repos;

  // 5. scout
  const scout: { provider: string; model?: string } = {
    provider: config?.scout?.provider ?? defaults.scout.provider,
  };
  if (config?.scout?.model !== undefined) {
    scout.model = config.scout.model;
  }

  return {
    code_roots,
    workspace_root,
    adapters,
    max_discovered_repos,
    scout,
  };
}

export function getConfigPath(
  env?: Record<string, string | undefined>
): string {
  const envRecord = env ?? process.env;
  if (envRecord.WSG_CONFIG) {
    return expandHome(envRecord.WSG_CONFIG);
  }
  if (envRecord.XDG_CONFIG_HOME) {
    return path.join(
      expandHome(envRecord.XDG_CONFIG_HOME),
      'wsg',
      'config.yaml'
    );
  }
  return path.join(os.homedir(), '.config', 'wsg', 'config.yaml');
}

export function loadConfig(
  env?: Record<string, string | undefined>,
  cli?: CliSettingsInput
): ResolvedSettings {
  const configPath = getConfigPath(env);
  if (!existsSync(configPath)) {
    return resolveSettings(cli);
  }

  try {
    const stat = statSync(configPath);
    if (!stat.isFile()) {
      throw new UsageError(`Config path '${configPath}' is not a regular file`);
    }
  } catch (err) {
    if (err instanceof UsageError) throw err;
    throw new UsageError(`Cannot read config file '${configPath}': ${err}`);
  }

  const text = readFileSync(configPath, 'utf8');
  const parsed = parseYamlStrict<Config>(text, ConfigSchema, {
    filename: configPath,
  });

  return resolveSettings(cli, parsed);
}

export function loadConfigFile(filePath: string): Config {
  const expanded = expandHome(filePath);
  if (!existsSync(expanded)) {
    throw new UsageError(`Config file not found: ${expanded}`);
  }
  const text = readFileSync(expanded, 'utf8');
  return parseYamlStrict<Config>(text, ConfigSchema, { filename: expanded });
}
