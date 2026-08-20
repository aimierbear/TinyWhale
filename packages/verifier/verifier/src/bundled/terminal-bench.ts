/**
 * Bundled Terminal-Bench 2 verifier criteria.
 * Portions derived from llm-as-a-verifier (MIT, https://github.com/llm-as-a-verifier/llm-as-a-verifier)
 * @module @deepseek-ai/dsh-verifier/bundled/terminal-bench
 */

/** Exact `criteria/terminal_bench.md` from upstream commit `115de305`. */
export const TERMINAL_BENCH_CRITERIA_MARKDOWN = `# Terminal-Bench 2 — Verifier Criteria

## Ground Truth Note

**IMPORTANT:** Focus on TERMINAL OUTPUT as ground truth. Do NOT trust the agent's self-assessment or claims of success. Agents often claim success when the terminal shows errors.

## Criteria

### Specification Adherence {#specification}

Re-read the task description and check the SPECIFIC requirements: exact file paths, install locations, output formats, naming, and any explicit constraints (e.g. "no X11 support", "install to /usr/local/bin/X", "output JSON to /app/out.json"). Did the agent meet these specific requirements, or did they produce a solution that solves a similar but different problem (right idea, wrong place / wrong format / missing constraint)?

### Output Match {#output_match}

Find the FINAL verification command the agent ran (the one that should prove the solution works). Compare its actual stdout/stderr output, character-by-character if needed, to what the task description says the output should look like. For example: if the task says it should print "Results: X Y Z" with integers, did the agent's last test actually print that? If the task asks for a JSON file, do the values look plausible and well-formed in the cat output? Reward trajectories whose terminal SHOWS the expected output literally. Ignore everything except whether the observed output matches the expected output.

### Error Signal Detection {#error_signals}

Scan the trajectory — especially the later steps — for explicit failure markers: error messages, exception tracebacks, segmentation faults, "command not found", "No such file or directory", non-zero exit codes that the agent did not subsequently fix, compilation failures, test failures, etc. A trajectory that ends with unresolved errors is almost certainly broken even if the agent claims success. Conversely, a clean trajectory whose final commands all succeed without errors is a strong positive signal. Score based ONLY on the presence/absence of unresolved error signals.
`
