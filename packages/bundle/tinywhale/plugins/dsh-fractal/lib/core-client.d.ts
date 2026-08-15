/** Strict, shell-free JSON subprocess boundary for the shared fractal core. */
export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
    [key: string]: JsonValue;
}
export type ActionOperation = 'begin_change_scope' | 'closeout_status' | 'record_observed_change';
export type CapabilityOperation = 'complete_closeout' | 'query_dependencies' | 'scan_dependencies' | 'update_fractal_document';
export interface CoreClientOptions {
    readonly actionBin: string;
    readonly capabilityBin: string;
    readonly maxOutputBytes: number;
    readonly timeoutMs: number;
}
export interface CoreCallOptions {
    readonly cwd: string;
    readonly signal?: AbortSignal;
}
export declare class CoreClientError extends Error {
    readonly code: string;
    readonly retryable: boolean;
    constructor(code: string, message: string, retryable?: boolean);
}
/** Call the two stable core binaries without importing their implementation. */
export declare class CoreClient {
    #private;
    constructor(options: CoreClientOptions);
    action(operation: ActionOperation, payload: JsonObject, options: CoreCallOptions): Promise<JsonObject>;
    capability(operation: CapabilityOperation, payload: JsonObject, options: CoreCallOptions): Promise<JsonObject>;
}
