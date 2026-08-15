/** Cordis adapter that exposes shared fractal and graph capabilities per DSH agent. */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-agent-presets/types'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

import {
  CoreClient,
  CoreClientError,
  type JsonObject,
  type JsonValue,
} from './core-client.js'

export const name = 'dsh-fractal'
export const inject = ['agents', 'tools']

const ADAPTER_VERSION = '0.1.0'
const DEFAULT_PRESETS = ['standard', 'code', 'cordis'] as const
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576
const MAX_DOCUMENT_BYTES = 131_072
const MAX_DOCUMENT_CANDIDATES = 64
const HOME_ACTION_BIN = join(homedir(), '.local/bin/fractal-action')
const HOME_CAPABILITY_BIN = join(homedir(), '.local/bin/fractal-capability')
const BUNDLED_ACTION_BIN = fileURLToPath(new URL('../core/bin/fractal-action', import.meta.url))
const BUNDLED_CAPABILITY_BIN = fileURLToPath(new URL('../core/bin/fractal-capability', import.meta.url))

/** Closeout statuses that mean "nothing for this session to write". */
const IDLE_CLOSEOUT = new Set([
  'clean',
  'graph_reconciled',
  'duplicate',
  'needs_unowned_audit',
])

/**
 * Resolve the action/capability binaries for a packaged TinyWhale install.
 * Explicit config wins, then env, then the in-box 1.3 core, then ~/.local/bin.
 */
export function resolveDefaultCoreBins(env: NodeJS.ProcessEnv = process.env): {
  actionBin: string
  capabilityBin: string
} {
  return {
    actionBin: firstBin(env.FRACTAL_ACTION_BIN, BUNDLED_ACTION_BIN, HOME_ACTION_BIN),
    capabilityBin: firstBin(env.FRACTAL_CAPABILITY_BIN, BUNDLED_CAPABILITY_BIN, HOME_CAPABILITY_BIN),
  }
}

function firstBin(...candidates: Array<string | undefined>): string {
  const trimmed = candidates
    .filter((value): value is string => typeof value === 'string')
    .map(value => value.trim())
    .filter(value => value.length > 0)
  return trimmed.find(value => existsSync(value)) ?? trimmed[trimmed.length - 1] ?? HOME_ACTION_BIN
}

export interface Config {
  actionBin?: string
  capabilityBin?: string
  enabledPresets?: string[]
  maxOutputBytes?: number
  timeoutMs?: number
}

export const Config: z<Config> = z.object({
  actionBin: z.string().default(''),
  capabilityBin: z.string().default(''),
  enabledPresets: z.array(z.string()).default([...DEFAULT_PRESETS]),
  maxOutputBytes: z.number().step(1).min(1_024).max(DEFAULT_MAX_OUTPUT_BYTES).default(DEFAULT_MAX_OUTPUT_BYTES),
  timeoutMs: z.number().step(1).min(1).max(120_000).default(DEFAULT_TIMEOUT_MS),
})

interface ResolvedConfig {
  readonly actionBin: string
  readonly capabilityBin: string
  readonly enabledPresets: ReadonlySet<string>
  readonly maxOutputBytes: number
  readonly timeoutMs: number
}

interface DocumentCandidate {
  readonly filePath: string
}

interface PendingCloseout {
  readonly candidates: ReadonlyMap<string, DocumentCandidate>
  readonly completed: Set<string>
  readonly id: string
}

interface AgentState {
  readonly agent: Agent
  readonly project: string
  readonly sessionKey: string
  readonly toolDisposers: Array<() => void>
  automaticUnavailable: boolean
  disposed: boolean
  enabled: boolean
  pending: PendingCloseout | undefined
  queue: Promise<void>
  scopeId: string | undefined
  updateToolDisposer: (() => void) | undefined
  readonly warned: Set<string>
}

interface ToolOutcome {
  readonly error?: {
    readonly code: string
    readonly message: string
    readonly retryable: boolean
  }
  readonly ok: boolean
  readonly operation: string
  readonly result?: JsonValue
}

const toolOutcomeSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    operation: { type: 'string', required: true },
    result: { type: 'json' },
    error: {
      type: 'object',
      additionalProperties: false,
      properties: {
        code: { type: 'string', required: true },
        message: { type: 'string', required: true },
        retryable: { type: 'boolean', required: true },
      },
    },
  },
} as const

function resolveConfig(config: Config): ResolvedConfig {
  const defaults = resolveDefaultCoreBins()
  const actionBin = config.actionBin?.trim() || defaults.actionBin
  const capabilityBin = config.capabilityBin?.trim() || defaults.capabilityBin
  const presets = config.enabledPresets ?? [...DEFAULT_PRESETS]
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxOutputBytes = config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new TypeError('dsh-fractal timeoutMs must be an integer between 1 and 120000')
  }
  if (!Number.isSafeInteger(maxOutputBytes)
    || maxOutputBytes < 1_024
    || maxOutputBytes > DEFAULT_MAX_OUTPUT_BYTES) {
    throw new TypeError('dsh-fractal maxOutputBytes must be an integer between 1024 and 1048576')
  }
  if (presets.some(preset => preset.trim().length === 0)) {
    throw new TypeError('dsh-fractal enabledPresets cannot contain a blank id')
  }
  return {
    actionBin,
    capabilityBin,
    enabledPresets: new Set(presets),
    maxOutputBytes,
    timeoutMs,
  }
}

function envelope(sessionKey: string): JsonObject {
  return {
    adapter_version: ADAPTER_VERSION,
    contract_version: 1,
    occurred_at: new Date().toISOString(),
    operation_id: randomUUID(),
    runtime_id: 'dsh',
    session_id: sessionKey,
  }
}

function sessionKey(agent: Agent): string {
  return createHash('sha256').update(String(agent.id), 'utf8').digest('hex')
}

function stringField(value: JsonObject, key: string): string | undefined {
  const field = value[key]
  return typeof field === 'string' && field.length > 0 ? field : undefined
}

function coreSucceeded(operation: string, value: JsonObject): boolean {
  const status = stringField(value, 'status')
  switch (operation) {
    case 'scan_dependencies':
    case 'query_dependencies':
      return status === 'ok'
    case 'update_fractal_document':
      return status === 'updated' || status === 'no_change'
    case 'complete_closeout':
      return status === 'acknowledged' || status === 'duplicate'
    default:
      return false
  }
}

function successOutcome(operation: string, result: JsonObject): ToolOutcome {
  return { ok: true, operation, result }
}

function failureOutcome(
  operation: string,
  code: string,
  message: string,
  retryable = false,
): ToolOutcome {
  return { ok: false, operation, error: { code, message, retryable } }
}

function responseOutcome(operation: string, result: JsonObject): ToolOutcome {
  if (coreSucceeded(operation, result)) return successOutcome(operation, result)
  return failureOutcome(
    operation,
    stringField(result, 'reason_code') ?? 'capability_unavailable',
    `Shared fractal capability ${operation} did not complete.`,
    result.retryable === true,
  )
}

function errorOutcome(operation: string, error: unknown): ToolOutcome {
  if (error instanceof CoreClientError) {
    return failureOutcome(operation, error.code, error.message, error.retryable)
  }
  return failureOutcome(operation, 'adapter_internal_error', 'The fractal adapter could not complete the operation.')
}

function renderOutcome(_args: unknown, value: ToolOutcome): Array<{ type: 'text'; text: string }> {
  if (!value.ok) {
    return [{ type: 'text', text: `Fractal operation ${value.operation} unavailable: ${value.error?.code ?? 'unknown'}.` }]
  }
  return [{ type: 'text', text: JSON.stringify(value.result) }]
}

function safeCandidatePath(value: string): boolean {
  return value.length > 0
    && value.length <= 4_096
    && !isAbsolute(value)
    && !value.includes('\\')
    && !/[\u0000-\u001f\u007f]/u.test(value)
    && !value.split('/').includes('..')
    && (posix.basename(value) === '.folder.md' || value === 'README.md')
}

function parsePendingCloseout(value: JsonObject): PendingCloseout | undefined {
  const status = stringField(value, 'status')
  if (status !== undefined && IDLE_CLOSEOUT.has(status)) {
    const rawCandidates = value.document_candidates
    if (rawCandidates !== undefined
      && (!Array.isArray(rawCandidates) || rawCandidates.length > 0)) {
      throw new CoreClientError('action_contract_mismatch', 'completed closeout response contains document candidates')
    }
    return undefined
  }
  if (status === 'stale') {
    throw new CoreClientError(
      stringField(value, 'reason_code') ?? 'state_watermark_stale',
      'fractal closeout state changed before reconciliation completed',
      true,
    )
  }
  if (status !== 'needs_closeout' && status !== 'already_reminded') {
    throw new CoreClientError(
      stringField(value, 'reason_code') ?? 'action_contract_mismatch',
      'fractal action core returned an unknown closeout status',
      value.retryable === true,
    )
  }
  const id = stringField(value, 'closeout_request_id')
  if (id === undefined || id.length > 96 || /[\u0000-\u001f\u007f]/u.test(id)) {
    throw new CoreClientError('action_contract_mismatch', 'closeout response has an invalid closeout_request_id')
  }
  const rawCandidates = value.document_candidates
  if (!Array.isArray(rawCandidates)
    || rawCandidates.length === 0
    || rawCandidates.length > MAX_DOCUMENT_CANDIDATES) {
    throw new CoreClientError('action_contract_mismatch', 'closeout response has invalid document_candidates')
  }
  const candidates = new Map<string, DocumentCandidate>()
  const paths = new Set<string>()
  const tokens = new Set<string>()
  for (const raw of rawCandidates) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new CoreClientError('action_contract_mismatch', 'closeout response has an invalid document candidate')
    }
    const candidate = raw as Record<string, unknown>
    const candidateToken = candidate.candidate_token
    const expectedSha256 = candidate.expected_sha256
    const filePath = candidate.file_path
    if (typeof candidateToken !== 'string'
      || candidateToken.length === 0
      || candidateToken.length > 4_096
      || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(candidateToken)
      || typeof expectedSha256 !== 'string'
      || (expectedSha256 !== 'missing' && !/^[0-9a-f]{64}$/u.test(expectedSha256))
      || typeof filePath !== 'string' || !safeCandidatePath(filePath)
      || tokens.has(candidateToken) || paths.has(filePath)) {
      throw new CoreClientError('action_contract_mismatch', 'closeout response has an invalid document candidate')
    }
    const normalized = { filePath }
    candidates.set(filePath, normalized)
    paths.add(filePath)
    tokens.add(candidateToken)
  }
  return { candidates, completed: new Set(), id }
}

function closeoutInstruction(pending: PendingCloseout): string {
  const candidates = [...pending.candidates.values()]
    .map(candidate => `- ${candidate.filePath}`)
    .join('\n')
  return [
    'The shared fractal core found semantic folder documents that require a targeted update.',
    'Update only the authorized candidates below. Preserve useful human-written constraints, use source and dependency evidence, and write complete final Markdown with update_fractal_document.',
    candidates,
    'Call update_fractal_document once for every candidate path, then stop. Do not modify other files as part of this synchronization.',
  ].join('\n\n')
}

/** Install the adapter in one DSH runtime. */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  const client = new CoreClient(resolved)
  const states = new Set<AgentState>()
  const stateByAgent = new WeakMap<Agent, AgentState>()
  const executionTouches = new Map<unknown, Array<{ agent: Agent; path: string }>>()

  const warnOnce = (state: AgentState, key: string, message: string): void => {
    if (state.warned.has(key)) return
    state.warned.add(key)
    ctx.logger.warn(`dsh-fractal: ${message}`)
  }

  const enqueue = <T>(state: AgentState, work: () => Promise<T>): Promise<T> => {
    const run = state.queue.then(async () => {
      if (state.disposed) throw new CoreClientError('agent_disposed', 'agent was disposed')
      return work()
    })
    state.queue = run.then(() => undefined, () => undefined)
    return run
  }

  const toolCall = async (
    state: AgentState,
    operation: string,
    work: () => Promise<JsonObject>,
  ): Promise<ToolOutcome> => {
    try {
      return responseOutcome(operation, await enqueue(state, work))
    } catch (error) {
      return errorOutcome(operation, error)
    }
  }

  const disposeUpdateTool = (state: AgentState): void => {
    const dispose = state.updateToolDisposer
    state.updateToolDisposer = undefined
    if (dispose !== undefined) dispose()
  }

  const registerBaseTools = (state: AgentState): void => {
    if (!state.enabled) return
    state.toolDisposers.push(state.agent.ctx.tools.register(defineTool({
      name: 'scan_dependencies',
      description: 'Refresh the current session workspace dependency graph. Uses an incremental scan by default; request a full scan only when the index is absent, incompatible, or explicitly required.',
      parameters: {
        force_full: {
          type: 'boolean',
          description: 'Force a full graph rebuild instead of the default smart incremental scan.',
        },
      },
      output: { schema: toolOutcomeSchema, render: renderOutcome },
      timeoutMs: resolved.timeoutMs,
      execute: (args, exec) => {
        if (exec.agent !== state.agent) return Promise.resolve(failureOutcome('scan_dependencies', 'agent_scope_mismatch', 'This tool belongs to another agent session.'))
        return toolCall(state, 'scan_dependencies', () => client.capability('scan_dependencies', {
          force_full: args.force_full ?? false,
          project: state.project,
        }, { cwd: state.project, signal: exec.signal }))
      },
    })))
    state.toolDisposers.push(state.agent.ctx.tools.register(defineTool({
      name: 'query_dependencies',
      description: 'Query who imports one file and which files it imports in the current session workspace dependency index. Run scan_dependencies first when the index is missing or stale.',
      parameters: {
        file_path: {
          type: 'string',
          required: true,
          description: 'Workspace-relative or absolute path inside the current session workspace.',
        },
        depth: {
          type: 'integer',
          description: 'Traversal depth from 1 through 4. Defaults to 2.',
        },
      },
      output: { schema: toolOutcomeSchema, render: renderOutcome },
      timeoutMs: resolved.timeoutMs,
      execute: (args, exec) => {
        if (exec.agent !== state.agent) return Promise.resolve(failureOutcome('query_dependencies', 'agent_scope_mismatch', 'This tool belongs to another agent session.'))
        const depth = args.depth ?? 2
        if (!Number.isSafeInteger(depth) || depth < 1 || depth > 4) {
          return Promise.resolve(failureOutcome('query_dependencies', 'contract_field_invalid', 'depth must be an integer from 1 through 4.'))
        }
        return toolCall(state, 'query_dependencies', () => client.capability('query_dependencies', {
          depth,
          file_path: args.file_path,
          project: state.project,
        }, { cwd: state.project, signal: exec.signal }))
      },
    })))
  }

  const registerUpdateTool = (state: AgentState): void => {
    disposeUpdateTool(state)
    state.updateToolDisposer = state.agent.ctx.tools.register(defineTool({
      name: 'update_fractal_document',
      description: 'Apply one core-authorized compare-and-swap update to a .folder.md or root README.md candidate from the active fractal closeout. This is not a general file-writing tool.',
      parameters: {
        file_path: {
          type: 'string',
          required: true,
          description: 'Workspace-relative candidate path supplied by the current fractal closeout instruction.',
        },
        content: {
          type: 'string',
          required: true,
          description: 'Complete final Markdown content for the authorized .folder.md or root README.md file.',
        },
      },
      output: { schema: toolOutcomeSchema, render: renderOutcome },
      timeoutMs: resolved.timeoutMs,
      execute: async (args, exec) => {
        const pending = state.pending
        if (exec.agent !== state.agent || pending === undefined) {
          return failureOutcome('update_fractal_document', 'agent_scope_mismatch', 'No authorized document closeout is active for this agent.')
        }
        if (!pending.candidates.has(args.file_path)) {
          return failureOutcome('update_fractal_document', 'candidate_unauthorized', 'The candidate path is not authorized for this closeout.')
        }
        if (pending.completed.has(args.file_path)) {
          return failureOutcome('update_fractal_document', 'candidate_already_applied', 'The candidate path was already applied.')
        }
        const contentBytes = Buffer.byteLength(args.content, 'utf8')
        if (contentBytes < 1 || contentBytes > MAX_DOCUMENT_BYTES || args.content.includes('\0')) {
          return failureOutcome('update_fractal_document', 'contract_field_invalid', 'Document content must be non-empty UTF-8 Markdown no larger than 131072 bytes.')
        }
        const outcome = await toolCall(state, 'update_fractal_document', () => client.capability('update_fractal_document', {
          closeout_request_id: pending.id,
          file_path: args.file_path,
          content: args.content,
        }, { cwd: state.project, signal: exec.signal }))
        if (outcome.ok) pending.completed.add(args.file_path)
        return outcome
      },
    }))
  }

  const ensureScope = async (state: AgentState): Promise<string> => {
    if (state.scopeId !== undefined) return state.scopeId
    if (state.automaticUnavailable) throw new CoreClientError('action_unavailable', 'automatic fractal actions are unavailable')
    const result = await client.action('begin_change_scope', {
      ...envelope(state.sessionKey),
      cwd: state.project,
      scope_mode: 'native_session',
    }, { cwd: state.project })
    const status = stringField(result, 'status')
    const scopeId = stringField(result, 'scope_id')
    if ((status !== 'created' && status !== 'existing') || scopeId === undefined) {
      throw new CoreClientError(
        stringField(result, 'reason_code') ?? 'action_contract_mismatch',
        'fractal action core did not establish a change scope',
        result.retryable === true,
      )
    }
    state.scopeId = scopeId
    return scopeId
  }

  const recordChange = async (state: AgentState, path: string): Promise<void> => {
    const scopeId = await ensureScope(state)
    const result = await client.action('record_observed_change', {
      ...envelope(state.sessionKey),
      cwd: state.project,
      evidence_type: 'native_success',
      file: path,
      scope_id: scopeId,
      tool_outcome: 'success',
    }, { cwd: state.project })
    const status = stringField(result, 'status')
    if (status !== 'recorded'
      && status !== 'duplicate'
      && status !== 'ignored'
      && status !== 'no_change') {
      throw new CoreClientError(
        stringField(result, 'reason_code') ?? 'action_contract_mismatch',
        'fractal action core rejected an observed change',
        status === 'stale' || result.retryable === true,
      )
    }
  }

  const completeCloseout = async (state: AgentState, pending: PendingCloseout): Promise<boolean> => {
    const result = await client.capability('complete_closeout', {
      closeout_request_id: pending.id,
    }, { cwd: state.project })
    if (!coreSucceeded('complete_closeout', result)) {
      warnOnce(state, `complete:${pending.id}`, `closeout ${pending.id} was not acknowledged by the shared core`)
      return false
    }
    disposeUpdateTool(state)
    state.pending = undefined
    return true
  }

  const reconcileTurn = async (state: AgentState, signal: AbortSignal): Promise<void> => {
    if (!state.enabled || state.automaticUnavailable || signal.aborted) return
    const pending = state.pending
    if (pending !== undefined) {
      if (pending.completed.size === pending.candidates.size) await completeCloseout(state, pending)
      return
    }
    const scopeId = await ensureScope(state)
    const result = await client.action('closeout_status', {
      ...envelope(state.sessionKey),
      completion_reason: 'turn_complete',
      cwd: state.project,
      scope_id: scopeId,
    }, { cwd: state.project, signal })
    const next = parsePendingCloseout(result)
    if (next === undefined) return
    state.pending = next
    registerUpdateTool(state)
    state.agent.steer(createUserMessage({
      content: [{ type: 'text', text: closeoutInstruction(next) }],
      source: { kind: 'plugin', plugin: name, form: 'instructions' },
    }))
  }

  const disposeState = (state: AgentState): void => {
    if (state.disposed) return
    state.disposed = true
    disposeUpdateTool(state)
    for (const dispose of state.toolDisposers.splice(0)) dispose()
    states.delete(state)
  }

  const bindAgent = (agent: Agent): void => {
    const cwd = agent.session.header.cwd
    const preset = resolveSessionPreset(agent.session)
    const existing = stateByAgent.get(agent)
    if (existing !== undefined) {
      disposeUpdateTool(existing)
      for (const dispose of existing.toolDisposers.splice(0)) dispose()
      existing.enabled = typeof cwd === 'string'
        && isAbsolute(cwd)
        && preset !== undefined
        && resolved.enabledPresets.has(preset)
      if (existing.enabled) registerBaseTools(existing)
      if (existing.enabled && existing.pending !== undefined) registerUpdateTool(existing)
      return
    }
    if (typeof cwd !== 'string' || !isAbsolute(cwd)) return
    const state: AgentState = {
      agent,
      automaticUnavailable: false,
      disposed: false,
      enabled: preset !== undefined && resolved.enabledPresets.has(preset),
      project: cwd,
      pending: undefined,
      queue: Promise.resolve(),
      scopeId: undefined,
      sessionKey: sessionKey(agent),
      toolDisposers: [],
      updateToolDisposer: undefined,
      warned: new Set(),
    }
    stateByAgent.set(agent, state)
    states.add(state)
    registerBaseTools(state)
  }

  ctx.on('agent/created', ({ agent }) => bindAgent(agent))
  ctx.on('agent-preset/selected', (id) => {
    const agent = ctx.agents.get(id)
    if (agent !== undefined) bindAgent(agent)
  })
  ctx.on('agent/session-start', ({ agent }) => {
    const state = stateByAgent.get(agent)
    if (state === undefined || !state.enabled) return
    void enqueue(state, async () => {
      await ensureScope(state)
      // Warm the graph off the SessionStart hot path so closeout review and
      // query_dependencies see an index. Failures stay retryable.
      try {
        await client.capability('scan_dependencies', {
          force_full: false,
          project: state.project,
        }, { cwd: state.project })
      } catch (error) {
        warnOnce(
          state,
          'scan',
          `dependency scan unavailable (${error instanceof CoreClientError ? error.code : 'adapter_internal_error'})`,
        )
      }
    }).catch((error: unknown) => {
      if (error instanceof CoreClientError && !error.retryable) state.automaticUnavailable = true
      warnOnce(state, 'begin', `automatic change scope unavailable (${error instanceof CoreClientError ? error.code : 'adapter_internal_error'})`)
    })
  })
  ctx.on('tools/result', (exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>) => {
    const touches = executionTouches.get(exec.token) ?? []
    executionTouches.delete(exec.token)
    if (!result.isError && exec.agent !== undefined && !exec.signal.aborted
      && (exec.name === 'write' || exec.name === 'edit')
      && typeof exec.arguments === 'object' && exec.arguments !== null
      && 'file_path' in exec.arguments && typeof exec.arguments.file_path === 'string'
      && exec.arguments.file_path.trim().length > 0) {
      touches.push({ agent: exec.agent, path: exec.arguments.file_path.trim() })
    }
    if (exec.parent !== undefined) {
      if (touches.length > 0) {
        const parent = executionTouches.get(exec.parent)
        if (parent === undefined) executionTouches.set(exec.parent, touches)
        else parent.push(...touches)
      }
      return
    }
    const unique = new Map<string, Agent>()
    for (const touch of touches) unique.set(`${String(touch.agent.id)}\0${touch.path}`, touch.agent)
    for (const [key, agent] of unique) {
      const path = key.slice(key.indexOf('\0') + 1)
      const state = stateByAgent.get(agent)
      if (state === undefined || !state.enabled || state.automaticUnavailable) continue
      void enqueue(state, () => recordChange(state, path)).catch((error: unknown) => {
        if (error instanceof CoreClientError && !error.retryable) state.automaticUnavailable = true
        warnOnce(state, 'record', `change observation unavailable (${error instanceof CoreClientError ? error.code : 'adapter_internal_error'})`)
      })
    }
  })
  ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
    const state = stateByAgent.get(agent)
    if (state === undefined || !state.enabled) return
    try {
      await enqueue(state, () => reconcileTurn(state, signal))
    } catch (error) {
      if (error instanceof CoreClientError && !error.retryable) state.automaticUnavailable = true
      warnOnce(state, 'closeout', `turn reconciliation unavailable (${error instanceof CoreClientError ? error.code : 'adapter_internal_error'})`)
    }
  })
  ctx.on('agent/disposed', ({ agent }) => {
    const state = stateByAgent.get(agent)
    if (state !== undefined) disposeState(state)
  })
  ctx.effect(() => () => {
    for (const state of [...states]) disposeState(state)
  })
}

export { CoreClient, CoreClientError }
