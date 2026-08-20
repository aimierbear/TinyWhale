import { describe, expect, it } from 'vitest'
import { rebrandIndexHtml, rebrandLicense, rebrandReadme } from '../src/rebrand.ts'

const UPSTREAM_EN = `# DeepSeek Harness

English | [中文](README.zh.md)

DeepSeek Harness (\`dsh\`) is an open-source agent harness developed by [DeepSeek AI](https://deepseek.com).

## Developer preview

DeepSeek Harness is currently in _developer preview_ and is iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

## Run

### Run from \`npm\`

\`\`\`sh
npx @deepseek-ai/dsh web
\`\`\`

Pass \`--no-open\` to run the server without opening a browser.

### Run from source

\`\`\`sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm dsh web
\`\`\`

## Community and support

- Feel free to submit feedback through [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions).
- Join Discord.

## Development

For agents, follow [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
`

const UPSTREAM_ZH = `# DeepSeek Harness

[English](README.md) | 中文

DeepSeek Harness（\`dsh\`）是由 [DeepSeek AI](https://deepseek.com) 开发的开源 agent harness。

## 开发者预览

DeepSeek Harness 目前处于 _开发者预览_ 阶段。

## 运行

### 从源码运行

\`\`\`sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm dsh web
\`\`\`

## 社区与支持

- 欢迎通过 Discussions 提交反馈。

<table><tr><td>qr</td></tr></table>

## 开发

面向 agent：请遵循 [AGENTS.md](AGENTS.md)。

## 许可证

[MIT](LICENSE)

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
`

describe('rebrandReadme', () => {
  it('keeps upstream how-to text and restamps TinyWhale branding', () => {
    const next = rebrandReadme(UPSTREAM_EN, 'en')
    expect(next).toContain('# TinyWhale')
    expect(next).toContain('not affiliated')
    expect(next).toContain('Pass `--no-open`')
    expect(next).toContain('git clone https://github.com/aimierbear/TinyWhale.git')
    expect(next).toContain('cd TinyWhale')
    expect(next).not.toContain('cd deepseek-harness')
    expect(next).toContain('Install the packaged app')
    expect(next).toContain('Run the desktop app from source')
    expect(next).toContain('aimierbear/TinyWhale/issues')
    expect(next).not.toContain('Join Discord')
    expect(next).toContain('TINYWHALE.md')
    expect(next).toContain('NOTICE')
    expect(rebrandReadme(next, 'en')).toBe(next)
  })

  it('replaces the Chinese community table and keeps new run instructions', () => {
    const next = rebrandReadme(UPSTREAM_ZH, 'zh')
    expect(next).toContain('# TinyWhale')
    expect(next).toContain('cd TinyWhale')
    expect(next).toContain('安装打包应用')
    expect(next).not.toContain('<table>')
    expect(next).toContain('本仓库 Issues')
    expect(next).toContain('NOTICE')
    expect(rebrandReadme(next, 'zh')).toBe(next)
  })
})

describe('rebrandIndexHtml', () => {
  it('sets the TinyWhale title and splash transparency', () => {
    const next = rebrandIndexHtml(`<!doctype html>
<html><head>
    <title>DSH Local Build</title>
  </head>
  <body></body></html>
`)
    expect(next).toContain('<title>TinyWhale</title>')
    expect(next).toContain('background: transparent')
    expect(rebrandIndexHtml(next)).toBe(next)
  })
})

describe('rebrandLicense', () => {
  it('inserts the TinyWhale copyright under the upstream line', () => {
    const next = rebrandLicense('MIT License\n\nCopyright (c) 2026 DeepSeek\n\nPermission is hereby granted.\n')
    expect(next).toContain('Copyright (c) 2026 DeepSeek\nCopyright (c) 2026 TinyWhale contributors\n')
    expect(rebrandLicense(next)).toBe(next)
  })
})
