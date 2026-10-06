// Host side of the structural scaffold binding (V03.5).
//
// Wraps caller-supplied generated glue (init owned by bootstrap):
// versioned scaffold requests in, parsed values out. Scaffold
// failures surface as StructuralError carrying the envelope's stage,
// code and optional check — never silent, never retried.
export const REQUIRED_STRUCTURAL_ABI = 1;

export type StructuralStage = "transport" | "plan";

/** Minimal structural shape of the generated scaffold glue. */
export interface ValidationGlue {
  structural_abi_version(): number;
  validation_call(requestJson: string): string;
}

export class StructuralError extends Error {
  readonly stage: StructuralStage;
  readonly code: string;
  readonly check?: string;

  constructor(stage: StructuralStage, code: string, check?: string) {
    super(`structural ${stage} failure: ${code}${check === undefined ? "" : ` (${check})`}`);
    this.name = "StructuralError";
    this.stage = stage;
    this.code = code;
    if (check !== undefined) {
      this.check = check;
    }
  }
}

export interface ValidationBackend {
  /** Synchronous scaffold call; throws StructuralError on envelope failure. */
  call(op: string, args: Record<string, unknown>): unknown;
}

/**
 * Scaffold backend over caller-supplied glue. The ABI version is
 * checked at construction: a mismatched module fails here, never
 * mid-request.
 */
export function validationBackend(glue: ValidationGlue): ValidationBackend {
  const abi = glue.structural_abi_version();
  if (abi !== REQUIRED_STRUCTURAL_ABI) {
    throw new StructuralError("transport", "version/unsupported");
  }
  return {
    call(op: string, args: Record<string, unknown>): unknown {
      const request = JSON.stringify({ v: REQUIRED_STRUCTURAL_ABI, op, args });
      const response = JSON.parse(glue.validation_call(request)) as {
        ok: boolean;
        value?: unknown;
        stage?: StructuralStage;
        code?: string;
        check?: string;
      };
      if (!response.ok) {
        throw new StructuralError(
          response.stage ?? "transport",
          response.code ?? "args/malformed",
          response.check,
        );
      }
      return response.value;
    },
  };
}
