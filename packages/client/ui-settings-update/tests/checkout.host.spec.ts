import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { runNativeCommand } from '@deepseek-ai/dsh-native-command'
import {
  applyTinyWhaleUpdate, defaultCommands, describeTinyWhaleCheckout, findTinyWhaleRoot,
  resolveUpdateConfig,
} from '../src/checkout.ts'
import { DEFAULT_UPSTREAM_REMOTE, DEFAULT_UPSTREAM_URL } from '../src/types.ts'

const NEVER = new AbortController().signal

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

function write(path: string, body: string): void {
  writeFileSync(path, body)
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-b', 'master'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'test'])
  write(join(dir, 'TINYWHALE.md'), '# TinyWhale\n')
  write(join(dir, 'file.txt'), 'base\n')
  git(dir, ['add', '.'])
  git(dir, ['commit', '-m', 'init'])
}

function clone(source: string, dest: string): void {
  execFileSync('git', ['clone', source, dest], { stdio: 'pipe' })
  git(dest, ['config', 'user.email', 'test@example.com'])
  git(dest, ['config', 'user.name', 'test'])
}

function commitFile(dir: string, name: string, body: string, message: string): void {
  write(join(dir, name), body)
  git(dir, ['add', name])
  git(dir, ['commit', '-m', message])
}

describe('defaultCommands', () => {
  it('rejects a missing install directory', async () => {
    await expect(defaultCommands().install('/no/such/tinywhale-install', NEVER)).rejects.toThrow()
  })
})

describe('describeTinyWhaleCheckout packaged', () => {
  it('treats TINYWHALE_PACKAGED as an available install that does not merge git', async () => {
    const status = describeTinyWhaleCheckout('/tmp/missing', resolveUpdateConfig(), [], {
      TINYWHALE_PACKAGED: '1',
      TINYWHALE_VERSION: '0.1.0',
      TINYWHALE_RELEASE_URL: 'https://example.test/releases',
    })
    expect(status).toMatchObject({
      available: true,
      channel: 'packaged',
      version: '0.1.0',
      releaseUrl: 'https://example.test/releases',
    })
    await expect(applyTinyWhaleUpdate(
      '/tmp/missing',
      resolveUpdateConfig(),
      NEVER,
      undefined,
      [],
      {
        TINYWHALE_PACKAGED: '1',
        TINYWHALE_RELEASE_URL: 'https://example.test/releases',
      },
    )).resolves.toMatchObject({
      outcome: 'manual',
      detail: 'https://example.test/releases',
    })
  })

  it('defaults the packaged download page when TINYWHALE_RELEASE_URL is absent', () => {
    expect(describeTinyWhaleCheckout('/tmp/missing', resolveUpdateConfig(), [], {
      TINYWHALE_PACKAGED: '1',
    }).releaseUrl).toBe('https://github.com/aimierbear/TinyWhale/releases')
    expect(describeTinyWhaleCheckout('/tmp/missing', resolveUpdateConfig(), [], {
      TINYWHALE_PACKAGED: '1',
      TINYWHALE_RELEASE_URL: '',
    }).releaseUrl).toBe('https://github.com/aimierbear/TinyWhale/releases')
  })
})

describe('findTinyWhaleRoot', () => {
  it('walks up to TINYWHALE.md and stops without one', () => {
    const root = mkdtempSync(join(tmpdir(), 'tinywhale-root-'))
    const nested = join(root, 'packages', 'client', 'pkg', 'src')
    mkdirSync(nested, { recursive: true })
    expect(findTinyWhaleRoot(join(nested, 'index.ts'))).toBeUndefined()
    write(join(root, 'TINYWHALE.md'), '# TinyWhale\n')
    expect(findTinyWhaleRoot(join(nested, 'index.ts'))).toBe(root)
    expect(findTinyWhaleRoot(root)).toBe(root)
  })

  it('describeTinyWhaleCheckout accepts an extra discovery path', () => {
    const missing = mkdtempSync(join(tmpdir(), 'tinywhale-miss-'))
    const repo = join(mkdtempSync(join(tmpdir(), 'tinywhale-extra-')), 'repo')
    initRepo(repo)
    const config = resolveUpdateConfig()
    expect(describeTinyWhaleCheckout(missing, config).available).toBe(false)
    expect(describeTinyWhaleCheckout(missing, config, [repo])).toMatchObject({
      available: true,
      root: repo,
    })
  })
})

describe('describeTinyWhaleCheckout', () => {
  it('requires both the marker and a git directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'tinywhale-status-'))
    const config = resolveUpdateConfig()
    expect(describeTinyWhaleCheckout(root, config).available).toBe(false)
    write(join(root, 'TINYWHALE.md'), '# TinyWhale\n')
    expect(describeTinyWhaleCheckout(root, config).available).toBe(false)
    initRepo(join(root, 'repo'))
    const status = describeTinyWhaleCheckout(join(root, 'repo'), config)
    expect(status).toMatchObject({
      available: true,
      root: join(root, 'repo'),
      remoteName: DEFAULT_UPSTREAM_REMOTE,
      remoteUrl: DEFAULT_UPSTREAM_URL,
      branch: 'master',
    })
  })
})

describe('applyTinyWhaleUpdate', () => {
  it('refuses a tree that is not a TinyWhale checkout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tinywhale-none-'))
    await expect(applyTinyWhaleUpdate(root, resolveUpdateConfig(), NEVER))
      .resolves.toEqual({ outcome: 'refused-unavailable' })
  })

  it('refuses a dirty working tree', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tinywhale-dirty-'))
    initRepo(root)
    write(join(root, 'file.txt'), 'dirty\n')
    await expect(applyTinyWhaleUpdate(root, resolveUpdateConfig(), NEVER))
      .resolves.toEqual({ outcome: 'refused-dirty' })
  })

  it('refuses a detached HEAD', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tinywhale-detach-'))
    initRepo(root)
    const sha = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    git(root, ['checkout', '--detach', sha])
    await expect(applyTinyWhaleUpdate(root, resolveUpdateConfig(), NEVER))
      .resolves.toEqual({ outcome: 'refused-detached' })
  })

  it('adds the missing upstream remote, fetches, and reports already-current', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'tinywhale-current-'))
    const upstream = join(tmp, 'upstream')
    const local = join(tmp, 'local')
    initRepo(upstream)
    clone(upstream, local)
    const result = await applyTinyWhaleUpdate(local, {
      remoteName: 'upstream',
      remoteUrl: upstream,
      branch: 'master',
    }, NEVER)
    expect(result).toEqual({ outcome: 'already-current' })
    const url = execFileSync('git', ['-C', local, 'remote', 'get-url', 'upstream'], { encoding: 'utf8' }).trim()
    expect(url).toBe(upstream)
  })

  it('fast-forwards new upstream commits and installs when the lockfile changes', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'tinywhale-ff-'))
    const upstream = join(tmp, 'upstream')
    const local = join(tmp, 'local')
    initRepo(upstream)
    clone(upstream, local)
    git(local, ['remote', 'rename', 'origin', 'upstream'])
    commitFile(upstream, 'pnpm-lock.yaml', 'lock: 1\n', 'lock')
    const install = vi.fn(async () => {})
    const result = await applyTinyWhaleUpdate(local, resolveUpdateConfig(), NEVER, {
      run: runNativeCommand,
      install,
    })
    expect(result).toEqual({ outcome: 'updated', installed: true })
    expect(install).toHaveBeenCalledOnce()
    expect(execFileSync('git', ['-C', local, 'log', '-1', '--pretty=%s'], { encoding: 'utf8' }).trim())
      .toBe('lock')
  })

  it('merges without install when the lockfile is unchanged', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'tinywhale-nlock-'))
    const upstream = join(tmp, 'upstream')
    const local = join(tmp, 'local')
    initRepo(upstream)
    clone(upstream, local)
    git(local, ['remote', 'rename', 'origin', 'upstream'])
    commitFile(upstream, 'other.txt', 'x\n', 'other')
    const install = vi.fn(async () => {})
    await expect(applyTinyWhaleUpdate(local, resolveUpdateConfig(), NEVER, {
      run: runNativeCommand,
      install,
    })).resolves.toEqual({ outcome: 'updated', installed: false })
    expect(install).not.toHaveBeenCalled()
  })

  it('aborts a conflicting merge', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'tinywhale-conflict-'))
    const upstream = join(tmp, 'upstream')
    const local = join(tmp, 'local')
    initRepo(upstream)
    clone(upstream, local)
    git(local, ['remote', 'rename', 'origin', 'upstream'])
    commitFile(upstream, 'file.txt', 'upstream\n', 'upstream-edit')
    commitFile(local, 'file.txt', 'local\n', 'local-edit')
    const result = await applyTinyWhaleUpdate(local, resolveUpdateConfig(), NEVER)
    expect(result.outcome).toBe('conflict')
    expect(execFileSync('git', ['-C', local, 'status', '--porcelain'], { encoding: 'utf8' }).trim())
      .toBe('')
  })

  it('refuses a second apply while the first is still running', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tinywhale-busy-'))
    initRepo(root)
    const gate = Promise.withResolvers<undefined>()
    const started = Promise.withResolvers<undefined>()
    const first = applyTinyWhaleUpdate(root, resolveUpdateConfig(), NEVER, {
      run: async (command, args, signal) => {
        if (args.includes('status')) {
          started.resolve(undefined)
          await gate.promise
          throw new Error('stop')
        }
        return runNativeCommand(command, args, signal)
      },
      install: async () => {},
    })
    await started.promise
    await expect(applyTinyWhaleUpdate(root, resolveUpdateConfig(), NEVER))
      .resolves.toEqual({ outcome: 'refused-busy' })
    gate.resolve(undefined)
    await expect(first).resolves.toEqual({ outcome: 'failed', detail: 'stop' })
  })

  it('falls back to the remote HEAD when the configured branch is missing', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'tinywhale-head-'))
    const upstream = join(tmp, 'upstream')
    const local = join(tmp, 'local')
    mkdirSync(upstream, { recursive: true })
    git(upstream, ['init', '-b', 'main'])
    git(upstream, ['config', 'user.email', 'test@example.com'])
    git(upstream, ['config', 'user.name', 'test'])
    write(join(upstream, 'TINYWHALE.md'), '# TinyWhale\n')
    write(join(upstream, 'file.txt'), 'base\n')
    git(upstream, ['add', '.'])
    git(upstream, ['commit', '-m', 'init'])
    clone(upstream, local)
    git(local, ['remote', 'rename', 'origin', 'upstream'])
    commitFile(upstream, 'later.txt', 'x\n', 'later')
    await expect(applyTinyWhaleUpdate(local, {
      remoteName: 'upstream',
      remoteUrl: upstream,
      branch: 'missing',
    }, NEVER)).resolves.toEqual({ outcome: 'updated', installed: false })
  })

  it('fails when neither the configured branch nor the remote HEAD exists', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tinywhale-noref-'))
    initRepo(root)
    await expect(applyTinyWhaleUpdate(root, resolveUpdateConfig(), NEVER, {
      run: async (_command, args) => {
        if (args.includes('symbolic-ref') && args.includes('-q')) return { stdout: 'refs/heads/master', stderr: '' }
        if (args.includes('status')) return { stdout: '', stderr: '' }
        if (args.includes('get-url')) return { stdout: 'url', stderr: '' }
        if (args.includes('fetch')) return { stdout: '', stderr: '' }
        if (args.includes('rev-parse') && args.includes('--verify')) throw new Error('no named branch')
        if (args.some(arg => arg.startsWith('refs/remotes/'))) return { stdout: 'unexpected', stderr: '' }
        throw new Error(args.join(' '))
      },
      install: async () => {},
    })).resolves.toEqual({ outcome: 'failed', detail: 'upstream branch upstream/master is missing' })
  })

  it('classifies a non-conflict merge failure and truncates a long diagnostic', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tinywhale-fail-'))
    initRepo(root)
    const long = 'x'.repeat(300)
    await expect(applyTinyWhaleUpdate(root, resolveUpdateConfig(), NEVER, {
      run: async (_command, args) => {
        if (args.includes('symbolic-ref') && args.includes('-q')) return { stdout: 'refs/heads/master', stderr: '' }
        if (args.includes('status')) return { stdout: '', stderr: '' }
        if (args.includes('get-url')) return { stdout: 'url', stderr: '' }
        if (args.includes('fetch')) return { stdout: '', stderr: '' }
        if (args.includes('rev-parse') && args.includes('--verify')) return { stdout: 'upstream/master', stderr: '' }
        if (args.includes('merge-base')) {
          const error = Object.assign(new Error('not an ancestor'), { code: 1, stdout: '', stderr: '' })
          throw error
        }
        if (args.includes('rev-parse') && args.includes('HEAD')) return { stdout: 'aaa', stderr: '' }
        if (args.includes('merge') && args.includes('--no-edit')) {
          throw Object.assign(new Error(long), { stderr: 'fatal: refusing to merge unrelated histories' })
        }
        throw new Error(args.join(' '))
      },
      install: async () => {},
    })).resolves.toMatchObject({
      outcome: 'failed',
      detail: `${'x'.repeat(239)}…`,
    })

    await expect(applyTinyWhaleUpdate(root, resolveUpdateConfig(), NEVER, {
      run: async (_command, args) => {
        if (args.includes('symbolic-ref') && args.includes('-q')) return { stdout: 'refs/heads/master', stderr: '' }
        if (args.includes('status')) return { stdout: '', stderr: '' }
        if (args.includes('get-url')) return { stdout: 'url', stderr: '' }
        if (args.includes('fetch')) return { stdout: '', stderr: '' }
        if (args.includes('rev-parse') && args.includes('--verify')) return { stdout: 'upstream/master', stderr: '' }
        if (args.includes('merge-base')) throw Object.assign(new Error('behind'), { stderr: 1 })
        if (args.includes('rev-parse') && args.includes('HEAD')) return { stdout: 'aaa', stderr: '' }
        if (args.includes('merge') && args.includes('--no-edit')) throw { stderr: 1 }
        throw new Error(args.join(' '))
      },
      install: async () => {},
    })).resolves.toEqual({ outcome: 'failed', detail: '[object Object]' })

    await expect(applyTinyWhaleUpdate(root, resolveUpdateConfig(), NEVER, {
      run: async (_command, args) => {
        if (args.includes('symbolic-ref') && args.includes('-q')) return { stdout: 'refs/heads/master', stderr: '' }
        if (args.includes('status')) return { stdout: '', stderr: '' }
        if (args.includes('get-url')) return { stdout: 'url', stderr: '' }
        if (args.includes('fetch')) return { stdout: '', stderr: '' }
        if (args.includes('rev-parse') && args.includes('--verify')) return { stdout: 'upstream/master', stderr: '' }
        if (args.includes('merge-base')) throw 42
        if (args.includes('rev-parse') && args.includes('HEAD')) return { stdout: 'aaa', stderr: '' }
        if (args.includes('merge') && args.includes('--no-edit')) throw 42
        throw new Error(args.join(' '))
      },
      install: async () => {},
    })).resolves.toEqual({ outcome: 'failed', detail: '42' })
  })

  it('keeps a successful merge when install fails', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'tinywhale-install-'))
    const upstream = join(tmp, 'upstream')
    const local = join(tmp, 'local')
    initRepo(upstream)
    clone(upstream, local)
    git(local, ['remote', 'rename', 'origin', 'upstream'])
    commitFile(upstream, 'pnpm-lock.yaml', 'lock: 2\n', 'lock')
    const result = await applyTinyWhaleUpdate(local, resolveUpdateConfig(), NEVER, {
      run: runNativeCommand,
      install: async () => { throw new Error('pnpm exploded') },
    })
    expect(result).toEqual({
      outcome: 'updated',
      installed: false,
      detail: 'pnpm exploded',
    })
  })
})
