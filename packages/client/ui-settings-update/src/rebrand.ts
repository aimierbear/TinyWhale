/**
 * Absorb upstream docs, then reapply TinyWhale branding.
 *
 * Overlay freeze is wrong for README: harness how-to text still belongs
 * to upstream. These transforms start from the merged (usually upstream)
 * file and stamp product name, clone URL, community, and TinyWhale-only
 * sections without dropping unknown headings.
 * @module @deepseek-ai/dsh-client-ui-settings-update
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Content files taken from upstream on conflict, then transformed. */
export const TINYWHALE_REBRAND_THEIRS_PATHS = [
  'README.md',
  'README.zh.md',
  'LICENSE',
  'apps/web/index.html',
] as const

/** Rebrand outputs, including the pairing sidecar rewritten after README. */
export const TINYWHALE_REBRAND_PATHS = [
  ...TINYWHALE_REBRAND_THEIRS_PATHS,
  'README.i18n.yaml',
] as const

const TITLE = 'TinyWhale'
const UPSTREAM_CLONE = 'https://github.com/deepseek-ai/deepseek-harness.git'
const FORK_CLONE = 'https://github.com/aimierbear/TinyWhale.git'
const COPYRIGHT = 'Copyright (c) 2026 TinyWhale contributors'
const INDEX_STYLE = 'html, body, #root { height: 100%; margin: 0; background: transparent; }'

const EN_PRELUDE = `

English | [中文](README.zh.md)

TinyWhale is an independent desktop-oriented fork of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (\`dsh\`). The runtime still uses a plugin architecture powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper).

This project is **not affiliated with, endorsed by, or sponsored by DeepSeek**. "DeepSeek" is a trademark of its owner. Internal packages still use the \`@deepseek-ai/*\` scope so the fork can track upstream; the public product name is TinyWhale.

`

const ZH_PRELUDE = `

[English](README.md) | 中文

TinyWhale 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（\`dsh\`）的独立桌面向 fork。运行时仍采用**一切皆插件**的架构，并由 [Cordis](https://github.com/cordiverse/cordis) 驱动，其设计参见论文 [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper)。

本项目**与 DeepSeek 无隶属、背书或赞助关系**。"DeepSeek" 是其权利人的商标。内部 npm 包仍使用 \`@deepseek-ai/*\` scope，以便跟踪上游；对外产品名是 TinyWhale。

`

const EN_PACKAGED = {
  heading: 'Install the packaged app',
  body: `

On Apple Silicon Macs, download the DMG from [GitHub Releases](https://github.com/aimierbear/TinyWhale/releases), drag TinyWhale into Applications, then open it. The install vendors Node, pnpm, Git, and the harness. You do not need a checkout or Homebrew. This is a developer-preview build: it is not notarized until a signed release is published.

`,
}

const ZH_PACKAGED = {
  heading: '安装打包应用',
  body: `

在 Apple Silicon Mac 上，从 [GitHub Releases](https://github.com/aimierbear/TinyWhale/releases) 下载 DMG，把 TinyWhale 拖进「应用程序」，再打开。安装包自带 Node、pnpm、Git 和 harness，不需要检出或 Homebrew。这是开发者预览构建：在签过名的发行版出来之前，它未经公证。

`,
}

const EN_DESKTOP = {
  heading: 'Run the desktop app from source',
  body: `

Install \`Node.js\`, then from this repository:

\`\`\`sh
cd desktop
npm install
npm start
\`\`\`

The Electron shell attaches to \`http://127.0.0.1:3080\` when that address already serves the Web UI; otherwise it starts \`dsh web\` and opens the window. See [desktop/README.md](desktop/README.md).

`,
}

const ZH_DESKTOP = {
  heading: '从源码运行桌面应用',
  body: `

安装 \`Node.js\` 后，在本仓库中执行：

\`\`\`sh
cd desktop
npm install
npm start
\`\`\`

若 \`http://127.0.0.1:3080\` 已在提供 Web UI，Electron 壳会直接接入；否则它会启动 \`dsh web\` 并打开窗口。详见 [desktop/README.zh.md](desktop/README.zh.md)。

`,
}

const EN_COMMUNITY = `

- Open TinyWhale-specific issues on [this repository](https://github.com/aimierbear/TinyWhale/issues).
- Upstream harness discussion remains at [DeepSeek Harness Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions).

`

const ZH_COMMUNITY = `

- TinyWhale 相关问题请提到 [本仓库 Issues](https://github.com/aimierbear/TinyWhale/issues)。
- 上游 harness 讨论仍在 [DeepSeek Harness Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions)。

`

interface MarkdownSection {
  heading: string
  body: string
}

interface ParsedMarkdown {
  title: string
  prelude: string
  sections: MarkdownSection[]
}

/**
 * Whether Settings update takes theirs then rebrands this path.
 * @param path - Repository-relative path from `git diff --name-only`.
 */
export function isTinyWhaleRebrandPath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/')
  return (TINYWHALE_REBRAND_PATHS as readonly string[]).includes(normalized)
}

/**
 * Rebrand English or Chinese root README: keep unknown sections, stamp branding.
 * @param text - Merged README, usually upstream.
 * @param lang - Which branding strings to apply.
 */
export function rebrandReadme(text: string, lang: 'en' | 'zh'): string {
  const parsed = parseMarkdown(text)
  if (parsed === undefined) return text
  parsed.title = TITLE
  parsed.prelude = lang === 'en' ? EN_PRELUDE : ZH_PRELUDE
  const extras = lang === 'en' ? [EN_PACKAGED, EN_DESKTOP] : [ZH_PACKAGED, ZH_DESKTOP]
  insertAfter(parsed.sections, lang === 'en' ? 'Developer preview' : '开发者预览', extras)
  const community = parsed.sections.find(section =>
    section.heading === 'Community and support' || section.heading === '社区与支持')
  if (community !== undefined) community.body = lang === 'en' ? EN_COMMUNITY : ZH_COMMUNITY
  const development = parsed.sections.find(section =>
    section.heading === 'Development' || section.heading === '开发')
  if (development !== undefined && !development.body.includes('TINYWHALE.md')) {
    development.body = appendSentence(
      development.body,
      lang === 'en'
        ? ' Fork-specific layout is in [TINYWHALE.md](TINYWHALE.md).'
        : '本 fork 的额外约定见 [TINYWHALE.md](TINYWHALE.md)。',
    )
  }
  const license = parsed.sections.find(section =>
    section.heading === 'License' || section.heading === '许可证')
  // THIRD_PARTY_NOTICES.md contains the substring NOTICE; require the fork file.
  if (license !== undefined && !license.body.includes('[NOTICE](NOTICE)')) {
    license.body = lang === 'en'
      ? license.body.replace(
        'Third-party dependencies',
        'Upstream copyright is retained. Attribution is in [NOTICE](NOTICE). Third-party dependencies',
      )
      : license.body.replace(
        '第三方依赖',
        '上游版权予以保留。归属声明见 [NOTICE](NOTICE)。第三方依赖',
      )
  }
  const preview = parsed.sections.find(section =>
    section.heading === 'Developer preview' || section.heading === '开发者预览')
  if (preview !== undefined) {
    preview.body = preview.body
      .replace('DeepSeek Harness is currently', 'The harness is currently')
      .replace('DeepSeek Harness 目前', '该 harness 目前')
  }
  return pinReadmeAnchors(rewriteClones(renderMarkdown(parsed)))
}

/** Stamp the product title and splash transparency onto the web index. */
export function rebrandIndexHtml(text: string): string {
  let next = text.replace(/<title>[^<]*<\/title>/, '<title>TinyWhale</title>')
  if (!next.includes('background: transparent')) {
    next = next.replace(
      /(<title>TinyWhale<\/title>)/,
      `$1\n    <style>\n      ${INDEX_STYLE}\n    </style>`,
    )
  }
  return next
}

/** Keep upstream license text and ensure the TinyWhale copyright line. */
export function rebrandLicense(text: string): string {
  if (text.includes('TinyWhale contributors')) return text
  const match = /^(Copyright \(c\)[^\n]*\n)/m.exec(text)
  if (match?.[1] === undefined) return text
  return text.replace(match[1], `${match[1]}${COPYRIGHT}\n`)
}

/**
 * Transform rebrand paths in `root` and rewrite the README pairing sidecar.
 * @param root - Repository root.
 * @returns Paths written (to `git add`).
 */
export function applyTinyWhaleRebrand(root: string): string[] {
  const written: string[] = []
  const readme = join(root, 'README.md')
  const readmeZh = join(root, 'README.zh.md')
  if (existsSync(readme)) {
    writeIfChanged(readme, rebrandReadme(readFileSync(readme, 'utf8'), 'en'), written, 'README.md')
  }
  if (existsSync(readmeZh)) {
    writeIfChanged(readmeZh, rebrandReadme(readFileSync(readmeZh, 'utf8'), 'zh'), written, 'README.zh.md')
  }
  const license = join(root, 'LICENSE')
  if (existsSync(license)) {
    writeIfChanged(license, rebrandLicense(readFileSync(license, 'utf8')), written, 'LICENSE')
  }
  const index = join(root, 'apps/web/index.html')
  if (existsSync(index)) {
    writeIfChanged(index, rebrandIndexHtml(readFileSync(index, 'utf8')), written, 'apps/web/index.html')
  }
  if (existsSync(readme) && existsSync(readmeZh)) {
    const sidecar = renderReadmePairing(
      gitBlobHash(readFileSync(readme)),
      gitBlobHash(readFileSync(readmeZh)),
    )
    writeIfChanged(join(root, 'README.i18n.yaml'), sidecar, written, 'README.i18n.yaml')
  }
  return written
}

function writeIfChanged(path: string, next: string, written: string[], relative: string): void {
  const previous = existsSync(path) ? readFileSync(path, 'utf8') : undefined
  if (previous === next) return
  writeFileSync(path, next)
  written.push(relative)
}

function parseMarkdown(text: string): ParsedMarkdown | undefined {
  if (!text.startsWith('# ')) return undefined
  const titleEnd = text.indexOf('\n')
  if (titleEnd < 0) return { title: text.slice(2), prelude: '\n', sections: [] }
  const title = text.slice(2, titleEnd)
  const rest = text.slice(titleEnd + 1)
  const headingAt = rest.search(/\n## /)
  if (headingAt < 0) return { title, prelude: `\n${rest}`, sections: [] }
  const prelude = `\n${rest.slice(0, headingAt + 1)}`
  const sectionSource = rest.slice(headingAt + 1)
  const sections = sectionSource.split(/\n(?=## )/).map((block) => {
    const lineEnd = block.indexOf('\n')
    const headingLine = lineEnd < 0 ? block : block.slice(0, lineEnd)
    return {
      heading: headingLine.replace(/^## /, ''),
      body: lineEnd < 0 ? '' : block.slice(lineEnd),
    }
  })
  return { title, prelude, sections }
}

function renderMarkdown(parsed: ParsedMarkdown): string {
  const chunks = [`# ${parsed.title}`, parsed.prelude]
  for (const section of parsed.sections) {
    const soFar = chunks.join('')
    if (!soFar.endsWith('\n\n')) chunks.push(soFar.endsWith('\n') ? '\n' : '\n\n')
    chunks.push(`## ${section.heading}`, section.body)
  }
  const rendered = chunks.join('')
  return rendered.endsWith('\n') ? rendered : `${rendered}\n`
}

function insertAfter(
  sections: MarkdownSection[],
  afterHeading: string,
  extras: readonly MarkdownSection[],
): void {
  const missing = extras.filter(extra => !sections.some(section => section.heading === extra.heading))
  if (missing.length === 0) return
  const index = sections.findIndex(section => section.heading === afterHeading)
  const at = index >= 0 ? index + 1 : 0
  sections.splice(at, 0, ...missing)
}

function rewriteClones(text: string): string {
  return text
    .replaceAll(UPSTREAM_CLONE, FORK_CLONE)
    .replaceAll('\ncd deepseek-harness\n', '\ncd TinyWhale\n')
}

/**
 * Keep stable HTML ids next to the headings user-guide links target.
 * Section splitting on `## ` would otherwise leave `<a id="run">` on the
 * previous heading after packaged/desktop sections are inserted.
 */
function pinReadmeAnchors(text: string): string {
  return pinHtmlAnchor(
    pinHtmlAnchor(text, 'run', /^## (?:Run|运行)$/m),
    'run-from-source',
    /^### (?:Run from source|从源码运行)$/m,
  )
}

function pinHtmlAnchor(text: string, id: string, heading: RegExp): string {
  const stripped = text.replaceAll(new RegExp(`<a id="${id}"></a>\\n*`, 'g'), '')
  return stripped.replace(heading, `<a id="${id}"></a>\n\n$&`)
}

function appendSentence(body: string, sentence: string): string {
  return `${body.replace(/\n+$/, '')}${sentence}\n`
}

function gitBlobHash(content: Buffer): string {
  return createHash('sha1').update(`blob ${String(content.length)}\0`).update(content).digest('hex')
}

function renderReadmePairing(sourceHash: string, zhHash: string): string {
  return [
    '# Bilingual-pair consistency record (docs/i18n/README.md): the git blob hash of each',
    '# side as of the last confirmed-consistent state. Both languages carry equal authority;',
    '# after editing either side, bring the other along and re-record with:',
    '#   pnpm run verify-translation-pairing --write README.md',
    `README.md: ${sourceHash}`,
    `README.zh.md: ${zhHash}`,
    '',
  ].join('\n')
}
