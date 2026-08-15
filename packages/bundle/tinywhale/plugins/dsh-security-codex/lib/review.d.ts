/**
 * In-process security review engine: collects source files, reviews them in
 * bounded batches through the harness LLM service (the same provider/model the
 * chat uses), parses strict-JSON findings, and renders a summary plus a
 * Markdown report. No external CLI or credentials are involved.
 *
 * Pure with respect to the LLM service: the caller injects a `stream` function,
 * so unit tests drive the loop with fake streams while the adapter wires the
 * real `ctx.llm.stream`.
 *
 * @module dsh-security-codex/review
 */
import type { GenerateOptions, ReasoningEffortId, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm';
/** Severity vocabulary a review batch may report. */
export declare const SCAN_SEVERITIES: readonly ["critical", "high", "medium", "low"];
export type ScanSeverity = (typeof SCAN_SEVERITIES)[number];
/** One accepted finding, pared down to the fields the summary and report render. */
export interface ReviewFinding {
    readonly severity: ScanSeverity;
    readonly title: string;
    /** Repository-relative file path the finding points at. */
    readonly path: string;
    /** One-based line number, when the model supplied one. */
    readonly line?: number;
    readonly description: string;
    /** Optional concrete remediation. */
    readonly suggestion?: string;
}
/** Exact model route resolved from the invoking session or the plugin config. */
export interface ReviewRoute {
    readonly provider: string;
    readonly model: string;
    /** Session reasoning effort passed through when the invoking header carried one. */
    readonly reasoningEffort?: ReasoningEffortId;
}
/** Deployment-varying bounds for one scan; all validated at load. */
export interface ReviewLimits {
    /** Maximum UTF-8 bytes per collected file; larger files are skipped. */
    readonly maxFileBytes: number;
    /** Maximum total UTF-8 bytes collected across all files. */
    readonly maxTotalBytes: number;
    /** Maximum UTF-8 bytes of file content per model call. */
    readonly batchBytes: number;
    /** Maximum review calls per scan (deep mode doubles up to this many). */
    readonly maxBatches: number;
    /** Maximum output tokens per model call. */
    readonly maxTokens: number;
    /** Maximum findings kept in the final report. */
    readonly maxFindings: number;
}
/** One scan request, already validated by the tool layer. */
export interface ReviewRequest {
    /** Absolute repository root. */
    readonly target: string;
    readonly mode: 'standard' | 'deep';
    /** Repository-relative paths restricting the scan; empty scans everything. */
    readonly paths?: readonly string[];
    /** Optional extra instructions appended to the per-batch prompt. */
    readonly extraInstructions?: string;
}
/** One collected source file with its exact bytes. */
interface SourceFile {
    /** Repository-relative path with forward slashes. */
    readonly rel: string;
    /** File content, capped at {@link ReviewLimits.maxFileBytes} (truncation markers applied at batch time). */
    readonly content: Buffer;
}
/** Signature of the LLM entry point the engine calls; `ctx.llm.stream` bound. */
export type ReviewStreamFn = (options: GenerateOptions) => AsyncIterable<StreamChunk>;
/** Everything one scan run needs. */
export interface ReviewEngineOptions {
    readonly stream: ReviewStreamFn;
    readonly route: ReviewRoute;
    readonly limits: ReviewLimits;
    readonly request: ReviewRequest;
    /** Directory receiving `report.md`; the caller creates it before starting the job. */
    readonly reportDir: string;
    readonly signal?: AbortSignal;
}
/** Complete outcome of one scan run. */
export interface ReviewResult {
    readonly findings: ReviewFinding[];
    readonly filesReviewed: number;
    /** Files skipped because they were too large or binary. */
    readonly filesSkipped: number;
    /** Review calls made (deep mode counts its verification calls too). */
    readonly callsMade: number;
    /** Batches whose model text carried no parseable findings JSON. */
    readonly unparseableBatches: number;
    /** Batches whose response hit the max-tokens finish. */
    readonly truncatedBatches: number;
    /** Summed disjoint token usage over every call. */
    readonly tokens: TokenUsage;
    readonly reportPath: string;
}
/** Failure class thrown for a rejected model call; carries the provider-neutral code. */
export declare class ReviewModelError extends Error {
    /** Stable provider-neutral machine-routing code (NO_ADAPTER, AUTH, …). */
    readonly code: string;
    /**
     * @param message - human-readable failure summary.
     * @param code - stable provider-neutral failure code.
     */
    constructor(message: string, code: string);
}
/** Byte cap on the whole model-facing summary; also the job output limit. */
export declare const SUMMARY_LIMIT_BYTES = 32768;
/** Collected-files outcome: the accepted list plus the skip count. */
interface CollectedFiles {
    readonly files: SourceFile[];
    readonly filesSkipped: number;
}
/**
 * Collect every reviewable file for one scan, honoring the paths restriction.
 * Explicit paths must stay inside the target after resolving symlinks: a
 * symlink (top-level or any intermediate directory) that would escape the
 * repository is rejected loudly instead of being followed.
 * @param options - the scan request and bounds.
 * @returns accepted files with repository-relative paths, sorted, plus the skip count.
 */
export declare function collectFiles(request: ReviewRequest, limits: ReviewLimits): Promise<CollectedFiles>;
/**
 * Pack collected files into per-call batches under the byte budget.
 * @param files - accepted files in path order.
 * @param batchBytes - per-call content byte allowance.
 * @returns one prompt text per batch.
 */
export declare function buildBatches(files: readonly SourceFile[], batchBytes: number): string[];
/**
 * Extract a `findings` JSON document from model text. Accepts a fenced or bare
 * object with a `findings` array, or a bare array of findings. Invalid entries
 * are dropped; returns `undefined` when no valid document exists.
 * @param text - raw model text.
 * @param maxFindings - hard cap on accepted entries.
 * @returns the validated findings, possibly empty.
 */
export declare function parseFindings(text: string, maxFindings: number): ReviewFinding[] | undefined;
/**
 * Run one complete security review through the injected model stream.
 * @param options - engine inputs; `reportDir` must be creatable.
 * @returns the aggregated outcome; throws {@link ReviewModelError} for rejected
 *   model calls and the signal's reason for cancellation.
 */
export declare function runReview(options: ReviewEngineOptions): Promise<ReviewResult>;
/** Render the completion summary capped at {@link SUMMARY_LIMIT_BYTES}. */
export declare function renderSummary(result: ReviewResult, route: ReviewRoute): string;
/** Bound a UTF-8 string by bytes without splitting a multibyte character. */
export declare function capUtf8(text: string, maxBytes: number): string;
/**
 * Map a review-engine throw to a job outcome.
 * @param error - the caught value.
 * @param aborted - whether the job controller aborted the run.
 * @returns a `failed` outcome with a bounded, actionable output.
 */
export declare function mapReviewFailure(error: unknown, aborted: boolean): {
    readonly status: 'killed' | 'failed';
    readonly detail: string;
    readonly output?: string;
};
export {};
