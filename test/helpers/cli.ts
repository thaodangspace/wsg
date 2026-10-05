import { main, type CliIO, type CommandHandlers } from '../../src/cli.ts';

export interface RunMainResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunMainOptions {
  env?: Record<string, string | undefined>;
  cwd?: string;
  handlers?: Partial<CommandHandlers>;
}

export async function runMain(
  argv: string[],
  optionsOrEnv: RunMainOptions | Record<string, string | undefined> = {},
  handlersOverride?: Partial<CommandHandlers>
): Promise<RunMainResult> {
  let stdout = '';
  let stderr = '';

  const isEnv =
    optionsOrEnv &&
    typeof optionsOrEnv === 'object' &&
    !('env' in optionsOrEnv || 'cwd' in optionsOrEnv || 'handlers' in optionsOrEnv);

  const options: RunMainOptions = isEnv
    ? { env: optionsOrEnv as Record<string, string | undefined>, handlers: handlersOverride }
    : (optionsOrEnv as RunMainOptions);

  const io: CliIO = {
    stdout: {
      write(chunk: string | Uint8Array) {
        stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        return true;
      },
    },
    stderr: {
      write(chunk: string | Uint8Array) {
        stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        return true;
      },
    },
    env: options.env ?? { ...process.env },
    cwd: options.cwd ?? process.cwd(),
  };

  const exitCode = await main(argv, io, options.handlers);
  return { exitCode, stdout, stderr };
}
