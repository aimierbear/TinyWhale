import { spawn } from "node:child_process";
class CoreClientError extends Error {
  code;
  retryable;
  constructor(code, message, retryable = false) {
    super(message);
    this.name = "CoreClientError";
    this.code = code;
    this.retryable = retryable;
  }
}
const MAX_INPUT_BYTES = 1048576;
const FORCE_KILL_DELAY_MS = 500;
function isJsonObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
class CoreClient {
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
}
export {
  CoreClient,
  CoreClientError
};
