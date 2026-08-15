/**
 * Cordis adapter exposing in-process security reviews as a background job tool.
 *
 * Registers the `security_scan` tool per agent; each call resolves the chat
 * model route from the invoking session (plugin config overrides), preflights
 * `ctx.jobs`, and starts a final-output job of kind `security-scan` that runs
 * the review loop in {@link ./review.ts} through the harness LLM service — the
 * same provider and model the conversation itself uses. No external CLI,
 * credentials, or subprocess are involved.
 *
 * @module dsh-security-codex
 */
import type { Context } from '@deepseek-ai/cordis';
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import z from '@deepseek-ai/schemastery';
import { mapReviewFailure, renderSummary, runReview, SUMMARY_LIMIT_BYTES, type ReviewLimits } from './review.js';
declare module '@deepseek-ai/dsh-jobs' {
    interface JobKindMap {
        'security-scan': 'security-scan';
    }
}
export declare const name = "dsh-security-codex";
export declare const inject: string[];
export interface Config {
    /** LLM provider route; defaults to the invoking session's current chat provider. */
    provider?: string;
    /** Model id; defaults to the invoking session's current chat model. */
    model?: string;
    /** Thinking effort for review calls; 'off' keeps the output budget for findings JSON. */
    effort?: 'off' | 'high' | 'max';
    /** Maximum UTF-8 bytes per collected file; larger files are skipped. */
    maxFileBytes?: number;
    /** Maximum total UTF-8 bytes collected across all files. */
    maxTotalBytes?: number;
    /** Maximum UTF-8 bytes of file content per model call. */
    batchBytes?: number;
    /** Maximum review calls per scan (deep mode verification doubles up to this). */
    maxBatches?: number;
    /** Maximum output tokens per model call. */
    maxTokens?: number;
    /** Maximum findings kept in the final report. */
    maxFindings?: number;
    /** Absolute report directory; defaults to a per-scan temp directory. */
    outputDir?: string;
}
export declare const Config: z<Config>;
/** Deployment-facing bounds after schema defaults and load-time checks. */
export interface ResolvedConfig extends ReviewLimits {
    readonly provider?: string;
    readonly model?: string;
    /** Branded thinking effort for every review call. */
    readonly reasoningEffort: ReasoningEffortId;
    readonly outputDir?: string;
}
/**
 * Validate the loaded config beyond the schema. Empty route fields are
 * dropped so the session route can take over; `outputDir` must be absolute so
 * reports can never land inside a worktree by accident.
 * @param config - the schema-validated config.
 * @returns the resolved, deployment-facing config.
 */
export declare function resolveConfig(config: Config): ResolvedConfig;
/** Tool outcome: the caller continues through the background job, not inline. */
interface ScanOutcome {
    readonly kind: 'background';
    readonly jobId: string;
}
/** Render the background-job handoff the model sees after one call. */
export declare function renderOutcome(_args: unknown, value: ScanOutcome): Array<{
    type: 'text';
    text: string;
}>;
/** Install the adapter in one DSH runtime. */
export declare function apply(ctx: Context, config?: Config): void;
export { mapReviewFailure, renderSummary, runReview, SUMMARY_LIMIT_BYTES };
