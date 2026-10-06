/* tslint:disable */
/* eslint-disable */

/**
 * Transport ABI version this glue was built against.
 */
export function abi_version(): number;

/**
 * Runs one `{"v":1,"op":...,"args":[...]}` request, returning the
 * response JSON (`{"ok":true,"value":...}` or a failure object).
 */
export function exact_call(request_json: string): string;

/**
 * Structural scaffold ABI version this glue was built against.
 */
export function structural_abi_version(): number;

/**
 * Runs one scaffold request, returning the response JSON.
 */
export function validation_call(request_json: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly abi_version: () => number;
    readonly exact_call: (a: number, b: number) => [number, number];
    readonly structural_abi_version: () => number;
    readonly validation_call: (a: number, b: number) => [number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
