/** Portable mail transport admission profile. */
export type MailScript =
  | { readonly kind: "accept" }
  | { readonly kind: "reject"; readonly status: number; readonly body: unknown }
  | { readonly kind: "flaky-then-accept"; readonly failures: number }
  | { readonly kind: "invalid-schema"; readonly body: unknown }
  | {
      readonly kind: "hang";
      readonly reconcile: "accepted" | "rejected" | "pending";
    }
  | {
      readonly kind: "redirect";
      readonly status: number;
      readonly location: string;
    }
  | { readonly kind: "drip"; readonly delayMs: number };

/** Portable model transport admission profile. */
export type ModelsScript =
  | { readonly kind: "final"; readonly body: unknown }
  | {
      readonly kind: "stream";
      readonly lines: readonly unknown[];
      readonly lineDelayMs?: number;
    }
  | { readonly kind: "reject"; readonly status: number; readonly body: unknown }
  | { readonly kind: "hang" }
  | { readonly kind: "invalid-schema"; readonly body: unknown };

/** Portable judgment transport admission profile. */
export type JudgmentsScript =
  | { readonly kind: "accept"; readonly body: unknown }
  | { readonly kind: "reject"; readonly status: number; readonly body: unknown }
  | { readonly kind: "hang" }
  | { readonly kind: "invalid-schema"; readonly body: unknown };


/** Portable script admission; each caller retains its owning error constructor. */
export function createScenarioAdmission(ErrorType: new (message: string) => Error) {
  /** Deep JSON-safety: tables must survive a JSON round-trip intact. */
  function checkJsonSafe(value: unknown, what: string): void {
    const seen = new Set<object>();
    const visit = (node: unknown, path: string): void => {
      if (node === null) return;
      switch (typeof node) {
        case 'string':
        case 'boolean':
          return;
        case 'number':
          if (!Number.isFinite(node)) {
            throw new ErrorType(`${what}${path} must be finite JSON.`);
          }
          return;
        case 'undefined':
        case 'function':
        case 'symbol':
        case 'bigint':
          throw new ErrorType(`${what}${path} is not JSON-safe.`);
        case 'object': {
          if (seen.has(node)) {
            throw new ErrorType(`${what}${path} is cyclic.`);
          }
          seen.add(node);
          if (Array.isArray(node)) {
            node.forEach((entry, index) => visit(entry, `${path}[${index}]`));
            return;
          }
          for (const [key, entry] of Object.entries(node)) {
            visit(entry, `${path}.${key}`);
          }
          return;
        }
      }
    };
    visit(value, '');
  }

  function checkRecord(value: unknown, what: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new ErrorType(`${what} must be an object.`);
    }
    return value as Record<string, unknown>;
  }

  function checkKind(
    record: Record<string, unknown>,
    what: string,
    kinds: ReadonlySet<string>,
  ): string {
    if (typeof record['kind'] !== 'string' || !kinds.has(record['kind'])) {
      throw new ErrorType(
        `${what} has an unknown kind ${JSON.stringify(record['kind'])}.`,
      );
    }
    return record['kind'];
  }

  /** Strict allowlist: unknown keys are typos, never passed through. */
  function checkKeys(
    record: Record<string, unknown>,
    what: string,
    allowed: ReadonlySet<string>,
  ): void {
    for (const key of Object.keys(record)) {
      if (!allowed.has(key)) {
        throw new ErrorType(`${what} has an unknown key ${JSON.stringify(key)}.`);
      }
    }
  }

  function checkStatus(value: unknown, what: string): number {
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < 100 ||
      value > 599
    ) {
      throw new ErrorType(`${what} must be an integer HTTP status.`);
    }
    return value;
  }

  function checkDelay(value: unknown, what: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new ErrorType(`${what} must be a finite delay >= 0.`);
    }
    return value;
  }

  const MAIL_KINDS: ReadonlySet<string> = new Set([
    'accept',
    'reject',
    'flaky-then-accept',
    'invalid-schema',
    'hang',
    'redirect',
    'drip',
  ]);

  const MAIL_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
    'accept': new Set(['kind']),
    'reject': new Set(['kind', 'status', 'body']),
    'flaky-then-accept': new Set(['kind', 'failures']),
    'invalid-schema': new Set(['kind', 'body']),
    'hang': new Set(['kind', 'reconcile']),
    'redirect': new Set(['kind', 'status', 'location']),
    'drip': new Set(['kind', 'delayMs']),
  };

  const MAIL_RECONCILE: ReadonlySet<string> = new Set([
    'accepted',
    'rejected',
    'pending',
  ]);

  /** Validate a mail transport script; JSON-safe and harness-identical. */
  function checkMailScript(script: unknown): MailScript {
    const record = checkRecord(script, 'mail script');
    const kind = checkKind(record, 'mail script', MAIL_KINDS);
    checkKeys(record, 'mail script', MAIL_KEYS[kind] ?? new Set(['kind']));
    checkJsonSafe(record, 'mail script');
    switch (kind) {
      case 'reject':
        checkStatus(record['status'], 'mail reject status');
        if (!('body' in record)) {
          throw new ErrorType('mail reject needs a body.');
        }
        break;
      case 'flaky-then-accept': {
        const failures = record['failures'];
        if (
          typeof failures !== 'number' ||
          !Number.isInteger(failures) ||
          failures < 0
        ) {
          throw new ErrorType('mail flaky failures must be an integer >= 0.');
        }
        break;
      }
      case 'invalid-schema':
        if (!('body' in record)) {
          throw new ErrorType('mail invalid-schema needs a body.');
        }
        break;
      case 'hang':
        if (
          typeof record['reconcile'] !== 'string' ||
          !MAIL_RECONCILE.has(record['reconcile'])
        ) {
          throw new ErrorType(
            'mail hang reconcile must be accepted, rejected or pending.',
          );
        }
        break;
      case 'redirect':
        checkStatus(record['status'], 'mail redirect status');
        if (
          typeof record['location'] !== 'string' ||
          record['location'] === ''
        ) {
          throw new ErrorType('mail redirect needs a location.');
        }
        break;
      case 'drip':
        checkDelay(record['delayMs'], 'mail drip delayMs');
        break;
    }
    return record as unknown as MailScript;
  }

  const MODELS_KINDS: ReadonlySet<string> = new Set([
    'final',
    'stream',
    'reject',
    'hang',
    'invalid-schema',
  ]);

  const MODELS_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
    'final': new Set(['kind', 'body']),
    'stream': new Set(['kind', 'lines', 'lineDelayMs']),
    'reject': new Set(['kind', 'status', 'body']),
    'hang': new Set(['kind']),
    'invalid-schema': new Set(['kind', 'body']),
  };

  /** Validate a models transport script; JSON-safe and harness-identical. */
  function checkModelsScript(script: unknown): ModelsScript {
    const record = checkRecord(script, 'models script');
    const kind = checkKind(record, 'models script', MODELS_KINDS);
    checkKeys(record, 'models script', MODELS_KEYS[kind] ?? new Set(['kind']));
    checkJsonSafe(record, 'models script');
    switch (kind) {
      case 'final':
      case 'invalid-schema':
        if (!('body' in record)) {
          throw new ErrorType(`models ${kind} needs a body.`);
        }
        break;
      case 'stream':
        if (!Array.isArray(record['lines'])) {
          throw new ErrorType('models stream needs a lines array.');
        }
        if (record['lineDelayMs'] !== undefined) {
          checkDelay(record['lineDelayMs'], 'models stream lineDelayMs');
        }
        break;
      case 'reject':
        checkStatus(record['status'], 'models reject status');
        if (!('body' in record)) {
          throw new ErrorType('models reject needs a body.');
        }
        break;
    }
    return record as unknown as ModelsScript;
  }

  const JUDGMENTS_KINDS: ReadonlySet<string> = new Set([
    'accept',
    'reject',
    'hang',
    'invalid-schema',
  ]);

  const JUDGMENTS_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
    'accept': new Set(['kind', 'body']),
    'reject': new Set(['kind', 'status', 'body']),
    'hang': new Set(['kind']),
    'invalid-schema': new Set(['kind', 'body']),
  };

  /** Validate a judgments transport script; JSON-safe and harness-identical. */
  function checkJudgmentsScript(
    script: unknown,
  ): JudgmentsScript {
    const record = checkRecord(script, 'judgments script');
    const kind = checkKind(record, 'judgments script', JUDGMENTS_KINDS);
    checkKeys(
      record,
      'judgments script',
      JUDGMENTS_KEYS[kind] ?? new Set(['kind']),
    );
    checkJsonSafe(record, 'judgments script');
    if (kind === 'accept' || kind === 'invalid-schema') {
      if (!('body' in record)) {
        throw new ErrorType(`judgments ${kind} needs a body.`);
      }
    }
    if (kind === 'reject') {
      checkStatus(record['status'], 'judgments reject status');
      if (!('body' in record)) {
        throw new ErrorType('judgments reject needs a body.');
      }
    }
    return record as unknown as JudgmentsScript;
  }

  const MEDIA_KINDS: ReadonlySet<string> = new Set([
    'accept',
    'reject-prompt',
    'hang-submit',
    'hang-all',
  ]);

  const MEDIA_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
    'accept': new Set(['kind', 'history', 'filesBase64', 'promptBody', 'cancelStatus']),
    'reject-prompt': new Set(['kind', 'status', 'body', 'cancelStatus']),
    'hang-submit': new Set(['kind', 'history', 'filesBase64', 'cancelStatus']),
    'hang-all': new Set(['kind', 'cancelStatus']),
  };

  function checkMediaScript(script: unknown) {
    const record = checkRecord(script, 'media script');
    const kind = checkKind(record, 'media script', MEDIA_KINDS);
    checkKeys(record, 'media script', MEDIA_KEYS[kind] ?? new Set(['kind']));
    checkJsonSafe(record, 'media script');
    return { record, kind };
  }

  return { checkRecord, checkKeys, checkStatus, checkMailScript, checkModelsScript, checkJudgmentsScript, checkMediaScript };
}
