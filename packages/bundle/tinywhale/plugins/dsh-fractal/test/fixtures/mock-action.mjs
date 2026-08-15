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
  case 'begin_change_scope':
    console.log(JSON.stringify({ status: 'created', scope_id: 'scope_mock' }))
    break
  case 'record_observed_change':
    console.log(JSON.stringify({ status: 'recorded' }))
    break
  case 'closeout_status':
    if (process.env.DSH_FRACTAL_MOCK_CLOSEOUT === 'unknown') {
      console.log(JSON.stringify({ status: 'future_status' }))
      break
    }
    if (process.env.DSH_FRACTAL_MOCK_CLOSEOUT === 'missing_candidates') {
      console.log(JSON.stringify({
        status: 'needs_closeout',
        closeout_request_id: 'closeout_mock',
      }))
      break
    }
    if (process.env.DSH_FRACTAL_MOCK_CLOSEOUT === 'unowned') {
      console.log(JSON.stringify({
        status: 'needs_unowned_audit',
        reason_code: 'capability_fallback',
        changed_files: [],
        unowned_count: 3,
      }))
      break
    }
    console.log(JSON.stringify({
      status: 'needs_closeout',
      closeout_request_id: 'closeout_mock',
      document_candidates: [{
        file_path: 'src/.folder.md',
        expected_sha256: 'missing',
        candidate_token: 'candidate.mock',
      }],
    }))
    break
  default:
    process.exitCode = 64
}
