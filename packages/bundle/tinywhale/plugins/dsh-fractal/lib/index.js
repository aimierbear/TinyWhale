// packages/bundle/tinywhale/plugins/dsh-fractal/src/index.ts
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSessionPreset } from "@deepseek-ai/dsh-agent-presets";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";

// packages/bundle/tinywhale/plugins/dsh-fractal/src/core-client.ts
import { spawn } from "node:child_process";
var CoreClientError = class extends Error {
  code;
  retryable;
  constructor(code, message, retryable = false) {
    super(message);
    this.name = "CoreClientError";
    this.code = code;
    this.retryable = retryable;
  }
};
var MAX_INPUT_BYTES = 1048576;
var FORCE_KILL_DELAY_MS = 500;
function isJsonObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
var CoreClient = class {
  #options;
  constructor(options) {
    this.#options = options;
  }
  action(operation, payload, options) {
    return this.#call(this.#options.actionBin, operation, payload, options);
  }
  capability(operation, payload, options) {
    return this.#call(this.#options.capabilityBin, operation, payload, options);
  }
  #call(binary, operation, payload, options) {
    if (options.signal?.aborted) {
      return Promise.reject(new CoreClientError("aborted", "fractal core call was cancelled", true));
    }
    const input = Buffer.from(JSON.stringify(payload), "utf8");
    if (input.byteLength > MAX_INPUT_BYTES) {
      return Promise.reject(new CoreClientError("input_too_large", "fractal core input is too large"));
    }
    return new Promise((resolve, reject) => {
      let aborted = false;
      let forceTimer;
      let outputTooLarge = false;
      let settled = false;
      let timedOut = false;
      let stdoutBytes = 0;
      const stdout = [];
      const child = spawn(binary, [operation], {
        cwd: options.cwd,
        env: process.env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      });
      const cleanup = () => {
        clearTimeout(timeout);
        if (forceTimer !== void 0) clearTimeout(forceTimer);
        options.signal?.removeEventListener("abort", onAbort);
      };
      const fail = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const succeed = (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      const terminate = () => {
        child.kill("SIGTERM");
        forceTimer = setTimeout(() => child.kill("SIGKILL"), FORCE_KILL_DELAY_MS);
        forceTimer.unref();
      };
      const onAbort = () => {
        aborted = true;
        terminate();
      };
      const timeout = setTimeout(() => {
        timedOut = true;
        terminate();
      }, this.#options.timeoutMs);
      timeout.unref();
      options.signal?.addEventListener("abort", onAbort, { once: true });
      child.once("error", (error) => {
        const missing = error.code === "ENOENT";
        fail(new CoreClientError(
          missing ? "binary_unavailable" : "spawn_failed",
          missing ? "configured fractal core binary is unavailable" : "fractal core process could not start",
          true
        ));
      });
      child.stdout.on("data", (chunk) => {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > this.#options.maxOutputBytes) {
          outputTooLarge = true;
          terminate();
          return;
        }
        stdout.push(chunk);
      });
      child.stderr.resume();
      child.stdin.on("error", () => {
      });
      child.once("close", (code) => {
        if (settled) return;
        if (aborted) {
          fail(new CoreClientError("aborted", "fractal core call was cancelled", true));
          return;
        }
        if (timedOut) {
          fail(new CoreClientError("timeout", "fractal core call timed out", true));
          return;
        }
        if (outputTooLarge) {
          fail(new CoreClientError("output_too_large", "fractal core output is too large"));
          return;
        }
        if (code !== 0) {
          fail(new CoreClientError("process_failed", "fractal core rejected the operation", false));
          return;
        }
        try {
          const decoded = Buffer.concat(stdout).toString("utf8").trim();
          const value = JSON.parse(decoded);
          if (!isJsonObject(value)) throw new TypeError("response is not an object");
          succeed(value);
        } catch {
          fail(new CoreClientError("invalid_output", "fractal core returned invalid JSON"));
        }
      });
      child.stdin.end(input);
    });
  }
};

// packages/bundle/tinywhale/plugins/dsh-fractal/src/index.ts
var name = "dsh-fractal";
var inject = ["agents", "tools"];
var ADAPTER_VERSION = "0.1.0";
var DEFAULT_PRESETS = ["standard", "code", "cordis"];
var DEFAULT_TIMEOUT_MS = 3e4;
var DEFAULT_MAX_OUTPUT_BYTES = 1048576;
var MAX_DOCUMENT_BYTES = 131072;
var MAX_DOCUMENT_CANDIDATES = 64;
var HOME_ACTION_BIN = join(homedir(), ".local/bin/fractal-action");
var HOME_CAPABILITY_BIN = join(homedir(), ".local/bin/fractal-capability");
var BUNDLED_ACTION_BIN = fileURLToPath(new URL("../core/bin/fractal-action", import.meta.url));
var BUNDLED_CAPABILITY_BIN = fileURLToPath(new URL("../core/bin/fractal-capability", import.meta.url));
var IDLE_CLOSEOUT = /* @__PURE__ */ new Set([
  "clean",
  "graph_reconciled",
  "duplicate",
  "needs_unowned_audit"
]);
function resolveDefaultCoreBins(env = process.env) {
  return {
    actionBin: firstBin(env.FRACTAL_ACTION_BIN, BUNDLED_ACTION_BIN, HOME_ACTION_BIN),
    capabilityBin: firstBin(env.FRACTAL_CAPABILITY_BIN, BUNDLED_CAPABILITY_BIN, HOME_CAPABILITY_BIN)
  };
}
function firstBin(...candidates) {
  const trimmed = candidates.filter((value) => typeof value === "string").map((value) => value.trim()).filter((value) => value.length > 0);
  return trimmed.find((value) => existsSync(value)) ?? trimmed[trimmed.length - 1] ?? HOME_ACTION_BIN;
}
var Config = z.object({
  actionBin: z.string().default(""),
  capabilityBin: z.string().default(""),
  enabledPresets: z.array(z.string()).default([...DEFAULT_PRESETS]),
  maxOutputBytes: z.number().step(1).min(1024).max(DEFAULT_MAX_OUTPUT_BYTES).default(DEFAULT_MAX_OUTPUT_BYTES),
  timeoutMs: z.number().step(1).min(1).max(12e4).default(DEFAULT_TIMEOUT_MS)
});
var toolOutcomeSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "boolean", required: true },
    operation: { type: "string", required: true },
    result: { type: "json" },
    error: {
      type: "object",
      additionalProperties: false,
      properties: {
        code: { type: "string", required: true },
        message: { type: "string", required: true },
        retryable: { type: "boolean", required: true }
      }
    }
  }
};
function resolveConfig(config) {
  const defaults = resolveDefaultCoreBins();
  const actionBin = config.actionBin?.trim() || defaults.actionBin;
  const capabilityBin = config.capabilityBin?.trim() || defaults.capabilityBin;
  const presets = config.enabledPresets ?? [...DEFAULT_PRESETS];
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 12e4) {
    throw new TypeError("dsh-fractal timeoutMs must be an integer between 1 and 120000");
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1024 || maxOutputBytes > DEFAULT_MAX_OUTPUT_BYTES) {
    throw new TypeError("dsh-fractal maxOutputBytes must be an integer between 1024 and 1048576");
  }
  if (presets.some((preset) => preset.trim().length === 0)) {
    throw new TypeError("dsh-fractal enabledPresets cannot contain a blank id");
  }
  return {
    actionBin,
    capabilityBin,
    enabledPresets: new Set(presets),
    maxOutputBytes,
    timeoutMs
  };
}
function envelope(sessionKey2) {
  return {
    adapter_version: ADAPTER_VERSION,
    contract_version: 1,
    occurred_at: (/* @__PURE__ */ new Date()).toISOString(),
    operation_id: randomUUID(),
    runtime_id: "dsh",
    session_id: sessionKey2
  };
}
function sessionKey(agent) {
  return createHash("sha256").update(String(agent.id), "utf8").digest("hex");
}
function stringField(value, key) {
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : void 0;
}
function coreSucceeded(operation, value) {
  const status = stringField(value, "status");
  switch (operation) {
    case "scan_dependencies":
    case "query_dependencies":
      return status === "ok";
    case "update_fractal_document":
      return status === "updated" || status === "no_change";
    case "complete_closeout":
      return status === "acknowledged" || status === "duplicate";
    default:
      return false;
  }
}
function successOutcome(operation, result) {
  return { ok: true, operation, result };
}
function failureOutcome(operation, code, message, retryable = false) {
  return { ok: false, operation, error: { code, message, retryable } };
}
function responseOutcome(operation, result) {
  if (coreSucceeded(operation, result)) return successOutcome(operation, result);
  return failureOutcome(
    operation,
    stringField(result, "reason_code") ?? "capability_unavailable",
    `Shared fractal capability ${operation} did not complete.`,
    result.retryable === true
  );
}
function errorOutcome(operation, error) {
  if (error instanceof CoreClientError) {
    return failureOutcome(operation, error.code, error.message, error.retryable);
  }
  return failureOutcome(operation, "adapter_internal_error", "The fractal adapter could not complete the operation.");
}
function renderOutcome(_args, value) {
  if (!value.ok) {
    return [{ type: "text", text: `Fractal operation ${value.operation} unavailable: ${value.error?.code ?? "unknown"}.` }];
  }
  return [{ type: "text", text: JSON.stringify(value.result) }];
}
function safeCandidatePath(value) {
  return value.length > 0 && value.length <= 4096 && !isAbsolute(value) && !value.includes("\\") && !/[\u0000-\u001f\u007f]/u.test(value) && !value.split("/").includes("..") && (posix.basename(value) === ".folder.md" || value === "README.md");
}
function parsePendingCloseout(value) {
  const status = stringField(value, "status");
  if (status !== void 0 && IDLE_CLOSEOUT.has(status)) {
    const rawCandidates2 = value.document_candidates;
    if (rawCandidates2 !== void 0 && (!Array.isArray(rawCandidates2) || rawCandidates2.length > 0)) {
      throw new CoreClientError("action_contract_mismatch", "completed closeout response contains document candidates");
    }
    return void 0;
  }
  if (status === "stale") {
    throw new CoreClientError(
      stringField(value, "reason_code") ?? "state_watermark_stale",
      "fractal closeout state changed before reconciliation completed",
      true
    );
  }
  if (status !== "needs_closeout" && status !== "already_reminded") {
    throw new CoreClientError(
      stringField(value, "reason_code") ?? "action_contract_mismatch",
      "fractal action core returned an unknown closeout status",
      value.retryable === true
    );
  }
  const id = stringField(value, "closeout_request_id");
  if (id === void 0 || id.length > 96 || /[\u0000-\u001f\u007f]/u.test(id)) {
    throw new CoreClientError("action_contract_mismatch", "closeout response has an invalid closeout_request_id");
  }
  const rawCandidates = value.document_candidates;
  if (!Array.isArray(rawCandidates) || rawCandidates.length === 0 || rawCandidates.length > MAX_DOCUMENT_CANDIDATES) {
    throw new CoreClientError("action_contract_mismatch", "closeout response has invalid document_candidates");
  }
  const candidates = /* @__PURE__ */ new Map();
  const paths = /* @__PURE__ */ new Set();
  const tokens = /* @__PURE__ */ new Set();
  for (const raw of rawCandidates) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new CoreClientError("action_contract_mismatch", "closeout response has an invalid document candidate");
    }
    const candidate = raw;
    const candidateToken = candidate.candidate_token;
    const expectedSha256 = candidate.expected_sha256;
    const filePath = candidate.file_path;
    if (typeof candidateToken !== "string" || candidateToken.length === 0 || candidateToken.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(candidateToken) || typeof expectedSha256 !== "string" || expectedSha256 !== "missing" && !/^[0-9a-f]{64}$/u.test(expectedSha256) || typeof filePath !== "string" || !safeCandidatePath(filePath) || tokens.has(candidateToken) || paths.has(filePath)) {
      throw new CoreClientError("action_contract_mismatch", "closeout response has an invalid document candidate");
    }
    const normalized = { filePath };
    candidates.set(filePath, normalized);
    paths.add(filePath);
    tokens.add(candidateToken);
  }
  return { candidates, completed: /* @__PURE__ */ new Set(), id };
}
function closeoutInstruction(pending) {
  const candidates = [...pending.candidates.values()].map((candidate) => `- ${candidate.filePath}`).join("\n");
  return [
    "The shared fractal core found semantic folder documents that require a targeted update.",
    "Update only the authorized candidates below. Preserve useful human-written constraints, use source and dependency evidence, and write complete final Markdown with update_fractal_document.",
    candidates,
    "Call update_fractal_document once for every candidate path, then stop. Do not modify other files as part of this synchronization."
  ].join("\n\n");
}
function apply(ctx, config = {}) {
  const resolved = resolveConfig(config);
  const client = new CoreClient(resolved);
  const states = /* @__PURE__ */ new Set();
  const stateByAgent = /* @__PURE__ */ new WeakMap();
  const executionTouches = /* @__PURE__ */ new Map();
  const warnOnce = (state, key, message) => {
    if (state.warned.has(key)) return;
    state.warned.add(key);
    ctx.logger.warn(`dsh-fractal: ${message}`);
  };
  const enqueue = (state, work) => {
    const run = state.queue.then(async () => {
      if (state.disposed) throw new CoreClientError("agent_disposed", "agent was disposed");
      return work();
    });
    state.queue = run.then(() => void 0, () => void 0);
    return run;
  };
  const toolCall = async (state, operation, work) => {
    try {
      return responseOutcome(operation, await enqueue(state, work));
    } catch (error) {
      return errorOutcome(operation, error);
    }
  };
  const disposeUpdateTool = (state) => {
    const dispose = state.updateToolDisposer;
    state.updateToolDisposer = void 0;
    if (dispose !== void 0) dispose();
  };
  const registerBaseTools = (state) => {
    if (!state.enabled) return;
    state.toolDisposers.push(state.agent.ctx.tools.register(defineTool({
      name: "scan_dependencies",
      description: "Refresh the current session workspace dependency graph. Uses an incremental scan by default; request a full scan only when the index is absent, incompatible, or explicitly required.",
      parameters: {
        force_full: {
          type: "boolean",
          description: "Force a full graph rebuild instead of the default smart incremental scan."
        }
      },
      output: { schema: toolOutcomeSchema, render: renderOutcome },
      timeoutMs: resolved.timeoutMs,
      execute: (args, exec) => {
        if (exec.agent !== state.agent) return Promise.resolve(failureOutcome("scan_dependencies", "agent_scope_mismatch", "This tool belongs to another agent session."));
        return toolCall(state, "scan_dependencies", () => client.capability("scan_dependencies", {
          force_full: args.force_full ?? false,
          project: state.project
        }, { cwd: state.project, signal: exec.signal }));
      }
    })));
    state.toolDisposers.push(state.agent.ctx.tools.register(defineTool({
      name: "query_dependencies",
      description: "Query who imports one file and which files it imports in the current session workspace dependency index. Run scan_dependencies first when the index is missing or stale.",
      parameters: {
        file_path: {
          type: "string",
          required: true,
          description: "Workspace-relative or absolute path inside the current session workspace."
        },
        depth: {
          type: "integer",
          description: "Traversal depth from 1 through 4. Defaults to 2."
        }
      },
      output: { schema: toolOutcomeSchema, render: renderOutcome },
      timeoutMs: resolved.timeoutMs,
      execute: (args, exec) => {
        if (exec.agent !== state.agent) return Promise.resolve(failureOutcome("query_dependencies", "agent_scope_mismatch", "This tool belongs to another agent session."));
        const depth = args.depth ?? 2;
        if (!Number.isSafeInteger(depth) || depth < 1 || depth > 4) {
          return Promise.resolve(failureOutcome("query_dependencies", "contract_field_invalid", "depth must be an integer from 1 through 4."));
        }
        return toolCall(state, "query_dependencies", () => client.capability("query_dependencies", {
          depth,
          file_path: args.file_path,
          project: state.project
        }, { cwd: state.project, signal: exec.signal }));
      }
    })));
  };
  const registerUpdateTool = (state) => {
    disposeUpdateTool(state);
    state.updateToolDisposer = state.agent.ctx.tools.register(defineTool({
      name: "update_fractal_document",
      description: "Apply one core-authorized compare-and-swap update to a .folder.md or root README.md candidate from the active fractal closeout. This is not a general file-writing tool.",
      parameters: {
        file_path: {
          type: "string",
          required: true,
          description: "Workspace-relative candidate path supplied by the current fractal closeout instruction."
        },
        content: {
          type: "string",
          required: true,
          description: "Complete final Markdown content for the authorized .folder.md or root README.md file."
        }
      },
      output: { schema: toolOutcomeSchema, render: renderOutcome },
      timeoutMs: resolved.timeoutMs,
      execute: async (args, exec) => {
        const pending = state.pending;
        if (exec.agent !== state.agent || pending === void 0) {
          return failureOutcome("update_fractal_document", "agent_scope_mismatch", "No authorized document closeout is active for this agent.");
        }
        if (!pending.candidates.has(args.file_path)) {
          return failureOutcome("update_fractal_document", "candidate_unauthorized", "The candidate path is not authorized for this closeout.");
        }
        if (pending.completed.has(args.file_path)) {
          return failureOutcome("update_fractal_document", "candidate_already_applied", "The candidate path was already applied.");
        }
        const contentBytes = Buffer.byteLength(args.content, "utf8");
        if (contentBytes < 1 || contentBytes > MAX_DOCUMENT_BYTES || args.content.includes("\0")) {
          return failureOutcome("update_fractal_document", "contract_field_invalid", "Document content must be non-empty UTF-8 Markdown no larger than 131072 bytes.");
        }
        const outcome = await toolCall(state, "update_fractal_document", () => client.capability("update_fractal_document", {
          closeout_request_id: pending.id,
          file_path: args.file_path,
          content: args.content
        }, { cwd: state.project, signal: exec.signal }));
        if (outcome.ok) pending.completed.add(args.file_path);
        return outcome;
      }
    }));
  };
  const ensureScope = async (state) => {
    if (state.scopeId !== void 0) return state.scopeId;
    if (state.automaticUnavailable) throw new CoreClientError("action_unavailable", "automatic fractal actions are unavailable");
    const result = await client.action("begin_change_scope", {
      ...envelope(state.sessionKey),
      cwd: state.project,
      scope_mode: "native_session"
    }, { cwd: state.project });
    const status = stringField(result, "status");
    const scopeId = stringField(result, "scope_id");
    if (status !== "created" && status !== "existing" || scopeId === void 0) {
      throw new CoreClientError(
        stringField(result, "reason_code") ?? "action_contract_mismatch",
        "fractal action core did not establish a change scope",
        result.retryable === true
      );
    }
    state.scopeId = scopeId;
    return scopeId;
  };
  const recordChange = async (state, path) => {
    const scopeId = await ensureScope(state);
    const result = await client.action("record_observed_change", {
      ...envelope(state.sessionKey),
      cwd: state.project,
      evidence_type: "native_success",
      file: path,
      scope_id: scopeId,
      tool_outcome: "success"
    }, { cwd: state.project });
    const status = stringField(result, "status");
    if (status !== "recorded" && status !== "duplicate" && status !== "ignored" && status !== "no_change") {
      throw new CoreClientError(
        stringField(result, "reason_code") ?? "action_contract_mismatch",
        "fractal action core rejected an observed change",
        status === "stale" || result.retryable === true
      );
    }
  };
  const completeCloseout = async (state, pending) => {
    const result = await client.capability("complete_closeout", {
      closeout_request_id: pending.id
    }, { cwd: state.project });
    if (!coreSucceeded("complete_closeout", result)) {
      warnOnce(state, `complete:${pending.id}`, `closeout ${pending.id} was not acknowledged by the shared core`);
      return false;
    }
    disposeUpdateTool(state);
    state.pending = void 0;
    return true;
  };
  const reconcileTurn = async (state, signal) => {
    if (!state.enabled || state.automaticUnavailable || signal.aborted) return;
    const pending = state.pending;
    if (pending !== void 0) {
      if (pending.completed.size === pending.candidates.size) await completeCloseout(state, pending);
      return;
    }
    const scopeId = await ensureScope(state);
    const result = await client.action("closeout_status", {
      ...envelope(state.sessionKey),
      completion_reason: "turn_complete",
      cwd: state.project,
      scope_id: scopeId
    }, { cwd: state.project, signal });
    const next = parsePendingCloseout(result);
    if (next === void 0) return;
    state.pending = next;
    registerUpdateTool(state);
    state.agent.steer(createUserMessage({
      content: [{ type: "text", text: closeoutInstruction(next) }],
      source: { kind: "plugin", plugin: name, form: "instructions" }
    }));
  };
  const disposeState = (state) => {
    if (state.disposed) return;
    state.disposed = true;
    disposeUpdateTool(state);
    for (const dispose of state.toolDisposers.splice(0)) dispose();
    states.delete(state);
  };
  const bindAgent = (agent) => {
    const cwd = agent.session.header.cwd;
    const preset = resolveSessionPreset(agent.session);
    const existing = stateByAgent.get(agent);
    if (existing !== void 0) {
      disposeUpdateTool(existing);
      for (const dispose of existing.toolDisposers.splice(0)) dispose();
      existing.enabled = typeof cwd === "string" && isAbsolute(cwd) && preset !== void 0 && resolved.enabledPresets.has(preset);
      if (existing.enabled) registerBaseTools(existing);
      if (existing.enabled && existing.pending !== void 0) registerUpdateTool(existing);
      return;
    }
    if (typeof cwd !== "string" || !isAbsolute(cwd)) return;
    const state = {
      agent,
      automaticUnavailable: false,
      disposed: false,
      enabled: preset !== void 0 && resolved.enabledPresets.has(preset),
      project: cwd,
      pending: void 0,
      queue: Promise.resolve(),
      scopeId: void 0,
      sessionKey: sessionKey(agent),
      toolDisposers: [],
      updateToolDisposer: void 0,
      warned: /* @__PURE__ */ new Set()
    };
    stateByAgent.set(agent, state);
    states.add(state);
    registerBaseTools(state);
  };
  ctx.on("agent/created", ({ agent }) => bindAgent(agent));
  ctx.on("agent-preset/selected", (id) => {
    const agent = ctx.agents.get(id);
    if (agent !== void 0) bindAgent(agent);
  });
  ctx.on("agent/session-start", ({ agent }) => {
    const state = stateByAgent.get(agent);
    if (state === void 0 || !state.enabled) return;
    void enqueue(state, async () => {
      await ensureScope(state);
      try {
        await client.capability("scan_dependencies", {
          force_full: false,
          project: state.project
        }, { cwd: state.project });
      } catch (error) {
        warnOnce(
          state,
          "scan",
          `dependency scan unavailable (${error instanceof CoreClientError ? error.code : "adapter_internal_error"})`
        );
      }
    }).catch((error) => {
      if (error instanceof CoreClientError && !error.retryable) state.automaticUnavailable = true;
      warnOnce(state, "begin", `automatic change scope unavailable (${error instanceof CoreClientError ? error.code : "adapter_internal_error"})`);
    });
  });
  ctx.on("tools/result", (exec, result) => {
    const touches = executionTouches.get(exec.token) ?? [];
    executionTouches.delete(exec.token);
    if (!result.isError && exec.agent !== void 0 && !exec.signal.aborted && (exec.name === "write" || exec.name === "edit") && typeof exec.arguments === "object" && exec.arguments !== null && "file_path" in exec.arguments && typeof exec.arguments.file_path === "string" && exec.arguments.file_path.trim().length > 0) {
      touches.push({ agent: exec.agent, path: exec.arguments.file_path.trim() });
    }
    if (exec.parent !== void 0) {
      if (touches.length > 0) {
        const parent = executionTouches.get(exec.parent);
        if (parent === void 0) executionTouches.set(exec.parent, touches);
        else parent.push(...touches);
      }
      return;
    }
    const unique = /* @__PURE__ */ new Map();
    for (const touch of touches) unique.set(`${String(touch.agent.id)}\0${touch.path}`, touch.agent);
    for (const [key, agent] of unique) {
      const path = key.slice(key.indexOf("\0") + 1);
      const state = stateByAgent.get(agent);
      if (state === void 0 || !state.enabled || state.automaticUnavailable) continue;
      void enqueue(state, () => recordChange(state, path)).catch((error) => {
        if (error instanceof CoreClientError && !error.retryable) state.automaticUnavailable = true;
        warnOnce(state, "record", `change observation unavailable (${error instanceof CoreClientError ? error.code : "adapter_internal_error"})`);
      });
    }
  });
  ctx.on("agent/turn-stopping", async ({ agent, signal }) => {
    const state = stateByAgent.get(agent);
    if (state === void 0 || !state.enabled) return;
    try {
      await enqueue(state, () => reconcileTurn(state, signal));
    } catch (error) {
      if (error instanceof CoreClientError && !error.retryable) state.automaticUnavailable = true;
      warnOnce(state, "closeout", `turn reconciliation unavailable (${error instanceof CoreClientError ? error.code : "adapter_internal_error"})`);
    }
  });
  ctx.on("agent/disposed", ({ agent }) => {
    const state = stateByAgent.get(agent);
    if (state !== void 0) disposeState(state);
  });
  ctx.effect(() => () => {
    for (const state of [...states]) disposeState(state);
  });
}
export {
  Config,
  CoreClient,
  CoreClientError,
  apply,
  inject,
  name,
  resolveDefaultCoreBins
};
