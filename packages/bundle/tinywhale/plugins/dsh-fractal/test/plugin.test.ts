import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import { apply, resolveDefaultCoreBins } from '../src/index.js'

const fixtures = new URL('./fixtures/', import.meta.url)
const actionBin = new URL('mock-action.mjs', fixtures).pathname
const capabilityBin = new URL('mock-capability.mjs', fixtures).pathname

interface FakeRuntime {
  readonly agents: Map<string, Agent>
  readonly cleanups: Array<() => void>
  readonly handlers: Map<string, Array<(...args: any[]) => any>>
  readonly warnings: string[]
}

function fakeContext(runtime: FakeRuntime): Context {
  return {
    agents: { get: (id: unknown) => runtime.agents.get(String(id)) },
    effect: (setup: () => (() => void)) => {
      runtime.cleanups.push(setup())
    },
    logger: { warn: (message: unknown) => runtime.warnings.push(String(message)) },
    on: (event: string, handler: (...args: any[]) => any) => {
      const handlers = runtime.handlers.get(event) ?? []
      handlers.push(handler)
      runtime.handlers.set(event, handlers)
      return () => {
        const index = handlers.indexOf(handler)
        if (index >= 0) handlers.splice(index, 1)
      }
    },
  } as unknown as Context
}

function fakeAgent(id: string, cwd: string, preset: string) {
  const tools = new Map<string, ToolDefinition>()
  const steering: unknown[] = []
  const agent = {
    id,
    session: { header: { id, cwd, agentPreset: preset }, events: [] },
    ctx: {
      tools: {
        register: (definition: ToolDefinition) => {
          tools.set(definition.name, definition)
          return () => { tools.delete(definition.name) }
        },
      },
    },
    steer: (message: unknown) => steering.push(message),
  } as unknown as Agent
  return { agent, steering, tools }
}

async function emit(runtime: FakeRuntime, event: string, ...args: unknown[]): Promise<void> {
  for (const handler of runtime.handlers.get(event) ?? []) await handler(...args)
}

function execution(agent: Agent, name: string, args: unknown) {
  return {
    agent,
    arguments: args,
    callId: `${name}-call`,
    name,
    rootCallId: `${name}-call`,
    signal: new AbortController().signal,
    token: Symbol(name),
  } as any
}

test('preset gating exposes graph tools but keeps Minimal empty', async () => {
  await Promise.all([chmod(actionBin, 0o755), chmod(capabilityBin, 0o755)])
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-fractal-plugin-'))
  const runtime: FakeRuntime = { agents: new Map(), cleanups: [], handlers: new Map(), warnings: [] }
  apply(fakeContext(runtime), { actionBin, capabilityBin, timeoutMs: 2_000 })
  const standard = fakeAgent('standard-agent', cwd, 'standard')
  const minimal = fakeAgent('minimal-agent', cwd, 'minimal')
  runtime.agents.set('standard-agent', standard.agent)
  runtime.agents.set('minimal-agent', minimal.agent)

  await emit(runtime, 'agent/created', { agent: standard.agent })
  await emit(runtime, 'agent/created', { agent: minimal.agent })

  assert.deepEqual([...standard.tools.keys()].sort(), ['query_dependencies', 'scan_dependencies'])
  assert.deepEqual([...minimal.tools.keys()], [])
  for (const definition of standard.tools.values()) {
    assert.ok(definition.output.schema)
    assert.equal(typeof definition.output.render, 'function')
  }
  assert.equal((await standard.tools.get('scan_dependencies')!.execute(
    {},
    execution(standard.agent, 'scan_dependencies', {}) as any,
  ) as any).ok, true)
  assert.equal((await standard.tools.get('query_dependencies')!.execute(
    { file_path: 'src/a.ts', depth: 2 },
    execution(standard.agent, 'query_dependencies', {}) as any,
  ) as any).ok, true)
  for (const cleanup of runtime.cleanups) cleanup()
})

test('successful write is serialized before closeout and opens one temporary document tool', async () => {
  await Promise.all([chmod(actionBin, 0o755), chmod(capabilityBin, 0o755)])
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-fractal-plugin-'))
  const trace = join(cwd, 'trace.jsonl')
  process.env.DSH_FRACTAL_MOCK_TRACE = trace
  const runtime: FakeRuntime = { agents: new Map(), cleanups: [], handlers: new Map(), warnings: [] }
  apply(fakeContext(runtime), { actionBin, capabilityBin, timeoutMs: 2_000 })
  const standard = fakeAgent('agent-1', cwd, 'standard')
  runtime.agents.set('agent-1', standard.agent)
  await emit(runtime, 'agent/created', { agent: standard.agent })
  await emit(runtime, 'agent/session-start', { agent: standard.agent, source: 'startup' })

  const write = execution(standard.agent, 'write', { file_path: 'src/a.ts' })
  await emit(runtime, 'tools/result', write, { isError: false, value: {}, content: [] })
  const failedEdit = execution(standard.agent, 'edit', { file_path: 'src/failed.ts' })
  await emit(runtime, 'tools/result', failedEdit, { isError: true, error: {}, content: [] })
  await emit(runtime, 'agent/turn-stopping', {
    agent: standard.agent,
    signal: new AbortController().signal,
    turn: 1,
  })

  assert.ok(standard.tools.has('update_fractal_document'))
  assert.equal(standard.steering.length, 1)
  const update = standard.tools.get('update_fractal_document')
  assert.ok(update?.output.schema)
  assert.equal(typeof update?.output.render, 'function')
  const updateResult = await update!.execute({
    file_path: 'src/.folder.md',
    content: '# Folder: /src\n\n1. **地位**：测试。\n',
  }, execution(standard.agent, 'update_fractal_document', {}) as any)
  assert.equal((updateResult as any).ok, true)

  await emit(runtime, 'agent/turn-stopping', {
    agent: standard.agent,
    signal: new AbortController().signal,
    turn: 1,
  })
  assert.equal(standard.tools.has('update_fractal_document'), false)

  const events = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(events.map(event => event.operation), [
    'begin_change_scope',
    'scan_dependencies',
    'record_observed_change',
    'closeout_status',
    'update_fractal_document',
    'complete_closeout',
  ])
  assert.deepEqual(events[4].input, {
    closeout_request_id: 'closeout_mock',
    file_path: 'src/.folder.md',
    content: '# Folder: /src\n\n1. **地位**：测试。\n',
  })
  assert.equal(events[2].input.file, 'src/a.ts')
  const canonicalCwd = await realpath(cwd)
  assert.equal(events.every(event => event.cwd === canonicalCwd), true)
  assert.equal(events.some(event => event.input.file === 'src/failed.ts'), false)
  assert.equal(events[5].input.closeout_request_id, 'closeout_mock')
  delete process.env.DSH_FRACTAL_MOCK_TRACE
  for (const cleanup of runtime.cleanups) cleanup()
})

test('a write from an interrupted turn is reconciled on the next successful stop', async () => {
  await Promise.all([chmod(actionBin, 0o755), chmod(capabilityBin, 0o755)])
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-fractal-plugin-'))
  const trace = join(cwd, 'trace.jsonl')
  process.env.DSH_FRACTAL_MOCK_TRACE = trace
  const runtime: FakeRuntime = { agents: new Map(), cleanups: [], handlers: new Map(), warnings: [] }
  try {
    apply(fakeContext(runtime), { actionBin, capabilityBin, timeoutMs: 2_000 })
    const standard = fakeAgent('agent-resume', cwd, 'standard')
    runtime.agents.set('agent-resume', standard.agent)
    await emit(runtime, 'agent/created', { agent: standard.agent })
    await emit(runtime, 'agent/session-start', { agent: standard.agent, source: 'startup' })

    const write = execution(standard.agent, 'write', { file_path: 'src/interrupted.ts' })
    await emit(runtime, 'tools/result', write, { isError: false, value: {}, content: [] })
    // Error and cancellation paths do not emit agent/turn-stopping. A later
    // successful turn in the same durable Agent must still consume the scope.
    await emit(runtime, 'agent/session-start', { agent: standard.agent, source: 'resume' })
    await emit(runtime, 'agent/turn-stopping', {
      agent: standard.agent,
      signal: new AbortController().signal,
      turn: 2,
    })

    assert.ok(standard.tools.has('update_fractal_document'))
    assert.equal(standard.steering.length, 1)
    const events = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(events.map(event => event.operation), [
      'begin_change_scope',
      'scan_dependencies',
      'record_observed_change',
      'scan_dependencies',
      'closeout_status',
    ])
    assert.equal(events[2].input.file, 'src/interrupted.ts')
  } finally {
    delete process.env.DSH_FRACTAL_MOCK_TRACE
    for (const cleanup of runtime.cleanups) cleanup()
  }
})

test('needs_unowned_audit is an idle closeout and does not disable automatic actions', async () => {
  await Promise.all([chmod(actionBin, 0o755), chmod(capabilityBin, 0o755)])
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-fractal-plugin-'))
  const runtime: FakeRuntime = { agents: new Map(), cleanups: [], handlers: new Map(), warnings: [] }
  process.env.DSH_FRACTAL_MOCK_CLOSEOUT = 'unowned'
  try {
    apply(fakeContext(runtime), { actionBin, capabilityBin, timeoutMs: 2_000 })
    const standard = fakeAgent('agent-unowned', cwd, 'standard')
    runtime.agents.set('agent-unowned', standard.agent)
    await emit(runtime, 'agent/created', { agent: standard.agent })
    await emit(runtime, 'agent/session-start', { agent: standard.agent, source: 'startup' })
    await emit(runtime, 'agent/turn-stopping', {
      agent: standard.agent,
      signal: new AbortController().signal,
      turn: 1,
    })
    assert.equal(standard.tools.has('update_fractal_document'), false)
    assert.equal(standard.steering.length, 0)
    assert.equal(runtime.warnings.some(message => message.includes('unowned')), false)
    assert.equal(runtime.warnings.some(message => message.includes('unavailable')), false)
  } finally {
    delete process.env.DSH_FRACTAL_MOCK_CLOSEOUT
    for (const cleanup of runtime.cleanups) cleanup()
  }
})

test('default bins prefer the shipped core when present', () => {
  const bins = resolveDefaultCoreBins({})
  assert.match(bins.actionBin, /core\/bin\/fractal-action$/)
  assert.match(bins.capabilityBin, /core\/bin\/fractal-capability$/)
})

test('unknown or incomplete closeout responses fail closed without exposing the writer', async () => {
  await Promise.all([chmod(actionBin, 0o755), chmod(capabilityBin, 0o755)])
  for (const scenario of ['unknown', 'missing_candidates']) {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-fractal-plugin-'))
    const runtime: FakeRuntime = { agents: new Map(), cleanups: [], handlers: new Map(), warnings: [] }
    process.env.DSH_FRACTAL_MOCK_CLOSEOUT = scenario
    try {
      apply(fakeContext(runtime), { actionBin, capabilityBin, timeoutMs: 2_000 })
      const standard = fakeAgent(`agent-${scenario}`, cwd, 'standard')
      runtime.agents.set(`agent-${scenario}`, standard.agent)
      await emit(runtime, 'agent/created', { agent: standard.agent })
      await emit(runtime, 'agent/session-start', { agent: standard.agent, source: 'startup' })
      await emit(runtime, 'agent/turn-stopping', {
        agent: standard.agent,
        signal: new AbortController().signal,
        turn: 1,
      })
      assert.equal(standard.tools.has('update_fractal_document'), false)
      assert.equal(standard.steering.length, 0)
      assert.equal(runtime.warnings.some(message => message.includes('action_contract_mismatch')), true)
    } finally {
      delete process.env.DSH_FRACTAL_MOCK_CLOSEOUT
      for (const cleanup of runtime.cleanups) cleanup()
    }
  }
})

test('missing capability binary returns a fail-closed tool result', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-fractal-plugin-'))
  const runtime: FakeRuntime = { agents: new Map(), cleanups: [], handlers: new Map(), warnings: [] }
  apply(fakeContext(runtime), { actionBin, capabilityBin: join(cwd, 'missing'), timeoutMs: 2_000 })
  const standard = fakeAgent('agent-2', cwd, 'standard')
  runtime.agents.set('agent-2', standard.agent)
  await emit(runtime, 'agent/created', { agent: standard.agent })
  const scan = standard.tools.get('scan_dependencies')
  const result = await scan!.execute({}, execution(standard.agent, 'scan_dependencies', {}) as any)
  assert.deepEqual(result, {
    ok: false,
    operation: 'scan_dependencies',
    error: {
      code: 'binary_unavailable',
      message: 'configured fractal core binary is unavailable',
      retryable: true,
    },
  })
  for (const cleanup of runtime.cleanups) cleanup()
})
