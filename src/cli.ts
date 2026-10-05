#!/usr/bin/env node

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { WsgError, UsageError, ConflictError, PartialError } from './errors.ts';
import { runCreate } from './create.ts';

const pkgPath = new URL('../package.json', import.meta.url);
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
export const VERSION: string = pkg.version;

export const HELP_TEXT = `Usage: wsg <command> [options]

Commands:
  create   Scout, select, assemble, and prepare a workspace
  explain  Show saved selection evidence, exclusions, and gaps
  add      Attach an explicit input to an existing workspace
  refresh  Update selected document snapshots and generated context

Options:
  -h, --help     Show help
  -v, --version  Show version number
`;

export const USAGE_TEXT = `Usage: wsg <command> [options]

Commands: create, explain, add, refresh
Run 'wsg --help' for details.
`;

export const COMMANDS = ['create', 'explain', 'add', 'refresh'] as const;
export type CommandName = (typeof COMMANDS)[number];

export interface CliIO {
  stdout?: { write: (chunk: string | Uint8Array) => boolean | void };
  stderr?: { write: (chunk: string | Uint8Array) => boolean | void };
  env?: Record<string, string | undefined>;
  cwd?: string | (() => string);
}

export type CommandHandler = (args: string[], io: CliIO) => Promise<number | void> | number | void;

export interface CommandHandlers {
  create: CommandHandler;
  explain: CommandHandler;
  add: CommandHandler;
  refresh: CommandHandler;
}

export const defaultHandlers: CommandHandlers = {
  create: async (args: string[], io: CliIO): Promise<number> => {
    return await runCreate(args, io);
  },
  explain: async (args: string[], io: CliIO): Promise<number> => {
    const { values } = parseArgs({
      args,
      options: {
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: true,
      strict: true,
    });
    if (values.help) {
      (io.stdout ?? process.stdout).write(`Usage: wsg explain [repo-name] [options]\n`);
      return 0;
    }
    return 0;
  },
  add: async (): Promise<never> => {
    throw new UsageError('add: not implemented in this version');
  },
  refresh: async (): Promise<never> => {
    throw new UsageError('refresh: not implemented in this version');
  },
};

export async function main(
  argv: string[],
  io: CliIO = {},
  handlers: Partial<CommandHandlers> = {}
): Promise<number> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const env = io.env ?? process.env;

  const writeStderr = (text: string) => {
    stderr.write(text);
  };
  const writeStdout = (text: string) => {
    stdout.write(text);
  };

  try {
    if (argv.length === 0) {
      writeStderr(USAGE_TEXT);
      return 1;
    }

    const first = argv[0];

    // If first argument is a known command, dispatch to it
    if (COMMANDS.includes(first as CommandName)) {
      const command = first as CommandName;
      const subArgs = argv.slice(1);
      const handler = handlers[command] ?? defaultHandlers[command];
      const result = await handler(subArgs, io);
      return typeof result === 'number' ? result : 0;
    }

    // Otherwise parse global flags (strict, allowPositionals)
    const { values, positionals } = parseArgs({
      args: argv,
      options: {
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
      allowPositionals: true,
      strict: true,
    });

    if (values.help) {
      writeStdout(HELP_TEXT);
      return 0;
    }

    if (values.version) {
      writeStdout(`${VERSION}\n`);
      return 0;
    }

    if (positionals.length === 0) {
      writeStderr(USAGE_TEXT);
      return 1;
    }

    const unknownCmd = positionals[0];
    writeStderr(`wsg: unknown command '${unknownCmd}'\n\n${USAGE_TEXT}`);
    return 1;
  } catch (err: unknown) {
    if (err instanceof WsgError) {
      writeStderr(`wsg: ${err.message}\n`);
      for (const hint of err.hints) {
        writeStderr(`  ${hint}\n`);
      }
      return err.exitCode;
    }

    if (err instanceof TypeError && 'code' in err && (err as { code?: string }).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
      writeStderr(`wsg: ${(err as Error).message}\n\n${USAGE_TEXT}`);
      return 1;
    }

    const isDebug = env.WSG_DEBUG === '1';
    if (isDebug && err instanceof Error && err.stack) {
      writeStderr(`${err.stack}\n`);
    } else {
      const message = err instanceof Error ? err.message : String(err);
      writeStderr(`wsg: unexpected error: ${message}\n`);
    }
    return 1;
  }
}

// Auto-run if executed as binary/script
if (process.argv[1]) {
  try {
    const scriptPath = realpathSync(process.argv[1]);
    const modulePath = realpathSync(fileURLToPath(import.meta.url));
    if (scriptPath === modulePath) {
      const code = await main(process.argv.slice(2));
      process.exitCode = code;
    }
  } catch {
    // Ignore when not run as a file or resolving fails
  }
}
