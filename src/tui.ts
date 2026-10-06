import {
  TuiMainScreen,
  ProcessTerminal,
  type Terminal,
  Input,
  Text,
  VStack,
  matchesKey,
  Key,
} from '@earendil-works/pi-tui';
import {
  runCreateWorkflow,
  consolidateClarification,
  type PlanSummary,
  type WorkflowEvent,
  type ActionableQuestion,
} from './workflow.ts';
import type { CreateOptions } from './create.ts';
import type { CliIO } from './cli.ts';

/**
 * Returns true if both stdin and stdout are interactive TTY terminals.
 */
export function isInteractiveTerminal(io: CliIO = {}): boolean {
  const stdin = (io.stdin ?? process.stdin) as { isTTY?: boolean };
  const stdout = (io.stdout ?? process.stdout) as { isTTY?: boolean };
  return Boolean(stdin?.isTTY && stdout?.isTTY);
}

/**
 * Formats a validated assembly plan summary for terminal display.
 */
export function formatPlanSummary(plan: PlanSummary): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('=== Plan Summary ===');
  lines.push(`Workspace:    ${plan.name}`);
  lines.push(`Destination:  ${plan.wsDir}`);
  lines.push(`Request:      ${plan.request}`);
  lines.push(`Adapters:     ${plan.adapters.join(', ')}`);

  lines.push(`Repositories (${plan.repos.length}):`);
  for (const repo of plan.repos) {
    const role = repo.intent && repo.intent !== 'unspecified' ? ` (${repo.intent})` : '';
    lines.push(`  - ${repo.name}${role}: ${repo.source} -> ${repo.dest} (branch: ${repo.branch})`);
  }

  if (plan.docs.length > 0) {
    lines.push(`Documents (${plan.docs.length}):`);
    for (const doc of plan.docs) {
      const p = doc.path ? `${doc.path} ` : '';
      lines.push(`  - ${p}(mode: ${doc.mode}) <- ${doc.source}`);
    }
  }

  if (plan.commands > 0) {
    lines.push(`Commands:     ${plan.commands} discovered`);
  }

  if (plan.gaps.length > 0) {
    lines.push('Gaps / Warnings:');
    for (const gap of plan.gaps) {
      lines.push(`  - ${gap}`);
    }
  }
  lines.push('====================');
  lines.push('');
  return lines.join('\n');
}

/**
 * Resolves a user clarification answer against actionable questions. If the
 * user supplied a 1-based index that matches candidate repositories or choices,
 * resolves to the candidate string; otherwise returns the trimmed answer.
 */
export function resolveClarificationAnswer(
  answer: string,
  questions: ActionableQuestion[]
): string {
  const trimmed = answer.trim();
  const num = parseInt(trimmed, 10);
  if (!isNaN(num) && String(num) === trimmed && num >= 1) {
    for (const q of questions) {
      if (q.candidates && q.candidates.length >= num) {
        return q.candidates[num - 1];
      }
    }
  }
  return trimmed;
}

/**
 * Abstract interface for the terminal UI view. Allows testing the entire
 * interactive state machine without an attached terminal.
 */
export interface TuiView {
  addTranscript(text: string): void;
  showProgress(event: WorkflowEvent): void;
  showPlan(plan: PlanSummary): void;
  askInput(prompt: string, options?: { placeholder?: string }): Promise<string | null>;
  askConfirmation(prompt: string): Promise<boolean>;
  setBusy(busy: boolean, statusText?: string): void;
  render(): void;
  close(): Promise<void>;
}

/**
 * Concrete terminal UI view built on Pi TUI primitives: `TuiMainScreen`,
 * `VStack`, `Text`, `Input`, with differential rendering and clean cleanup.
 */
export class PiTuiView implements TuiView {
  private tui: TuiMainScreen;
  private terminal: Terminal;
  private root: VStack;
  private transcriptContainer: VStack;
  private statusText: Text;
  private activeInput: Input | null = null;
  private currentInputResolver: ((val: string | null) => void) | null = null;
  private sigintHandler: (() => void) | null = null;
  private closed = false;

  constructor(terminal?: Terminal) {
    this.terminal = terminal ?? new ProcessTerminal();
    this.tui = new TuiMainScreen(this.terminal);
    this.root = new VStack();
    this.transcriptContainer = new VStack();
    this.statusText = new Text('', 0, 0);

    this.root.addChild(this.transcriptContainer);
    this.root.addChild(this.statusText);
    this.tui.addChild(this.root);

    this.tui.addInputListener((data) => {
      if (matchesKey(data, Key.ctrl('c'))) {
        this.cancelActiveInput();
        return { consume: true };
      }
      return undefined;
    });

    this.sigintHandler = () => {
      this.cancelActiveInput();
    };
    process.on('SIGINT', this.sigintHandler);

    this.tui.start();
  }

  private cancelActiveInput(): void {
    if (this.currentInputResolver) {
      const resolve = this.currentInputResolver;
      this.currentInputResolver = null;
      if (this.activeInput) {
        this.root.removeChild(this.activeInput);
        this.activeInput = null;
      }
      resolve(null);
    }
  }

  addTranscript(text: string): void {
    if (this.closed) return;
    const lines = text.split('\n');
    for (const line of lines) {
      this.transcriptContainer.addChild(new Text(line, 0, 0));
    }
    this.tui.requestRender();
  }

  showProgress(event: WorkflowEvent): void {
    if (this.closed) return;
    const msg = `[${event.stage}] ${event.message}`;
    this.transcriptContainer.addChild(new Text(msg, 0, 0));
    this.tui.requestRender();
  }

  showPlan(plan: PlanSummary): void {
    if (this.closed) return;
    const formatted = formatPlanSummary(plan);
    this.addTranscript(formatted);
  }

  async askInput(prompt: string, options?: { placeholder?: string }): Promise<string | null> {
    if (this.closed) return null;
    return new Promise<string | null>((resolve) => {
      const input = new Input({
        prompt,
        placeholder: options?.placeholder,
      });
      this.activeInput = input;
      this.currentInputResolver = (val) => {
        if (this.activeInput) {
          this.root.removeChild(this.activeInput);
          this.activeInput = null;
        }
        this.currentInputResolver = null;
        if (val !== null) {
          this.addTranscript(`${prompt}${val}`);
        }
        resolve(val);
      };

      input.onSubmit = (val) => {
        if (this.currentInputResolver) {
          this.currentInputResolver(val);
        }
      };

      input.onEscape = () => {
        if (this.currentInputResolver) {
          this.currentInputResolver(null);
        }
      };

      this.root.addChild(input);
      this.tui.setFocus(input);
      this.tui.renderNow();
    });
  }

  async askConfirmation(prompt: string): Promise<boolean> {
    const res = await this.askInput(`${prompt} `);
    if (res === null) return false;
    const trimmed = res.trim().toLowerCase();
    return trimmed === 'y' || trimmed === 'yes';
  }

  setBusy(busy: boolean, status?: string): void {
    if (this.closed) return;
    if (busy) {
      this.statusText.setText(status ? `\u23F3 ${status}` : '\u23F3 Working...');
    } else {
      this.statusText.setText('');
    }
    this.tui.requestRender();
  }

  render(): void {
    if (this.closed) return;
    this.tui.renderNow();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.sigintHandler) {
      process.removeListener('SIGINT', this.sigintHandler);
      this.sigintHandler = null;
    }
    this.cancelActiveInput();
    this.tui.stop();
    await this.terminal.drainInput?.();
    this.terminal.showCursor();
  }
}

export interface WsgTuiControllerOptions {
  maxClarificationTurns?: number;
  signal?: AbortSignal;
}

/**
 * Coordinates the chat-first workspace creation state machine across initial
 * task input, planning, question follow-up, plan review, confirmation, and assembly.
 */
export class WsgTuiController {
  private view: TuiView;
  private options: CreateOptions;
  private io: CliIO;
  private maxTurns: number;

  constructor(
    view: TuiView,
    options: Partial<CreateOptions> = {},
    io: CliIO = {},
    config: WsgTuiControllerOptions = {}
  ) {
    this.view = view;
    this.options = {
      request: options.request ?? '',
      ...options,
    };
    this.io = io;
    this.maxTurns = config.maxClarificationTurns ?? 5;
  }

  async run(): Promise<number> {
    try {
      this.view.addTranscript('WSG \u2014 Workspace Generator\n');

      let currentRequest = this.options.request ?? '';
      const isResume = Boolean(this.options.resume);

      if (!currentRequest && !isResume) {
        const input = await this.view.askInput('What workspace do you want to create? > ');
        if (
          input === null ||
          input.trim() === '' ||
          input.trim() === ':q' ||
          input.trim() === ':cancel'
        ) {
          this.view.addTranscript('Workspace creation was cancelled; no workspace was created.');
          return 1;
        }
        currentRequest = input.trim();
      }

      let turnCount = 0;
      const abortController = new AbortController();

      while (true) {
        this.view.setBusy(true, 'Planning...');

        const workflowOptions: CreateOptions = {
          ...this.options,
          request: currentRequest,
        };

        const result = await runCreateWorkflow(workflowOptions, this.io, {
          policy: {
            mode: 'interactive',
            approve: async (plan: PlanSummary) => {
              this.view.setBusy(false);
              this.view.showPlan(plan);
              const approved = await this.view.askConfirmation('Create workspace? [y/N]');
              return approved ? 'approve' : 'decline';
            },
          },
          events: (event) => {
            this.view.showProgress(event);
          },
          signal: abortController.signal,
        });

        this.view.setBusy(false);

        if (result.status === 'needs_input') {
          turnCount++;
          this.view.addTranscript(`\nMore information needed: ${result.reason}`);
          if (result.questions && result.questions.length > 0) {
            for (const q of result.questions) {
              this.view.addTranscript(`- ${q.question}`);
              if (q.candidates && q.candidates.length > 0) {
                for (let i = 0; i < q.candidates.length; i++) {
                  this.view.addTranscript(`    ${i + 1}. ${q.candidates[i]}`);
                }
              }
            }
          }

          if (turnCount >= this.maxTurns) {
            this.view.addTranscript(
              '\nMaximum clarification attempts reached without resolving uncertainty.'
            );
            return 4;
          }

          const answer = await this.view.askInput('Clarification > ');
          if (
            answer === null ||
            answer.trim() === '' ||
            answer.trim() === ':cancel' ||
            answer.trim() === ':q'
          ) {
            this.view.addTranscript('Workspace creation was cancelled; no workspace was created.');
            return 1;
          }

          const resolvedAnswer = resolveClarificationAnswer(answer, result.questions);
          currentRequest = consolidateClarification(currentRequest, resolvedAnswer);
          continue;
        }

        if (result.status === 'created') {
          const action = result.resumed ? 'resumed' : 'created';
          this.view.addTranscript(`\nWorkspace ${action} at ${result.wsDir}`);
          return result.exitCode;
        }

        if (result.status === 'planned') {
          this.view.addTranscript(`\nDry run complete for ${result.name}; no workspace created.`);
          return 0;
        }

        if (result.status === 'failed') {
          if (result.error.code === 'cancelled') {
            this.view.addTranscript('\nWorkspace creation was cancelled; no workspace was created.');
            return 1;
          }
          this.view.addTranscript(`\nwsg: ${result.error.message}`);
          for (const hint of result.error.hints) {
            this.view.addTranscript(`  ${hint}`);
          }
          return result.error.exitCode;
        }
      }
    } finally {
      await this.view.close();
    }
  }
}

/**
 * Starts the default interactive WSG chat terminal UI.
 */
export async function runTui(
  options: Partial<CreateOptions> = {},
  io: CliIO = {},
  customTerminal?: Terminal
): Promise<number> {
  const fullOptions: CreateOptions = {
    request: options.request ?? '',
    ...options,
  };
  const view = new PiTuiView(customTerminal);
  const controller = new WsgTuiController(view, fullOptions, io);
  return await controller.run();
}
