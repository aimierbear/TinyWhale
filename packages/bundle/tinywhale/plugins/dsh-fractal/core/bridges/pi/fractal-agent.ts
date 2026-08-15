/**
 * FRACTAL_OWNER: __FRACTAL_OWNER__
 * Global Pi bridge for the versioned fractal action backend.
 */
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

const HOOK = __FRACTAL_HOOK_JSON__
const RUNTIME_VERSION = __FRACTAL_RUNTIME_VERSION_JSON__
const OWNER = __FRACTAL_OWNER_JSON__
const delivered = new Set<string>()
let activeSessionId = ''
let activeCwd = ''

function callBridge(
  event: string,
  payload: Record<string, unknown>,
  cwd: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const args = [
      '--runtime', 'pi',
      '--runtime-version', RUNTIME_VERSION,
      '--event', event,
      '--owner', OWNER,
    ]
    const child = spawn(HOOK, args, {
      cwd,
      shell: false,
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    let output = ''
    const timer = setTimeout(() => child.kill('SIGTERM'), 8_000)
    child.stdout.on('data', (chunk) => {
      if (output.length < 65_536) output += String(chunk)
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolve({})
    })
    child.on('close', () => {
      clearTimeout(timer)
      try {
        const parsed = JSON.parse(output || '{}')
        resolve(parsed && typeof parsed === 'object' ? parsed : {})
      } catch {
        resolve({})
      }
    })
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify(payload))
  })
}

function envelope(event: object): Record<string, unknown> {
  return {
    ...event,
    host: {
      session_id: activeSessionId,
      cwd: activeCwd,
    },
  }
}

export default function fractalAgent(pi: ExtensionAPI) {
  pi.on('session_start', async (event, ctx) => {
    activeSessionId = ctx.sessionManager.getSessionId()
    activeCwd = ctx.cwd
    await callBridge('sessionStart', envelope(event), activeCwd)
  })

  pi.on('tool_call', async (event, _ctx) => {
    const result = await callBridge('preToolUse', envelope(event), activeCwd)
    const context = result.additional_context
    if (typeof context !== 'string' || !context) return
    const file = String(
      (event.input as Record<string, unknown>).path
      ?? (event.input as Record<string, unknown>).file_path
      ?? '',
    )
    const key = createHash('sha256').update(`${file}\0${context}`).digest('hex')
    if (delivered.has(key)) return
    delivered.add(key)
    return {
      block: true,
      reason: `${context}\n请按以上目录约束重试本次编辑。`,
    }
  })

  pi.on('tool_result', async (event, _ctx) => {
    await callBridge('tool_result', envelope(event), activeCwd)
  })

  pi.on('agent_settled', async (event, _ctx) => {
    const result = await callBridge('agent_settled', envelope(event), activeCwd)
    const followup = result.additional_context
    if (typeof followup === 'string' && followup) {
      const key = createHash('sha256').update(`closeout\0${followup}`).digest('hex')
      if (delivered.has(key)) return
      delivered.add(key)
      try {
        pi.sendUserMessage(followup, { deliverAs: 'followUp' })
      } catch {
        // Session teardown can invalidate the extension API while the bridge exits.
      }
    }
  })
}
