/** Strict, shell-free JSON subprocess boundary for the shared fractal core. */

import { spawn } from 'node:child_process'

export type JsonPrimitive = boolean | null | number | string
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[]
export interface JsonObject {
  [key: string]: JsonValue
}

export type ActionOperation =
  | 'begin_change_scope'
  | 'closeout_status'
  | 'record_observed_change'

export type CapabilityOperation =
  | 'complete_closeout'
  | 'query_dependencies'
  | 'scan_dependencies'
  | 'update_fractal_document'

export interface CoreClientOptions {
  readonly actionBin: string
  readonly capabilityBin: string
  readonly maxOutputBytes: number
  readonly timeoutMs: number
}

export interface CoreCallOptions {
  readonly cwd: string
  readonly signal?: AbortSignal
}

export class CoreClientError extends Error {
  readonly code: string
  readonly retryable: boolean

  constructor(code: string, message: string, retryable = false) {
    super(message)
    this.name = 'CoreClientError'
    this.code = code
    this.retryable = retryable
  }
}

const MAX_INPUT_BYTES = 1_048_576
const FORCE_KILL_DELAY_MS = 500

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Call the two stable core binaries without importing their implementation. */
export class CoreClient {
  readonly #options: CoreClientOptions

  constructor(options: CoreClientOptions) {
    this.#options = options
  }

  action(
    operation: ActionOperation,
    payload: JsonObject,
    options: CoreCallOptions,
  ): Promise<JsonObject> {
    return this.#call(this.#options.actionBin, operation, payload, options)
  }

  capability(
    operation: CapabilityOperation,
    payload: JsonObject,
    options: CoreCallOptions,
  ): Promise<JsonObject> {
    return this.#call(this.#options.capabilityBin, operation, payload, options)
  }

  #call(
    binary: string,
    operation: string,
    payload: JsonObject,
    options: CoreCallOptions,
  ): Promise<JsonObject> {
    if (options.signal?.aborted) {
      return Promise.reject(new CoreClientError('aborted', 'fractal core call was cancelled', true))
    }
    const input = Buffer.from(JSON.stringify(payload), 'utf8')
    if (input.byteLength > MAX_INPUT_BYTES) {
      return Promise.reject(new CoreClientError('input_too_large', 'fractal core input is too large'))
    }

    return new Promise<JsonObject>((resolve, reject) => {
      let aborted = false
      let forceTimer: NodeJS.Timeout | undefined
      let outputTooLarge = false
      let settled = false
      let timedOut = false
      let stdoutBytes = 0
      const stdout: Buffer[] = []

      const child = spawn(binary, [operation], {
        cwd: options.cwd,
        env: process.env,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })

      const cleanup = (): void => {
        clearTimeout(timeout)
        if (forceTimer !== undefined) clearTimeout(forceTimer)
        options.signal?.removeEventListener('abort', onAbort)
      }
      const fail = (error: CoreClientError): void => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }
      const succeed = (value: JsonObject): void => {
        if (settled) return
        settled = true
        cleanup()
        resolve(value)
      }
      const terminate = (): void => {
        child.kill('SIGTERM')
        forceTimer = setTimeout(() => child.kill('SIGKILL'), FORCE_KILL_DELAY_MS)
        forceTimer.unref()
      }
      const onAbort = (): void => {
        aborted = true
        terminate()
      }
      const timeout = setTimeout(() => {
        timedOut = true
        terminate()
      }, this.#options.timeoutMs)
      timeout.unref()
      options.signal?.addEventListener('abort', onAbort, { once: true })

      child.once('error', (error: NodeJS.ErrnoException) => {
        const missing = error.code === 'ENOENT'
        fail(new CoreClientError(
          missing ? 'binary_unavailable' : 'spawn_failed',
          missing ? 'configured fractal core binary is unavailable' : 'fractal core process could not start',
          true,
        ))
      })
      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength
        if (stdoutBytes > this.#options.maxOutputBytes) {
          outputTooLarge = true
          terminate()
          return
        }
        stdout.push(chunk)
      })
      child.stderr.resume()
      child.stdin.on('error', () => {
        // Exit and spawn events own the public failure; EPIPE is not a second error channel.
      })
      child.once('close', (code) => {
        if (settled) return
        if (aborted) {
          fail(new CoreClientError('aborted', 'fractal core call was cancelled', true))
          return
        }
        if (timedOut) {
          fail(new CoreClientError('timeout', 'fractal core call timed out', true))
          return
        }
        if (outputTooLarge) {
          fail(new CoreClientError('output_too_large', 'fractal core output is too large'))
          return
        }
        if (code !== 0) {
          fail(new CoreClientError('process_failed', 'fractal core rejected the operation', false))
          return
        }
        try {
          const decoded = Buffer.concat(stdout).toString('utf8').trim()
          const value: unknown = JSON.parse(decoded)
          if (!isJsonObject(value)) throw new TypeError('response is not an object')
          succeed(value)
        } catch {
          fail(new CoreClientError('invalid_output', 'fractal core returned invalid JSON'))
        }
      })

      child.stdin.end(input)
    })
  }
}
