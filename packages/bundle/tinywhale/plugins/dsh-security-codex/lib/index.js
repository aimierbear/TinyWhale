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
import { statSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';
import { mapReviewFailure, renderSummary, runReview, SUMMARY_LIMIT_BYTES, } from './review.js';
export const name = 'dsh-security-codex';
export const inject = ['tools', 'llm'];
const MAX_INSTRUCTIONS_BYTES = 32_768;
export const Config = z.object({
    provider: z.string(),
    model: z.string(),
    effort: z.union(['off', 'high', 'max']).default('off'),
    // Defaults target the 1M-token context of the DeepSeek V4 family: one batch
    // carries up to ~512 KB of code (~150K tokens), a whole scan up to ~4 MB
    // over at most 12 calls, so a typical repo completes in a few model rounds.
    maxFileBytes: z.number().min(1024).max(2_097_152).default(262_144),
    maxTotalBytes: z.number().min(4096).max(16_777_216).default(4_194_304),
    batchBytes: z.number().min(2048).max(2_097_152).default(524_288),
    maxBatches: z.number().min(1).max(50).default(12),
    maxTokens: z.number().min(256).max(65_536).default(16_384),
    maxFindings: z.number().min(1).max(500).default(100),
    outputDir: z.string(),
});
/**
 * Validate the loaded config beyond the schema. Empty route fields are
 * dropped so the session route can take over; `outputDir` must be absolute so
 * reports can never land inside a worktree by accident.
 * @param config - the schema-validated config.
 * @returns the resolved, deployment-facing config.
 */
export function resolveConfig(config) {
    const provider = config.provider?.trim();
    const model = config.model?.trim();
    if (config.outputDir !== undefined && !isAbsolute(config.outputDir)) {
        throw new TypeError('dsh-security-codex outputDir must be an absolute path');
    }
    return {
        ...provider !== undefined && provider.length > 0 ? { provider } : {},
        ...model !== undefined && model.length > 0 ? { model } : {},
        reasoningEffort: ReasoningEffortId(config.effort ?? 'off'),
        maxFileBytes: config.maxFileBytes ?? 262_144,
        maxTotalBytes: config.maxTotalBytes ?? 4_194_304,
        batchBytes: config.batchBytes ?? 524_288,
        maxBatches: config.maxBatches ?? 12,
        maxTokens: config.maxTokens ?? 16_384,
        maxFindings: config.maxFindings ?? 100,
        ...config.outputDir !== undefined ? { outputDir: config.outputDir } : {},
    };
}
/**
 * Resolve the exact model route for one scan: plugin config wins over the
 * invoking session's current chat route; neither present fails loud.
 * @param ctx - the root context, for provider registration validation.
 * @param resolved - resolved plugin config.
 * @param agent - the invoking agent, whose session carries the chat route.
 * @returns the validated route.
 */
function resolveRoute(ctx, resolved, agent) {
    const header = agent.session.requestHeader()?.config;
    const provider = resolved.provider ?? header?.provider;
    const model = resolved.model ?? header?.model;
    if (provider === undefined || provider.length === 0 || model === undefined || model.length === 0) {
        throw new Error('security_scan cannot resolve a model route: the session has no logged chat request yet, '
            + 'and the plugin config sets no provider/model. Configure provider and model in the plugin config.');
    }
    const registered = ctx.llm.listProviders().some(entry => entry.id === provider);
    if (!registered) {
        throw new Error(`security_scan provider "${provider}" has no registered LLM adapter. `
            + `Available providers: ${ctx.llm.listProviders().map(entry => entry.id).join(', ') || '(none)'}.`);
    }
    return {
        provider,
        model,
        reasoningEffort: resolved.reasoningEffort,
    };
}
const scanOutcomeSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        kind: { type: 'string', enum: ['background'], required: true },
        jobId: { type: 'string', required: true },
    },
};
/** Render the background-job handoff the model sees after one call. */
export function renderOutcome(_args, value) {
    return [{
            type: 'text',
            text: `Security review started as background job ${value.jobId}. You will be notified when it completes; collect its findings summary with job_output ${value.jobId} (wait: true only when blocked on it).`,
        }];
}
/**
 * Start the review loop as a final-output job: cancellation aborts the model
 * calls between batches, model rejections map to failed outcomes, and the
 * completion summary arrives through `done.output`.
 * @param ctx - root context carrying the injected `llm` service.
 * @param options - resolved config, validated request, route, and report dir.
 * @returns the job hooks handed to `jobs.start`.
 */
function runReviewJob(ctx, options) {
    const controller = new AbortController();
    let settled = false;
    let settle;
    const done = new Promise((resolve) => {
        settle = (outcome) => {
            if (settled)
                return;
            settled = true;
            resolve(outcome);
        };
    });
    void (async () => {
        try {
            const result = await runReview({
                stream: ctx.llm.stream.bind(ctx.llm),
                route: options.route,
                limits: options.resolved,
                request: options.request,
                reportDir: options.reportDir,
                signal: controller.signal,
            });
            const high = result.findings.filter(finding => finding.severity === 'critical' || finding.severity === 'high').length;
            settle({
                status: 'completed',
                detail: `${result.findings.length} findings (${high} critical/high)`,
                output: renderSummary(result, options.route),
            });
        }
        catch (error) {
            settle(mapReviewFailure(error, controller.signal.aborted));
        }
    })();
    return {
        cancel: (reason) => {
            controller.abort(new Error(reason ?? 'security review cancelled'));
        },
        done,
    };
}
/** Install the adapter in one DSH runtime. */
export function apply(ctx, config = {}) {
    const resolved = resolveConfig(config);
    const disposers = new Map();
    const register = (agent) => {
        if (disposers.has(agent))
            return;
        const dispose = agent.ctx.tools.register(defineTool({
            name: 'security_scan',
            description: 'Run a security review over a repository using this app\'s current chat model: it collects source files, reviews them in bounded batches, and aggregates findings. Long-running: it returns a background job id immediately, notifies on completion, and job_output reads the findings summary. deep adds a verification pass that re-checks first-pass findings against the code.',
            parameters: {
                target: {
                    type: 'string',
                    description: 'Repository root to review. Absolute path; defaults to the current session workspace.',
                },
                mode: {
                    type: 'string',
                    enum: ['standard', 'deep'],
                    description: 'deep adds a second verification pass over the first-pass findings; standard completes one bounded pass. Defaults to standard.',
                },
                paths: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Restrict the review to repository-relative paths; repeat for multiple. Empty reviews the whole repository.',
                },
                extra_instructions: {
                    type: 'string',
                    description: 'Additional review instructions appended to the per-batch prompt, such as focus areas or threat-model notes.',
                },
            },
            output: { schema: scanOutcomeSchema, render: renderOutcome },
            timeoutMs: 15_000,
            execute: async (args, exec) => {
                const agent = exec.agent;
                if (agent === undefined)
                    throw new Error('security_scan requires an agent session');
                const jobs = ctx.get('jobs');
                if (jobs === undefined) {
                    throw new Error('background jobs unavailable: this profile lacks the jobs capability (load @deepseek-ai/dsh-jobs)');
                }
                if (exec.signal.aborted) {
                    const error = new Error('tool call aborted');
                    error.name = 'AbortError';
                    throw error;
                }
                const sessionCwd = agent.session.header.cwd;
                const target = args.target ?? sessionCwd;
                if (target === undefined || !isAbsolute(target))
                    throw new Error('security_scan target must be an absolute path');
                if (!statSync(target, { throwIfNoEntry: false })?.isDirectory()) {
                    throw new Error(`security_scan target directory does not exist: ${target}`);
                }
                const mode = args.mode ?? 'standard';
                if (mode !== 'standard' && mode !== 'deep') {
                    throw new Error('security_scan mode must be standard or deep');
                }
                for (const path of args.paths ?? []) {
                    if (path.length === 0
                        || path.length > 4_096
                        || isAbsolute(path)
                        || path.includes('\\')
                        || path.split('/').includes('..')
                        || /[\u0000-\u001f\u007f]/u.test(path)) {
                        throw new Error(`security_scan paths contains an invalid repository-relative path: ${path}`);
                    }
                }
                const instructions = args.extra_instructions?.trim();
                if (instructions !== undefined && instructions.length > 0
                    && (Buffer.byteLength(instructions, 'utf8') > MAX_INSTRUCTIONS_BYTES || instructions.includes('\0'))) {
                    throw new Error(`security_scan extra_instructions must be UTF-8 text no larger than ${MAX_INSTRUCTIONS_BYTES} bytes`);
                }
                const route = resolveRoute(ctx, resolved, agent);
                const reportDir = resolved.outputDir ?? await mkdtemp(join(tmpdir(), 'dsh-security-codex-'));
                const request = {
                    target,
                    mode,
                    ...args.paths !== undefined && args.paths.length > 0 ? { paths: args.paths } : {},
                    ...instructions !== undefined && instructions.length > 0 ? { extraInstructions: instructions } : {},
                };
                const label = `security review ${target} (${mode})`;
                const id = jobs.start({
                    kind: 'security-scan',
                    label,
                    owner: agent,
                    outputLimitBytes: SUMMARY_LIMIT_BYTES,
                    run: () => runReviewJob(ctx, { resolved, request, route, reportDir }),
                });
                return { kind: 'background', jobId: id };
            },
        }));
        disposers.set(agent, dispose);
    };
    const disposeAgent = (agent) => {
        const dispose = disposers.get(agent);
        if (dispose === undefined)
            return;
        disposers.delete(agent);
        dispose();
    };
    ctx.on('agent/created', ({ agent }) => register(agent));
    ctx.on('agent/disposed', ({ agent }) => disposeAgent(agent));
    ctx.effect(() => () => {
        for (const agent of [...disposers.keys()])
            disposeAgent(agent);
    });
}
export { mapReviewFailure, renderSummary, runReview, SUMMARY_LIMIT_BYTES };
//# sourceMappingURL=index.js.map