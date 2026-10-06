/**
 * T34-F5 cohort specs: state-owned encodings of the two adopted cohort
 * spellings (whole-model + parent-anchored reverse collection).
 *
 * No syntax lives here (resolution forbids new authoring syntax): these
 * are the runtime cohort descriptors the membership producer freezes
 * under an explicit source-occurrence/handler cutoff. Anything outside
 * the two spellings stays diagnosed (`FanoutCohortDiagnosis`, F1), never
 * silently served.
 */

import type {
  FanoutChildId,
  FanoutCohortDiagnosis,
  FanoutCohortDiagnosisKind,
  FanoutCohortKind,
} from '../../../contracts/src/work.js';
import { StateError } from '../errors.js';

/**
 * Adopted cohort spec: whole-model enumeration of one model, or the
 * contained reverse collection of one pinned parent record. `owner` is
 * the operating owner's attestation: a spec naming any other owner is a
 * cross-owner cohort the child transaction cannot cross (diagnosed,
 * never driven).
 */
export type FanoutCohortSpec =
  | {
      readonly kind: 'model';
      readonly owner: string;
      readonly model: string;
    }
  | {
      readonly kind: 'anchored-collection';
      readonly owner: string;
      readonly model: string;
      readonly parent: { readonly model: string; readonly id: string };
    };

/** Explicit source-occurrence/handler admission cutoff (F1 `FanoutCutoff`). */
export interface FanoutCutoffSpec {
  readonly sourceOccurrence: string;
  /** Canonical handler contract identity admitting this cohort. */
  readonly handler: string;
}

function checkSpecString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new StateError('validation', `Fanout cohort ${what} must be a non-empty string.`);
  }
  return value;
}

/**
 * Validate one cohort spec shape, failing closed. Returns the cohort
 * kind for the intent row. Malformed specs are caller `validation`
 * errors; well-formed specs outside the adopted contract are diagnosed
 * by `diagnoseCohort` instead (see below).
 */
export function checkCohortSpec(spec: FanoutCohortSpec): FanoutCohortKind {
  if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) {
    throw new StateError('validation', 'Fanout cohort spec must be an object.');
  }
  checkSpecString(spec.owner, 'owner');
  checkSpecString(spec.model, 'model');
  if (spec.kind === 'model') {
    return 'model';
  }
  if (spec.kind === 'anchored-collection') {
    const parent = (spec as { readonly parent?: unknown }).parent;
    if (typeof parent !== 'object' || parent === null || Array.isArray(parent)) {
      throw new StateError('validation', 'Fanout anchored cohort needs a parent record.');
    }
    const record = parent as Record<string, unknown>;
    checkSpecString(record['model'], 'parent model');
    checkSpecString(record['id'], 'parent id');
    return 'anchored-collection';
  }
  throw new StateError(
    'validation',
    `Fanout cohort kind is outside the adopted contract: ${JSON.stringify((spec as { readonly kind?: unknown }).kind)}.`,
  );
}

/** Validate one cutoff spec shape, failing closed. */
export function checkCutoffSpec(cutoff: FanoutCutoffSpec): void {
  if (typeof cutoff !== 'object' || cutoff === null || Array.isArray(cutoff)) {
    throw new StateError('validation', 'Fanout cutoff must be an object.');
  }
  checkSpecString(cutoff.sourceOccurrence, 'sourceOccurrence');
  checkSpecString(cutoff.handler, 'handler');
}

const DIAGNOSIS_CODES: Record<FanoutCohortDiagnosisKind, string> = {
  'unsupported-cohort': 'fanout.unsupported_cohort',
  'cross-owner-cohort': 'fanout.cross_owner_cohort',
  'membership-unavailable': 'fanout.membership_unavailable',
};

/**
 * Build one closed cohort-admission diagnosis (F1). Closed kinds; no
 * silent skip, no fabricated grant, no membership data.
 */
export function diagnoseCohort(
  kind: FanoutCohortDiagnosisKind,
  message: string,
): FanoutCohortDiagnosis {
  if (typeof message !== 'string' || message === '') {
    throw new StateError('validation', 'Fanout diagnosis needs a non-empty message.');
  }
  return { kind, code: DIAGNOSIS_CODES[kind], message };
}

/**
 * Stable child occurrence identity (F1 `FanoutChildId`): parent/source
 * occurrence plus canonical handler identity plus canonical record
 * identity. The handler component prevents Commitment/Swap or other
 * handlers on one source event from colliding. Validated here so every
 * producer names the same triple; duplicate delivery replays under this
 * identity and mints nothing new.
 */
export function checkFanoutChildId(child: FanoutChildId): FanoutChildId {
  if (typeof child !== 'object' || child === null || Array.isArray(child)) {
    throw new StateError('validation', 'Fanout child identity must be an object.');
  }
  return {
    parentOccurrence: checkSpecString(child.parentOccurrence, 'child parentOccurrence'),
    handler: checkSpecString(child.handler, 'child handler'),
    recordId: checkSpecString(child.recordId, 'child recordId'),
  };
}
