export type ExitCode = 1 | 2 | 3;

export class WsgError extends Error {
  readonly exitCode: ExitCode;
  readonly hints: string[];

  constructor(message: string, exitCode: ExitCode = 1, hints: string[] = []) {
    super(message);
    this.name = this.constructor.name;
    this.exitCode = exitCode;
    this.hints = hints;
  }
}

export class UsageError extends WsgError {
  constructor(message: string, hints: string[] = []) {
    super(message, 1, hints);
  }
}

export class ConflictError extends WsgError {
  constructor(message: string, hints: string[] = []) {
    super(message, 2, hints);
  }
}

export class PartialError extends WsgError {
  constructor(message: string, hints: string[] = []) {
    super(message, 3, hints);
  }
}
