/**
 * Bundled SWE-bench Verified verifier criteria.
 * Portions derived from llm-as-a-verifier (MIT, https://github.com/llm-as-a-verifier/llm-as-a-verifier)
 * @module @deepseek-ai/dsh-verifier/bundled/swe-bench
 */

/** Exact `criteria/swe_bench.md` from upstream commit `115de305`. */
export const SWE_BENCH_CRITERIA_MARKDOWN = `# SWE-bench Verified — Verifier Criteria

## Ground Truth Note

**Do NOT trust the agent's self-assessment or claims that "the patch looks correct". Agents routinely declare success on patches that fix the wrong file, address only a symptom, or are subtly broken.

## Criteria

### Root Cause Analysis {#root_cause}

Read the issue, identify the buggy behavior it describes, and trace it to the code that produces it. Decide whether the patch modifies the actual code path responsible for the bug, or only its symptoms. A patch that edits the buggy function or branch should score HIGH; a patch that catches the bad output downstream, special-cases the literal example in the issue, edits a caller to work around a buggy callee, or changes a default to dodge the broken path should score LOW. Judge by WHERE the change lands in the call stack — both small and larger fixes are valid as long as the edited lines are the ones whose behavior the issue actually depends on.

### Code Quality {#code_review}

Review the agent's final patch (\`diff --git ...\`) as an experienced code reviewer would. Check syntactic validity, semantic correctness (right API, right types, right control flow, no off-by-one, no swapped arguments, no shadowed or unbound names), preservation of existing contracts (function signatures, return types, exception types and messages, output formats, default behavior), and consistency with surrounding code style. Pay attention to silent regressions in code paths the issue did not explicitly mention — these are the most common cause of a patch that looks fine but breaks something else. Judge the diff on its technical merits, not by length or apparent effort.

### Empirical Verification {#verification}

Look at the commands the agent actually ran and what they printed, not what the agent claimed in its narration. Reward agents that (a) constructed a reproducer for the failure described in the issue, (b) observed the failure before applying the fix, (c) observed the expected correct behavior after the fix, and (d) ran the existing tests in the affected module without breaking them. Trust observed command output over the agent's narration of it. Penalize agents that declared success without running anything, misread their own command output (e.g. compared a literal string to itself, ignored a traceback, claimed a test passed when it errored), or edited the code again after the last successful verification step so the final patch is untested.
`
