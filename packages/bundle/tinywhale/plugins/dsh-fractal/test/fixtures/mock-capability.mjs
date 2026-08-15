#!/usr/bin/env node

import { appendFileSync } from 'node:fs'

const operation = process.argv[2]
const input = JSON.parse(await new Promise((resolve) => {
  let value = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', chunk => { value += chunk })
  process.stdin.on('end', () => resolve(value))
}))

if (process.env.DSH_FRACTAL_MOCK_TRACE) {
  appendFileSync(process.env.DSH_FRACTAL_MOCK_TRACE, `${JSON.stringify({ operation, input, cwd: process.cwd() })}\n`)
}

switch (operation) {
  case 'scan_dependencies':
    console.log(JSON.stringify({ status: 'ok', mode: input.force_full ? 'full' : 'incremental' }))
    break
  case 'query_dependencies':
    console.log(JSON.stringify({ status: 'ok', file: input.file_path, exports: [], upstream: [], downstream: [] }))
    break
  case 'update_fractal_document':
    console.log(JSON.stringify({ status: 'updated', file_path: 'src/.folder.md', before_sha256: 'missing', after_sha256: 'a'.repeat(64) }))
    break
  case 'complete_closeout':
    console.log(JSON.stringify({ status: 'acknowledged', closeout_request_id: input.closeout_request_id }))
    break
  default:
    process.exitCode = 64
}
