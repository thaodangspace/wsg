#!/usr/bin/env node

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { WsgError, UsageError, ConflictError, PartialError } from './errors.ts';
import type { CreateOptions } from './create.ts';
import { runExplain } from './explain.ts';
import { runAdd } from './add.ts';
import { runRefresh } from './refresh.ts';
import { runCreateWorkflow, toFailedResult, type EventSink, type WorkflowResult } from './workflow.ts';
import { isInteractiveTerminal, runTui } from './tui.ts';
import {
  exitCodeForResult,
  renderProgress,
  renderResultDiagnostics,
  writeResultJson,
} from './output.ts';

const pkgPath = new URL('../package.json', import.meta.url);
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
export const VERSION: string = pkg.version;

export const HELP_TEXT = `Usage: wsg [options]
       wsg <command> [options]

Commands:
  explain  Show saved selection evidence, exclusions, and gaps
  add      Attach an explicit input to an existing workspace
  refresh  Update selected document snapshots and generated context

Prompt mode (non-interactive, never reads stdin):
  wsg -p <request> [options]   Create a workspace when the request is clear
  --json                       Print exactly one JSON result to stdout

Prompt options:
  --name <name>                  Workspace directory name
  --root <dir>                   Output root directory (default: ~/wsg)
  --repo <path>                  Add a repository (repeatable; always included)
  --doc <path-or-url>            Add a document or URL (repeatable)
  --context <text>               Add task context line (repeatable)
  --code-root <dir>              Code discovery root (repeatable)
  --for <adapters>               Adapters: agents, claude, none (default: agents)
  --dry-run                      Print the plan without creating files
  --resume                       Resume an interrupted create or scout operation
  --allow-dirty-evidence         Allow selections whose evidence relies on uncommitted files

Options:
  -h, --help     Show help
  -v, --version  Show version number

Exit codes:
  0 created/planned   1 usage/internal failure   2 conflict   3 partial   4 needs_input
`;

export const USAGE_TEXT = `Usage: wsg [options]

Commands: explain, add, refresh
Non-interactive prompt mode: wsg -p "<request>" [--json]
Run 'wsg --help' for details.
`;

export interface PromptValues {
  help?: boolean;
  version?: boolean;
  prompt?: string;
  json?: boolean;
  name?: string;
  root?: string;
  repo?: string[];
  doc?: string[];
  context?: string[];
  'code-root'?: string[];
  for?: string;
  'dry-run'?: boolean;
  resume?: boolean;
  'allow-dirty-evidence'?: boolean;
}

export const COMMANDS = ['explain', 'add', 'refresh'] as const;
export type CommandName = (typeof COMMANDS)[number];

export interface CliIO {
  stdin?: { isTTY?: boolean; on?: Function; removeListener?: Function; [key: string]: unknown };
  stdout?: { write: (chunk: string | Uint8Array) => boolean | void; isTTY?: boolean };
  stderr?: { write: (chunk: string | Uint8Array) => boolean | void; isTTY?: boolean };
  env?: Record<string, string | undefined>;
  cwd?: string | (() => string);
}

export type CommandHandler = (args: string[], io: CliIO) => Promise<number | void> | number | void;

export interface CommandHandlers {
  explain: CommandHandler;
  add: CommandHandler;
  refresh: CommandHandler;
  tui?: (options: CreateOptions, io: CliIO) => Promise<number> | number;
}

export const defaultHandlers: CommandHandlers = {
  explain: async (args: string[], io: CliIO): Promise<number> => {
    return await runExplain(args, io);
  },
  add: async (args: string[], io: CliIO): Promise<number> => {
    return await runAdd(args, io);
  },
  refresh: async (args: string[], io: CliIO): Promise<number> => {
    return await runRefresh(args, io);
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
    const invokeTui = async (options: CreateOptions): Promise<number> => {
      if (handlers.tui) {
        const res = await handlers.tui(options, io);
        return typeof res === 'number' ? res : 0;
      }
      return await runTui(options, io);
    };

    if (argv.length === 0) {
      if (isInteractiveTerminal(io)) {
        return await invokeTui({ request: '' });
      }
      writeStderr(USAGE_TEXT);
      return 1;
    }

    const first = argv[0];

    // Explicit actionable migration guidance for removed `wsg create`
    if (first === 'create') {
      const err = new UsageError("'wsg create' has been removed.", [
        "Run 'wsg' without arguments to launch the interactive chat TUI.",
        'Run \'wsg -p "<request>"\' for non-interactive workspace creation.',
        "Pass '--json' with '-p' for machine-readable output.",
      ]);
      if (argv.includes('--json')) {
        return emitHeadlessResult(toFailedResult(err), true, io);
      }
      throw err;
    }

    // If first argument is a known command, dispatch to it
    if (COMMANDS.includes(first as CommandName)) {
      const command = first as CommandName;
      const subArgs = argv.slice(1);
      const handler = handlers[command] ?? defaultHandlers[command];
      const result = await handler(subArgs, io);
      return typeof result === 'number' ? result : 0;
    }

    // Otherwise parse top-level options: global flags plus the non-interactive
    // prompt-mode creation options. Commands were dispatched above so command
    // options never reach this parser.
    let values: PromptValues;
    let positionals: string[];
    try {
      const parsed = parseArgs({
        args: argv,
        options: {
          help: { type: 'boolean', short: 'h' },
          version: { type: 'boolean', short: 'v' },
          prompt: { type: 'string', short: 'p' },
          json: { type: 'boolean' },
          name: { type: 'string' },
          root: { type: 'string' },
          repo: { type: 'string', multiple: true },
          doc: { type: 'string', multiple: true },
          context: { type: 'string', multiple: true },
          'code-root': { type: 'string', multiple: true },
          for: { type: 'string' },
          'dry-run': { type: 'boolean' },
          resume: { type: 'boolean' },
          'allow-dirty-evidence': { type: 'boolean' },
        },
        allowPositionals: true,
        strict: true,
      });
      values = parsed.values as PromptValues;
      positionals = parsed.positionals;
    } catch (err: unknown) {
      // If --json was requested, keep stdout a single parseable document even
      // for option/usage errors. Otherwise fall through to the usage path.
      if (argv.includes('--json')) {
        const message = err instanceof Error ? err.message : String(err);
        return emitHeadlessResult(toFailedResult(new UsageError(message)), true, io);
      }
      throw err;
    }

    if (values.help) {
      writeStdout(HELP_TEXT);
      return 0;
    }

    if (values.version) {
      writeStdout(`${VERSION}\n`);
      return 0;
    }

    if (values.prompt !== undefined || values.json === true || values.resume === true) {
      return await runPromptHeadless(values, positionals, io);
    }

    if (positionals.length === 0) {
      if (isInteractiveTerminal(io)) {
        const options: CreateOptions = {
          request: '',
          name: values.name,
          root: values.root,
          repos: values.repo,
          docs: values.doc,
          context: values.context,
          codeRoots: values['code-root'],
          for: values.for,
          dryRun: values['dry-run'],
          resume: values.resume,
          allowDirtyEvidence: values['allow-dirty-evidence'],
        };
        return await invokeTui(options);
      }
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

    const parseCode =
      err instanceof TypeError ? (err as { code?: string }).code : undefined;
    if (
      parseCode === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' ||
      parseCode === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE'
    ) {
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

/**
 * Writes a typed workflow result to the CLI IO: the single JSON document to
 * stdout in JSON mode, and human diagnostics to stderr in all modes. Returns
 * the process exit code.
 */
function emitHeadlessResult(result: WorkflowResult, json: boolean, io: CliIO): number {
  const stderr = io.stderr ?? process.stderr;
  if (json) {
    writeResultJson(result, io);
  }
  renderResultDiagnostics(result, stderr);
  return exitCodeForResult(result);
}

/**
 * Runs the non-interactive prompt workflow. It never reads stdin or requires a
 * TTY: a clear request is assembled automatically under the existing safety
 * rules, ambiguity becomes a typed `needs_input` (exit 4), and failures keep
 * their existing exit classification. Stdout is reserved for the single JSON
 * result in `--json` mode; all progress and diagnostics go to stderr.
 */
async function runPromptHeadless(
  values: PromptValues,
  positionals: string[],
  io: CliIO
): Promise<number> {
  const json = values.json === true;
  const stderr = io.stderr ?? process.stderr;
  const finish = (result: WorkflowResult): number => emitHeadlessResult(result, json, io);

  try {
    if (positionals.length > 0) {
      throw new UsageError(
        `Unexpected argument '${positionals[0]}'; prompt mode takes its request via -p <request>.`
      );
    }

    const resume = values.resume === true;
    const prompt = values.prompt;

    // `--json` without a prompt is a usage error (still a parseable document).
    if (prompt === undefined && !resume) {
      throw new UsageError('Prompt mode requires a request: wsg -p "<request>" [--json]');
    }

    // A blank prompt is only acceptable for `--resume --name <name>`, where the
    // recorded operation supplies the request.
    if (
      prompt !== undefined &&
      prompt.trim().length === 0 &&
      !(resume && values.name !== undefined)
    ) {
      throw new UsageError('Workspace request must not be empty');
    }

    const options: CreateOptions = {
      request: (prompt ?? '').trim(),
      name: values.name,
      root: values.root,
      repos: values.repo,
      docs: values.doc,
      context: values.context,
      codeRoots: values['code-root'],
      for: values.for,
      dryRun: values['dry-run'],
      resume: values.resume,
      allowDirtyEvidence: values['allow-dirty-evidence'],
    };

    // In JSON mode the engine's own human output (plan, completion notes) must
    // not touch stdout; redirect it to stderr so stdout holds only the result.
    const engineIO: CliIO = json ? { ...io, stdout: stderr } : io;
    const events: EventSink = (event) => renderProgress(event, stderr);

    const result = await runCreateWorkflow(options, engineIO, {
      policy: { mode: 'unattended' },
      events,
    });

    return finish(result);
  } catch (err: unknown) {
    return finish(toFailedResult(err));
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
