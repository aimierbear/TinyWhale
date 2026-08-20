/**
 * Bundled MedAgentBench verifier criteria.
 * Portions derived from llm-as-a-verifier (MIT, https://github.com/llm-as-a-verifier/llm-as-a-verifier)
 * @module @deepseek-ai/dsh-verifier/bundled/medagentbench
 */

/** Exact `criteria/medagentbench.md` from upstream commit `115de305`. */
export const MEDAGENTBENCH_CRITERIA_MARKDOWN = `# MedAgentBench — Verifier Criteria

## Ground Truth Note

**IMPORTANT:** Do NOT trust the agent's self-assessment. The ONLY reliable evidence is the raw FHIR JSON returned by the server and the exact question being asked. A correct answer can be a specific value, a default like -1, or 'Patient not found' — what matters is whether the trajectory's queries and data LOGICALLY SUPPORT the final answer. Do NOT favor specific-looking answers over defaults or vice versa.

## Criteria

### Search Parameter Accuracy {#query}

Focus ONLY on the URL parameters in the agent's GET requests. For each parameter, check:
  1. patient= : Does it exactly match the MRN/ID from the question? Count the digits.
  2. code= : Is this a valid code for what's being asked? (e.g., 'GLU' for glucose/CBG, '2823-3' or 'K' for potassium, 'A1C' for HbA1C)
  3. date= : If a time constraint is mentioned, is the date filter present and correctly computed from the context timestamp?

Ignore everything else. Score ONLY on parameter accuracy.

### Response-Answer Alignment {#consistency}

Look at the FHIR Bundle returned by the server:
  - How many entries does it contain? (check 'total' field or count entries)
  - If total=0 or no entries: the only correct answer is a default/not-found. Returning a specific value from empty data is fabrication.
  - If entries exist: the answer should use values from those entries. Saying 'not found' when data was returned is equally wrong.
  - If the answer is a computed value (average, count), verify the computation against the entries.

Score on alignment between response content and answer.

### FINISH Format Compliance {#structure}

The agent MUST call FINISH([...]) as its final action with a JSON-loadable list.
  - No FINISH() = broken trajectory, regardless of correctness.
  - Values must be the right type: numbers as numbers (not {"value": 5.4} or "5.4"), dates as strings.
  - The list should contain exactly what was asked — no extra text, no wrapper objects, no null padding.
`
