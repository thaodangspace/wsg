import path from "node:path";
import process from "node:process";
import {
  openSpikeHarness,
  type SubmitSelection,
} from "./agent.ts";

export interface RunOptions {
  storagePath?: string;
  fixtureDir?: string;
  providerType?: "openai" | "faux";
  killAfter?: string;
  readFileTarget?: string;
  selectionPayload?: SubmitSelection;
}

export function parseArgs(argv: string[]): RunOptions {
  const options: RunOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--db" && i + 1 < argv.length) {
      options.storagePath = argv[++i];
    } else if (arg === "--fixture" && i + 1 < argv.length) {
      options.fixtureDir = argv[++i];
    } else if (arg === "--provider" && i + 1 < argv.length) {
      const p = argv[++i];
      if (p === "openai" || p === "faux") {
        options.providerType = p;
      } else {
        throw new Error(`Invalid provider: ${p}`);
      }
    } else if (arg === "--kill-after" && i + 1 < argv.length) {
      options.killAfter = argv[++i];
    } else if (arg === "--read-target" && i + 1 < argv.length) {
      options.readFileTarget = argv[++i];
    } else if (arg === "--payload" && i + 1 < argv.length) {
      options.selectionPayload = JSON.parse(argv[++i]);
    }
  }
  return options;
}

export async function runSpike(options: RunOptions = {}): Promise<SubmitSelection | undefined> {
  const storagePath =
    options.storagePath ??
    process.env.SPIKE_DB_PATH ??
    path.resolve(process.cwd(), "runtime.sqlite");

  const fixtureDir =
    options.fixtureDir ??
    process.env.SPIKE_FIXTURE_PATH ??
    path.resolve(process.cwd(), "test/fixtures/repo");

  const providerType =
    options.providerType ??
    (process.env.SPIKE_PROVIDER === "openai" ? "openai" : "faux");

  const killAfter =
    options.killAfter ??
    process.env.SPIKE_KILL_AFTER ??
    undefined;

  const readFileTarget =
    options.readFileTarget ??
    process.env.SPIKE_READ_TARGET ??
    "README.md";

  const selectionPayload =
    options.selectionPayload ??
    (process.env.SPIKE_SELECTION_PAYLOAD
      ? JSON.parse(process.env.SPIKE_SELECTION_PAYLOAD)
      : {
          repos: ["repo-a"],
          reason: "selected repo-a based on requirements",
        });

  let capturedSelection: SubmitSelection | undefined;

  const { harness, readTool, submitTool, provider, modelId, context } = await openSpikeHarness({
    storagePath,
    fixtureDir,
    providerType,
    fauxResponses: {
      readFileTarget,
      selection: selectionPayload,
    },
    onSelection: (sel) => {
      capturedSelection = sel;
    },
  });

  if (killAfter) {
    harness.subscribeCommits((publication) => {
      for (const change of publication.changes) {
        if (change.type === "entry" && change.value.kind === "pi.tool-result") {
          const modelMsg = change.value.model?.[0];
          const toolName = modelMsg && "toolName" in modelMsg ? (modelMsg.toolName as string) : undefined;
          if (toolName === killAfter) {
            console.error(`[SPIKE] Killed after persisting tool result for: ${toolName}`);
            process.exit(70);
          }
        }
      }
    });
  }

  const root = await harness.root(context, {
    agent: {
      model: { provider, modelId },
      tools: [readTool, submitTool],
    },
  });

  harness.resume();

  const submission = await root.submit(
    {
      type: "input",
      content: "Select repositories for workspace",
      requestId: "spike-selection-request",
    },
    context
  );

  await submission.wait(context);

  // Recover terminal selection from successfully persisted submit_selection tool-result details
  const convContext = await root.context(context);
  let finalSelection: SubmitSelection | undefined;

  for (const entry of convContext.entries) {
    if (entry.kind === "pi.tool-result" && entry.model) {
      for (const m of entry.model) {
        if (m.role === "toolResult" && m.toolName === "submit_selection" && !m.isError) {
          if (m.details && typeof m.details === "object" && "repos" in m.details && "reason" in m.details) {
            finalSelection = m.details as SubmitSelection;
          } else if (Array.isArray(m.content) && m.content.length > 0 && "text" in m.content[0]) {
            try {
              finalSelection = JSON.parse((m.content[0] as { text: string }).text);
            } catch {
              // Ignore parse error
            }
          }
        }
      }
    }
  }

  if (!finalSelection && capturedSelection) {
    finalSelection = capturedSelection;
  }

  if (!finalSelection) {
    throw new Error("No successful persisted submit_selection tool result found");
  }

  await harness.close(context);
  return finalSelection;
}

// Execute CLI wrapper if this file is run directly
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = await runSpike(options);
    if (result) {
      process.stdout.write(JSON.stringify(result) + "\n");
    }
    process.exit(0);
  } catch (err) {
    console.error("[SPIKE ERROR]", err);
    process.exit(1);
  }
}
