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
  createScoutExtension,
  setupModels,
  sliceUtf8Safe,
  openSpikeHarness,
  MAX_READ_BYTES,
  TRUNCATION_MARKER,
} from "../src/agent.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

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

    // Direct evidence: inspect persisted entries in SQLite after crash
    const storage1 = await openNodeSqliteStorage(dbPath);
    const harness1 = await Harness.open(storage1, {
      models: setupModels("faux").models,
      registry: createRegistry(),
    }, BACKGROUND_CONTEXT);
    const root1 = await harness1.root(BACKGROUND_CONTEXT);
    const ctx1 = await root1.context(BACKGROUND_CONTEXT);
    const readResultEntry = ctx1.entries.find(
      (e) => e.kind === "pi.tool-result" && e.model?.[0]?.role === "toolResult" && e.model[0].toolName === "read_file"
    );
    assert(readResultEntry !== undefined, "read_file tool result must be committed in SQLite before kill");
    assert.equal((readResultEntry.model?.[0] as any).isError, false, "Persisted read_file result must not be an error");
    await harness1.close(BACKGROUND_CONTEXT);

    // 2. Rerun without SPIKE_KILL_AFTER
    const { stdout } = await execFileAsync(
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

    // 3. Restart after terminal result persistence: reopen completed DB
    const run3 = await execFileAsync(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", RUN_SCRIPT, "--db", dbPath, "--fixture", FIXTURE_DIR],
      {
        env: {
          ...process.env,
          SPIKE_KILL_AFTER: "",
        },
      }
    );
    assert.deepStrictEqual(
      JSON.parse(run3.stdout.trim()),
      expectedPayload,
      "Restarting after terminal persistence should recover selection from persisted details and exit 0"
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("direct evidence that read_file is not re-executed on resume: source file removed before restart", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wsg-spike-no-reexec-"));
  const dbPath = path.join(tmpDir, "spike-no-reexec.sqlite");
  const fixtureDir = path.join(tmpDir, "fixture");
  await fs.mkdir(fixtureDir);

  const testFileName = "transient-source.txt";
  const testFilePath = path.join(fixtureDir, testFileName);
  await fs.writeFile(testFilePath, "Initial content for transient source file.");

  const expectedPayload = {
    repos: ["repo-transient"],
    reason: "verified transient source",
  };

  try {
    // 1. Initial run: kill after read_file
    try {
      await execFileAsync(
        process.execPath,
        [
          "--disable-warning=ExperimentalWarning",
          RUN_SCRIPT,
          "--db",
          dbPath,
          "--fixture",
          fixtureDir,
          "--read-target",
          testFileName,
          "--payload",
          JSON.stringify(expectedPayload),
        ],
        {
          env: {
            ...process.env,
            SPIKE_KILL_AFTER: "read_file",
          },
        }
      );
      assert.fail("Initial run should have failed due to process kill");
    } catch (err: unknown) {
      assert.equal((err as { code?: number }).code, 70, "Must exit 70");
    }

    // 2. Remove the read source file completely from the filesystem before resume!
    await fs.unlink(testFilePath);
    assert.equal(existsSync(testFilePath), false, "Source file must be deleted before resume");

    // 3. Resume the conversation.
    // If read_file were re-executed, it would fail with 'File not found' (exit code 1).
    // Because it is NOT re-executed, it must resume smoothly using the persisted tool result!
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        RUN_SCRIPT,
        "--db",
        dbPath,
        "--fixture",
        fixtureDir,
        "--read-target",
        testFileName,
        "--payload",
        JSON.stringify(expectedPayload),
      ],
      {
        env: {
          ...process.env,
          SPIKE_KILL_AFTER: "",
        },
      }
    );

    assert.deepStrictEqual(
      JSON.parse(stdout.trim()),
      expectedPayload,
      "Resumed conversation succeeded using saved read result despite source file deletion"
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("programmatic proof of exactly one read_file execution across crash and resume", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wsg-spike-count-"));
  const dbPath = path.join(tmpDir, "spike-count.sqlite");
  const testFile = path.join(tmpDir, "file.txt");
  await fs.writeFile(testFile, "Hello count");

  let readExecutionCount = 0;

  const baseReadTool = createReadFileTool({ fixtureDir: tmpDir });
  const countedReadTool = {
    ...baseReadTool,
    async execute(args: any, api: any, ctx: any) {
      readExecutionCount++;
      return baseReadTool.execute(args, api, ctx);
    },
  };

  const submitTool = createSubmitSelectionTool();
  const scout = createScoutExtension([countedReadTool, submitTool]);

  // Run 1: Crash on commit
  {
    const faux = fauxProvider();
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("read_file", { path: "file.txt" }, { id: "call_read" }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage([
        fauxToolCall("submit_selection", { repos: ["r1"], reason: "done" }, { id: "call_submit" }),
      ], { stopReason: "toolUse" }),
    ]);

    const { models, provider, modelId } = setupModels("faux", { faux });
    const registry = createRegistry();
    registry.install(scout);

    const storage = await openNodeSqliteStorage(dbPath);
    const harness = await Harness.open(storage, { models, registry, settings: { extensions: [scout] } }, BACKGROUND_CONTEXT);

    harness.subscribeCommits((pub) => {
      for (const change of pub.changes) {
        if (change.type === "entry" && change.value.kind === "pi.tool-result") {
          const model = change.value.model?.[0];
          if (model && "toolName" in model && model.toolName === "read_file") {
            // Simulate crash immediately after commit
            harness.close(BACKGROUND_CONTEXT);
            return;
          }
        }
      }
    });

    const root = await harness.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider, modelId }, tools: [countedReadTool, submitTool] },
    });

    try {
      const sub = await root.submit({ type: "input", content: "read", requestId: "req-count" }, BACKGROUND_CONTEXT);
      await sub.wait(BACKGROUND_CONTEXT);
    } catch {
      // Expected harness close rejection
    }
  }

  assert.equal(readExecutionCount, 1, "read_file executed once before crash");

  // Run 2: Resume
  {
    const faux = fauxProvider();
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("submit_selection", { repos: ["r1"], reason: "done" }, { id: "call_submit" }),
      ], { stopReason: "toolUse" }),
    ]);

    const { models, provider, modelId } = setupModels("faux", { faux });
    const registry = createRegistry();
    registry.install(scout);

    const storage = await openNodeSqliteStorage(dbPath);
    const harness = await Harness.open(storage, { models, registry, settings: { extensions: [scout] } }, BACKGROUND_CONTEXT);
    const root = await harness.root(BACKGROUND_CONTEXT);
    harness.resume();

    const sub = await root.submit({ type: "input", content: "read", requestId: "req-count" }, BACKGROUND_CONTEXT);
    const res = await sub.wait(BACKGROUND_CONTEXT);
    assert.equal(res.status, "done");

    // Verify read_file was NOT executed again on resume!
    assert.equal(readExecutionCount, 1, "read_file must NOT re-execute on resume; count must remain 1");

    // Verify submit_selection result was persisted in tool-result
    const convCtx = await root.context(BACKGROUND_CONTEXT);
    const submitResultEntry = convCtx.entries.find(
      (e) => e.kind === "pi.tool-result" && e.model?.[0]?.role === "toolResult" && e.model[0].toolName === "submit_selection"
    );
    assert(submitResultEntry !== undefined, "submit_selection tool-result must be persisted");
    const toolMsg = submitResultEntry.model?.[0] as any;
    assert.equal(toolMsg.isError, false);
    assert.deepStrictEqual(toolMsg.details, { repos: ["r1"], reason: "done" });

    await harness.close(BACKGROUND_CONTEXT);
  }

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("harness turn with over-cap file: persisted result retains truncation marker within byte limit", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wsg-spike-turn-"));
  const dbPath = path.join(tmpDir, "spike-turn.sqlite");

  try {
    const { harness, readTool, submitTool, provider, modelId, context } = await openSpikeHarness({
      storagePath: dbPath,
      fixtureDir: FIXTURE_DIR,
      providerType: "faux",
      fauxResponses: {
        readFileTarget: "large.txt",
        selection: { repos: ["repo-large"], reason: "handled large file" },
      },
    });

    const root = await harness.root(context, {
      agent: { model: { provider, modelId }, tools: [readTool, submitTool] },
    });
    harness.resume();

    const sub = await root.submit({ type: "input", content: "inspect large file", requestId: "req-turn" }, context);
    const res = await sub.wait(context);
    assert.equal(res.status, "done");

    const convCtx = await root.context(context);
    const readResultEntry = convCtx.entries.find(
      (e) => e.kind === "pi.tool-result" && e.model?.[0]?.role === "toolResult" && e.model[0].toolName === "read_file"
    );
    assert(readResultEntry !== undefined, "Persisted tool result must exist for read_file");

    const modelMsg = readResultEntry.model?.[0] as any;
    assert.equal(modelMsg.isError, false);
    assert(Array.isArray(modelMsg.content) && modelMsg.content.length > 0);

    const text = modelMsg.content[0].text;
    assert(text.endsWith(TRUNCATION_MARKER), "Model-visible persisted text must end with truncation marker");
    assert(
      Buffer.byteLength(text, "utf8") <= MAX_READ_BYTES,
      `Persisted text (${Buffer.byteLength(text, "utf8")} bytes) must not exceed MAX_READ_BYTES (${MAX_READ_BYTES})`
    );

    // Diagnostics must record truncation warning
    const diagnostics = (readResultEntry.data as any)?.diagnostics ?? [];
    assert(
      diagnostics.some((d: any) => d.code === "truncated" && d.severity === "warn"),
      "Persisted diagnostics must record truncated warning"
    );

    // Confirm harness outputLimits did not strip or drop the custom marker
    assert(
      !diagnostics.some((d: any) => typeof d.message === "string" && d.message.includes("Output truncated to its beginning")),
      "Harness output limits should not drop marker when correctly budgeted"
    );

    await harness.close(context);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("bounded filesystem I/O regression: read_file never reads more than cap+1 bytes from disk", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wsg-spike-io-"));
  const fixtureDir = path.join(tmpDir, "repo");
  await fs.mkdir(fixtureDir);

  // Create a 1 MB+ file (much larger than 16 KiB)
  const oneMbFile = path.join(fixtureDir, "huge.txt");
  const largeBuf = Buffer.alloc(1024 * 1024 + 1024, "a");
  await fs.writeFile(oneMbFile, largeBuf);

  const fileStat = await fs.stat(oneMbFile);
  assert(fileStat.size > 1024 * 1024, "File size must exceed 1 MB");

  // Track filesystem read calls
  const originalOpen = fs.open;
  let requestedReadLength = 0;
  let totalBytesReadFromDisk = 0;
  let handleClosed = false;

  (fs as any).open = async (...args: any[]) => {
    const handle = await (originalOpen as any)(...args);
    const originalRead = handle.read.bind(handle);
    const originalClose = handle.close.bind(handle);

    handle.read = async (buffer: Buffer, offset: number, length: number, position: number | null) => {
      requestedReadLength = length;
      const res = await originalRead(buffer, offset, length, position);
      totalBytesReadFromDisk = res.bytesRead;
      return res;
    };

    handle.close = async () => {
      handleClosed = true;
      return originalClose();
    };

    return handle;
  };

  try {
    const readTool = createReadFileTool({ fixtureDir });
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

    const result = await readTool.execute({ path: "huge.txt" }, dummyApi, BACKGROUND_CONTEXT);
    assert.equal(result.isError ?? false, false);

    // Verify bounded I/O:
    assert.equal(
      requestedReadLength,
      MAX_READ_BYTES + 1,
      `Requested read length must be bounded to MAX_READ_BYTES + 1 (${MAX_READ_BYTES + 1})`
    );
    assert.equal(
      totalBytesReadFromDisk,
      MAX_READ_BYTES + 1,
      `Actual bytes read from disk must be at most MAX_READ_BYTES + 1, not whole 1 MB file`
    );
    assert(handleClosed, "File handle must be closed in finally");

    const text = (result.content?.[0] as { text: string }).text;
    assert(text.endsWith(TRUNCATION_MARKER), "Output must end with truncation marker");
    assert(
      Buffer.byteLength(text, "utf8") <= MAX_READ_BYTES,
      "Output byte length must be capped at 16 KiB"
    );
  } finally {
    (fs as any).open = originalOpen;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("sliceUtf8Safe preserves valid UTF-8 boundaries and rejects partial multi-byte sequences", () => {
  // Test with multi-byte unicode characters (e.g. 3-byte Japanese characters)
  const text = "あいうえおかきくけこ".repeat(100);
  const buf = Buffer.from(text, "utf8");

  for (let max = 1; max <= 50; max++) {
    const sliced = sliceUtf8Safe(buf, max);
    const slicedBytes = Buffer.byteLength(sliced, "utf8");
    assert(slicedBytes <= max, `Sliced bytes (${slicedBytes}) must not exceed max (${max})`);
    assert(!sliced.includes("\uFFFD"), "Sliced UTF-8 string must not contain unicode replacement character");
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
