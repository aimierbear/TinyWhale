import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import LlmRuntime, { CallId, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import VerifierRuntime from '@deepseek-ai/dsh-verifier'
import * as conversation from '@deepseek-ai/dsh-verifier-conversation'
import * as tool from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

class LoaderAdapter extends LlmAdapter {
  override async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'text-delta', index: 0, text: '<score_A> A </score_A>\n<score_B> T </score_B>' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('tool-verifier Loader composition', () => {
  it('exposes verify through a Loader-mounted cordis.yml', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-verify-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-llm'",
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: '@deepseek-ai/dsh-verifier'",
      "- name: '@deepseek-ai/dsh-verifier-conversation'",
      "- name: '@deepseek-ai/dsh-tool-verifier'",
      '',
    ].join('\n'))

    context = new Context()
    context.baseUrl = `${pathToFileURL(root).href}/`
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-llm', LlmRuntime],
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
      ['@deepseek-ai/dsh-tools', ToolRuntime],
      ['@deepseek-ai/dsh-verifier', VerifierRuntime],
      ['@deepseek-ai/dsh-verifier-conversation', conversation],
      ['@deepseek-ai/dsh-tool-verifier', tool],
    ])
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await context.loader.await()
    expect('default' in tool).toBe(false)
    context.llm.registerAdapter(['mock'], new LoaderAdapter())
    const agent = {
      id: SessionId('loader'),
      session: Session.create(SessionId('loader')),
      options: { provider: 'mock', model: 'judge' },
    } as unknown as Agent
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('request/header', {
      reason: 'initial',
      header: { config: { provider: 'mock', model: 'judge' } },
    })
    const result = await context.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('verify-1'),
      name: 'verify',
      arguments: {
        mode: 'compare',
        problem: 'p',
        candidates: [
          { id: 'a', text: 'good' },
          { id: 'b', text: 'bad' },
        ],
        criteria: [{ name: 'Fit', description: 'Did it fit?' }],
        n_evaluations: 1,
      },
      agent,
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(result.value).toMatchObject({ kind: 'compare', winner: 'A' })
  })
})
