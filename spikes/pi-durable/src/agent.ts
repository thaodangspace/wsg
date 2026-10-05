import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { Type, type Static } from "typebox";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  type FauxProviderHandle,
} from "@earendil-works/pi-ai/providers/faux";
import {
  defineTool,
  defineExtension,
  createRegistry,
  Harness,
  type Extension,
  type HarnessSettings,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

export const MAX_READ_BYTES = 16 * 1024; // 16 KiB cap
export const TRUNCATION_MARKER = "\n[TRUNCATED: 16 KiB limit reached]";

export const ReadFileSchema = Type.Object(
  {
    path: Type.String({ description: "Relative path to file within the fixture directory" }),
  },
  { additionalProperties: false }
);

export type ReadFileParams = Static<typeof ReadFileSchema>;

export const SubmitSelectionSchema = Type.Object(
  {
    repos: Type.Array(Type.String({ description: "Selected repository names or paths" })),
    reason: Type.String({ description: "Reason for the repository selection" }),
  },
  { additionalProperties: false }
);

export type SubmitSelection = Static<typeof SubmitSelectionSchema>;

export function resolveConfinedPath(fixtureDir: string, relativePath: string): string {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    throw new Error("Path must be a non-empty string");
  }
  if (relativePath.includes("\0")) {
    throw new Error(`Path contains NUL byte: ${relativePath}`);
  }
  if (relativePath.includes("\\")) {
    throw new Error(`Path contains backslashes: ${relativePath}`);
  }

  const realFixture = fsSync.realpathSync(path.resolve(fixtureDir));
  const resolved = path.resolve(realFixture, relativePath);

  // Check lexical containment against fixture first
  const lexicalRel = path.relative(realFixture, resolved);
  if (lexicalRel.startsWith("..") || path.isAbsolute(lexicalRel) || lexicalRel === "") {
    if (lexicalRel === "") {
      throw new Error(`Path must point to a file inside fixture, not the fixture root: ${relativePath}`);
    }
    throw new Error(`Refusing path outside fixture: ${relativePath}`);
  }

  let realTarget: string;
  try {
    realTarget = fsSync.realpathSync(resolved);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(`File not found: ${relativePath}`);
    }
    throw err;
  }

  const rel = path.relative(realFixture, realTarget);
  if (rel.startsWith("..") || path.isAbsolute(rel) || rel === "") {
    throw new Error(`Refusing path outside fixture: ${relativePath} (resolved to ${realTarget})`);
  }

  const stat = fsSync.statSync(realTarget);
  if (!stat.isFile()) {
    throw new Error(`Path is not a regular file: ${relativePath}`);
  }

  return realTarget;
}

export function createReadFileTool(options?: {
  fixtureDir?: string;
  maxBytes?: number;
  truncationMarker?: string;
}) {
  const maxBytes = options?.maxBytes ?? MAX_READ_BYTES;
  const marker = options?.truncationMarker ?? TRUNCATION_MARKER;

  return defineTool({
    name: "read_file",
    description: "Read the contents of a text file inside the allowed repository fixture.",
    parameters: ReadFileSchema,
    replay: "safe",
    outputLimits: {
      maxBytes,
      retain: "head",
    },
    async execute(args, api, _context) {
      const fixtureDir = options?.fixtureDir ?? process.env.SPIKE_FIXTURE_PATH ?? process.cwd();
      const targetPath = resolveConfinedPath(fixtureDir, args.path);

      const buffer = await fs.readFile(targetPath);
      if (buffer.byteLength > maxBytes) {
        const truncatedHead = buffer.subarray(0, maxBytes).toString("utf8");
        const text = truncatedHead + marker;
        api.diagnostic({
          severity: "warn",
          code: "truncated",
          message: `File content exceeded ${maxBytes / 1024} KiB cap and was truncated.`,
        });
        return {
          content: [{ type: "text", text }],
          diagnostics: [
            {
              severity: "warn",
              code: "truncated",
              message: `File content exceeded ${maxBytes / 1024} KiB cap and was truncated.`,
            },
          ],
        };
      }

      const text = buffer.toString("utf8");
      return {
        content: [{ type: "text", text }],
      };
    },
  });
}

export function createSubmitSelectionTool(options?: {
  onSelection?: (selection: SubmitSelection) => void;
}) {
  return defineTool({
    name: "submit_selection",
    description: "Submit repository selection and terminate conversation",
    parameters: SubmitSelectionSchema,
    async execute(args, _api, _context) {
      if (options?.onSelection) {
        options.onSelection(args);
      }
      return {
        content: [{ type: "text", text: JSON.stringify(args) }],
        details: args,
        control: { terminate: true },
      };
    },
  });
}

export const read_file = createReadFileTool();
export const submit_selection = createSubmitSelectionTool();

export function createScoutExtension(tools: [ReturnType<typeof createReadFileTool>, ReturnType<typeof createSubmitSelectionTool>]): Extension {
  return defineExtension({
    name: "scout",
    tools,
  });
}

export function setupModels(
  providerType: "openai" | "faux",
  options?: {
    faux?: FauxProviderHandle;
    defaultModelId?: string;
  }
) {
  const models = createModels();
  if (providerType === "openai") {
    models.setProvider(openaiProvider());
    return {
      models,
      faux: undefined,
      provider: "openai" as const,
      modelId: options?.defaultModelId ?? "gpt-4o",
    };
  } else {
    const faux = options?.faux ?? fauxProvider();
    models.setProvider(faux.provider);
    return {
      models,
      faux,
      provider: "faux" as const,
      modelId: faux.getModel().id,
    };
  }
}

export interface SpikeHarnessOptions {
  storagePath: string;
  fixtureDir: string;
  providerType: "openai" | "faux";
  fauxResponses?: {
    readFileTarget?: string;
    selection?: SubmitSelection;
  };
  onSelection?: (selection: SubmitSelection) => void;
}

export async function openSpikeHarness(options: SpikeHarnessOptions) {
  const readTool = createReadFileTool({ fixtureDir: options.fixtureDir });
  const submitTool = createSubmitSelectionTool({ onSelection: options.onSelection });
  const scoutExtension = createScoutExtension([readTool, submitTool]);

  const registry = createRegistry();
  registry.install(scoutExtension);

  let fauxHandle: FauxProviderHandle | undefined;
  if (options.providerType === "faux") {
    fauxHandle = fauxProvider();
    const readTarget = options.fauxResponses?.readFileTarget ?? "README.md";
    const selection = options.fauxResponses?.selection ?? {
      repos: ["repo-a"],
      reason: "selected repo-a based on requirements",
    };

    const stepFactory = (ctx: { messages: readonly { role: string; toolName?: string }[] }) => {
      const hasReadResult = ctx.messages.some(
        (m) => m.role === "toolResult" && m.toolName === "read_file"
      );
      if (!hasReadResult) {
        return fauxAssistantMessage(
          [fauxToolCall("read_file", { path: readTarget }, { id: "call_read" })],
          { stopReason: "toolUse" }
        );
      } else {
        return fauxAssistantMessage(
          [fauxToolCall("submit_selection", selection, { id: "call_submit" })],
          { stopReason: "toolUse" }
        );
      }
    };

    // Enough steps for initial or resumed run
    fauxHandle.setResponses([stepFactory, stepFactory, stepFactory]);
  }

  const { models, provider, modelId } = setupModels(options.providerType, { faux: fauxHandle });

  const storage = await openNodeSqliteStorage(options.storagePath);
  const settings: HarnessSettings = {
    extensions: [scoutExtension],
  };

  const harness = await Harness.open(storage, {
    models,
    registry,
    settings,
  }, BACKGROUND_CONTEXT);

  return {
    harness,
    readTool,
    submitTool,
    scoutExtension,
    provider,
    modelId,
    context: BACKGROUND_CONTEXT,
  };
}
