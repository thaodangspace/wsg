import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  createReadFileTool,
  createSubmitSelectionTool,
  setupModels,
  MAX_READ_BYTES,
  TRUNCATION_MARKER,
} from "../src/agent.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

const execFileAsync = promisify(execFile);

const FIXTURE_DIR = path.resolve(import.meta.dirname, "fixtures/repo");
const RUN_SCRIPT = path.resolve(import.meta.dirname, "../src/run.ts");

test("crash and resume: SPIKE_KILL_AFTER=read_file exits non-zero, persists sqlite; rerun exits 0 with matching payload", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wsg-spike-"));
  const dbPath = path.join(tmpDir, "spike-resume.sqlite");

  const expectedPayload = {
    repos: ["repo-a"],
    reason: "selected repo-a based on requirements",
  };

  try {
    // 1. Initial run with SPIKE_KILL_AFTER=read_file
    let run1ExitCode: number | null = null;
    let run1Error: Error | null = null;
    try {
      await execFileAsync(
        process.execPath,
        ["--disable-warning=ExperimentalWarning", RUN_SCRIPT, "--db", dbPath, "--fixture", FIXTURE_DIR],
        {
          env: {
            ...process.env,
            SPIKE_KILL_AFTER: "read_file",
          },
        }
      );
    } catch (err: unknown) {
      run1Error = err as Error;
      run1ExitCode = (err as { code?: number }).code ?? null;
    }

    assert(run1Error !== null, "Initial run should have failed due to process kill");
    assert.equal(run1ExitCode, 70, "Initial run should exit with code 70");
    assert(existsSync(dbPath), "SQLite database file must exist after kill");

    // 2. Rerun without SPIKE_KILL_AFTER
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", RUN_SCRIPT, "--db", dbPath, "--fixture", FIXTURE_DIR],
      {
        env: {
          ...process.env,
          SPIKE_KILL_AFTER: "",
        },
      }
    );

    const parsedStdout = JSON.parse(stdout.trim());
    assert.deepStrictEqual(
      parsedStdout,
      expectedPayload,
      "Stdout JSON on rerun must match scripted submit_selection payload"
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("crash and resume with custom selection payload", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wsg-spike-"));
  const dbPath = path.join(tmpDir, "spike-custom.sqlite");

  const customPayload = {
    repos: ["repo-x", "repo-y"],
    reason: "custom multi-repo selection",
  };

  try {
    // Run 1: kill after read_file
    try {
      await execFileAsync(
        process.execPath,
        [
          "--disable-warning=ExperimentalWarning",
          RUN_SCRIPT,
          "--db",
          dbPath,
          "--fixture",
          FIXTURE_DIR,
          "--payload",
          JSON.stringify(customPayload),
        ],
        {
          env: {
            ...process.env,
            SPIKE_KILL_AFTER: "read_file",
          },
        }
      );
      assert.fail("Should have exited non-zero");
    } catch (err: unknown) {
      assert.equal((err as { code?: number }).code, 70);
    }

    // Run 2: resume
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        RUN_SCRIPT,
        "--db",
        dbPath,
        "--fixture",
        FIXTURE_DIR,
        "--payload",
        JSON.stringify(customPayload),
      ],
      {
        env: {
          ...process.env,
          SPIKE_KILL_AFTER: "",
        },
      }
    );

    assert.deepStrictEqual(JSON.parse(stdout.trim()), customPayload);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("read_file refuses path outside fixture", async () => {
  const readTool = createReadFileTool({ fixtureDir: FIXTURE_DIR });

  const dummyApi = {
    taskId: 1 as any,
    conversationId: "root" as any,
    callId: "call_test",
    registry: {} as any,
    agent: async () => ({}) as any,
    env: undefined,
    output: () => {},
    diagnostic: () => {},
    details: async () => {},
    commit: async (fn: any) => fn({}),
    memo: async () => undefined,
    createTask: async () => 1 as any,
    getTask: async () => undefined,
    waitForTask: async () => ({} as any),
    conversation: async () => undefined,
    snapshot: async () => undefined,
    snapshotAsOf: async () => undefined,
    watchDoc: async () => undefined,
  };

  // 1. Path traversal attempting escape
  await assert.rejects(
    async () => readTool.execute({ path: "../outside.txt" }, dummyApi, BACKGROUND_CONTEXT),
    /Refusing path outside fixture/
  );

  // 2. Absolute path escaping root
  await assert.rejects(
    async () => readTool.execute({ path: "/etc/passwd" }, dummyApi, BACKGROUND_CONTEXT),
    /Refusing path outside fixture/
  );

  // 3. Traversal with multiple parents
  await assert.rejects(
    async () => readTool.execute({ path: "../../package.json" }, dummyApi, BACKGROUND_CONTEXT),
    /Refusing path outside fixture/
  );

  // 4. Backslashes rejected
  await assert.rejects(
    async () => readTool.execute({ path: "..\\outside.txt" }, dummyApi, BACKGROUND_CONTEXT),
    /Path contains backslashes/
  );

  // 5. NUL byte rejected
  await assert.rejects(
    async () => readTool.execute({ path: "README.md\0.txt" }, dummyApi, BACKGROUND_CONTEXT),
    /Path contains NUL byte/
  );

  // 6. Symlink pointing outside fixture is refused
  const outsideFile = path.resolve(FIXTURE_DIR, "../../outside-symlink-target.txt");
  await fs.writeFile(outsideFile, "secret");
  const symlinkPath = path.resolve(FIXTURE_DIR, "symlink-escape.txt");
  try {
    await fs.symlink(outsideFile, symlinkPath);
    await assert.rejects(
      async () => readTool.execute({ path: "symlink-escape.txt" }, dummyApi, BACKGROUND_CONTEXT),
      /Refusing path outside fixture/
    );
  } finally {
    try { await fs.unlink(symlinkPath); } catch {}
    try { await fs.unlink(outsideFile); } catch {}
  }

  // 7. Valid path inside fixture succeeds
  const validResult = await readTool.execute({ path: "README.md" }, dummyApi, BACKGROUND_CONTEXT);
  assert.equal(validResult.isError ?? false, false);
  assert(validResult.content && validResult.content.length > 0);
  const validFirst = validResult.content[0];
  const validText = validFirst && "text" in validFirst ? validFirst.text : "";
  assert.match(validText, /Repo A/);
});

test("read_file: over-cap read truncated with marker", async () => {
  const readTool = createReadFileTool({ fixtureDir: FIXTURE_DIR });

  const diagnostics: any[] = [];
  const dummyApi = {
    taskId: 1 as any,
    conversationId: "root" as any,
    callId: "call_test",
    registry: {} as any,
    agent: async () => ({}) as any,
    env: undefined,
    output: () => {},
    diagnostic: (d: any) => {
      diagnostics.push(d);
    },
    details: async () => {},
    commit: async (fn: any) => fn({}),
    memo: async () => undefined,
    createTask: async () => 1 as any,
    getTask: async () => undefined,
    waitForTask: async () => ({} as any),
    conversation: async () => undefined,
    snapshot: async () => undefined,
    snapshotAsOf: async () => undefined,
    watchDoc: async () => undefined,
  };

  const result = await readTool.execute({ path: "large.txt" }, dummyApi, BACKGROUND_CONTEXT);
  assert.equal(result.isError ?? false, false);
  assert(result.content && result.content.length > 0);

  const firstItem = result.content[0];
  const text = firstItem && "text" in firstItem ? firstItem.text : "";
  assert(text.includes(TRUNCATION_MARKER), "Output must contain truncation marker");
  assert(text.endsWith(TRUNCATION_MARKER), "Output must end with truncation marker");

  // The text before the marker must be exactly 16 KiB (16384 bytes)
  const headText = text.slice(0, text.length - TRUNCATION_MARKER.length);
  assert.equal(
    Buffer.byteLength(headText, "utf8"),
    MAX_READ_BYTES,
    "Content before marker must be capped at exactly 16 KiB"
  );

  // Diagnostic warning recorded
  assert(
    diagnostics.some((d) => d.code === "truncated" && d.severity === "warn"),
    "Diagnostic warning must be emitted"
  );
});

test("submit_selection is terminal and returns control: { terminate: true }", async () => {
  let captured: any = null;
  const tool = createSubmitSelectionTool({
    onSelection: (sel) => {
      captured = sel;
    },
  });

  const dummyApi = {
    taskId: 1 as any,
    conversationId: "root" as any,
    callId: "call_test",
    registry: {} as any,
    agent: async () => ({}) as any,
    env: undefined,
    output: () => {},
    diagnostic: () => {},
    details: async () => {},
    commit: async (fn: any) => fn({}),
    memo: async () => undefined,
    createTask: async () => 1 as any,
    getTask: async () => undefined,
    waitForTask: async () => ({} as any),
    conversation: async () => undefined,
    snapshot: async () => undefined,
    snapshotAsOf: async () => undefined,
    watchDoc: async () => undefined,
  };

  const payload = { repos: ["alpha", "beta"], reason: "primary candidates" };
  const res = await tool.execute(payload, dummyApi, BACKGROUND_CONTEXT);

  assert.deepStrictEqual(captured, payload);
  assert.deepStrictEqual(res.control, { terminate: true });
  assert.deepStrictEqual(res.details, payload);
});

test("setupModels wires OpenAI provider without executing live calls", () => {
  const { models, provider, modelId } = setupModels("openai");
  assert.equal(provider, "openai");
  assert.equal(modelId, "gpt-4o");

  const openaiProviderInstance = models.getProvider("openai");
  assert(openaiProviderInstance !== undefined, "OpenAI provider must be registered");
  assert.equal(openaiProviderInstance?.name, "OpenAI");

  const model = models.getModel("openai", "gpt-4o");
  assert(model !== undefined, "gpt-4o model must be available in catalog");
  assert.equal(model?.provider, "openai");
});
