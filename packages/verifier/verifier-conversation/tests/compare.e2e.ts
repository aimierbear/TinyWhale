import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import VerifierRuntime from '@deepseek-ai/dsh-verifier'
import * as conversation from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('verifier compare real API', () => {
  it('returns compare fields from one inline criterion', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmDeepSeek, { thinking: 'disabled' })
    await ctx.plugin(VerifierRuntime)
    await ctx.plugin(conversation, {
      judgeProvider: 'deepseek-official',
      judgeModel: 'deepseek-v4-flash',
      maxScoreTokens: 1024,
      maxAttempts: 1,
    })
    const session = Session.create(SessionId('verify-e2e'))
    session.append('turn/start', { turn: 1 })
    const result = await ctx.verifier.compare({ session, options: {} }, {
      problem: 'Print hello world.',
      candidates: [
        { id: 'good', text: 'The agent ran `echo hello world` and the terminal printed hello world.' },
        { id: 'bad', text: 'The agent said it was done without running any command.' },
      ],
      criteria: [{ id: 'evidence', name: 'Evidence', description: 'Prefer the trajectory that shows the required output.' }],
      groundTruthNote: 'Trust the terminal output.',
      nEvaluations: 1,
    })
    expect(result.kind).toBe('compare')
    expect(result.calls).toBe(1)
    expect(result.rA).toBeGreaterThanOrEqual(0)
    expect(result.rA).toBeLessThanOrEqual(1)
    expect(result.rB).toBeGreaterThanOrEqual(0)
    expect(result.rB).toBeLessThanOrEqual(1)
    expect(result.criteria).toHaveLength(1)
  }, 180_000)
})
