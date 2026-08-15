/** Cordis adapter that exposes shared fractal and graph capabilities per DSH agent. */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { CoreClient, CoreClientError } from './core-client.js';
export declare const name = "dsh-fractal";
export declare const inject: string[];
/**
 * Resolve the action/capability binaries for a packaged TinyWhale install.
 * Explicit config wins, then env, then the in-box 1.3 core, then ~/.local/bin.
 */
export declare function resolveDefaultCoreBins(env?: NodeJS.ProcessEnv): {
    actionBin: string;
    capabilityBin: string;
};
export interface Config {
    actionBin?: string;
    capabilityBin?: string;
    enabledPresets?: string[];
    maxOutputBytes?: number;
    timeoutMs?: number;
}
export declare const Config: z<Config>;
/** Install the adapter in one DSH runtime. */
export declare function apply(ctx: Context, config?: Config): void;
export { CoreClient, CoreClientError };
