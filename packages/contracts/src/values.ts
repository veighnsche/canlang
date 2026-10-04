/**
 * Lane 02 producer contract: exact values boundary (types only).
 *
 * This file carries the shared data/type shapes for canonical values, wire
 * encodings, schema violations, typed errors and the builtin-signature
 * catalog envelope. It defines no execution engine or behavior. Consumers
 * must not guess imports: this is the single definition of these shapes.
 *
 * Business error codes live in lane 03's `state.ts` (`StateErrorCode`); lane 02
 * never raises business errors, so they are not repeated here.
 *
 * Status: v1 draft for PR1. Schema descriptor types land with PR5; breaking
 * changes need the affected owners' explicit handoff per
 * implementation/CONTRACTS.md.
 */

/** This contract's version. The values build checks it against its own. */
export const VALUES_CONTRACT_VERSION = 1;

/** Signed 64-bit integer. Runtime representation: bigint. */
export type CanInt = bigint;
/** Integer milliseconds. Runtime representation: bigint. */
export type CanDuration = bigint;
/** Integer bytes. Runtime representation: bigint. */
export type CanByteQuantity = bigint;
/** Money minor units. Runtime representation: bigint. */
export type CanMinor = bigint;
/** Record version. Runtime representation: bigint. */
export type CanVersion = bigint;

/** Exact decimal: unnormalized coefficient plus scale 0..18. */
export interface DecimalValue {
  readonly kind: "decimal";
  readonly coef: bigint;
  readonly scale: number;
}

export interface MoneyValue {
  readonly kind: "money";
  readonly minor: bigint;
  readonly currency: string;
}

export interface DateValue {
  readonly kind: "date";
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/** Millisecond-precision UTC instant. */
export interface DatetimeValue {
  readonly kind: "datetime";
  readonly ms: bigint;
}

export interface UserRef {
  readonly kind: "user";
  readonly id: string;
}

export interface MemberRef {
  readonly kind: "member";
  readonly id: string;
  readonly user: UserRef;
  readonly team: string;
}

/** A reference to a stored row: identity, never an embedded copy. */
export interface RecordRef {
  readonly kind: "ref";
  readonly model: string;
  readonly id: string;
  readonly version?: CanVersion;
}

export interface ActionRef {
  readonly kind: "action";
  readonly target: string;
  readonly bindings: Readonly<Record<string, RecordRef>>;
}

/** Opaque association to one durable delivery of a bound operation. */
export interface DeliveryRef {
  readonly kind: "delivery";
  readonly id: string;
  readonly operation: string;
}

/** Completed immutable file identity. Neither finalized nor authorized. */
export interface FileValue {
  readonly kind: "file";
  readonly id: string;
}

/** Opaque server-only secret. Never serialized. */
export interface SecretValue {
  readonly kind: "secret";
}

export interface UnionValue {
  readonly kind: "union";
  readonly type: string;
  readonly value: CanValue;
}

/** Named structural value, stored by value. */
export interface ContractValue {
  readonly [field: string]: CanValue;
}

export type CanValue =
  | bigint
  | string
  | boolean
  | null
  | DecimalValue
  | MoneyValue
  | DateValue
  | DatetimeValue
  | UserRef
  | MemberRef
  | RecordRef
  | ContractValue
  | UnionValue
  | ActionRef
  | DeliveryRef
  | FileValue
  | SecretValue
  | CanValue[];

/**
 * Canonical type id, e.g. "int", "user?", "text[]", "expense.Expense.status".
 * Scalar ids, `?` nullability, `[]` arrays, `A|B` unions and qualified nominal
 * identities. Parsed by the schema module; kept a string here by design.
 */
export type CanTypeId = string;

/** Plain JSON data. Exact scalars use canonical decimal strings, never numbers. */
export type WireValue =
  | string
  | number
  | boolean
  | null
  | WireValue[]
  | { [key: string]: WireValue };

/** Money on the wire: decimal-string minor units plus currency code. */
export interface WireMoney {
  minor: string;
  currency: string;
}

export interface WireRefRead {
  id: string;
}

export interface WireRefMutation {
  id: string;
  version: string;
}

export interface WireUnion {
  type: string;
  value: WireValue;
}

export interface WireDelivery {
  id: string;
  operation: string;
}

export interface WireFile {
  id: string;
}

/**
 * Schema-violation codes. These live in the schema domain: the shared `limit`
 * token with lane 03's business `StateErrorCode` is a coincidence of naming,
 * not a shared code — a violation never satisfies a business error.
 */
export type ViolationCode =
  | "required"
  | "type"
  | "format"
  | "bound"
  | "unknown-field"
  | "unknown-argument"
  | "limit";

export interface Violation {
  readonly path: ReadonlyArray<string | number>;
  readonly code: ViolationCode;
  readonly message: string;
  readonly expected?: string;
  readonly actual?: string;
}

/**
 * The closed `{code,message}` delivery error value is owned by lane 04
 * (`services.ts`, which landed first); it is intentionally not repeated here
 * (L7 handoff: L2+L4 deduplicate; interim barrel pick is services).
 */

/**
 * One catalog entry. Envelope shape follows the L1 IR-01 sketch
 * `{catalog_version, language_version, entries:[{id,owner,kind,signature,
 * effects,availability,deprecation?}]}`; `js`/`notes` are lane-02 additions
 * the Rust consumer may ignore. L1 acknowledgment pending.
 */
export interface CatalogEntry {
  /** Canonical Can name, e.g. "add_days". */
  readonly id: string;
  /** JS export name; equals `id` for builtins, DESIGN §13 name for helpers. */
  readonly js: string;
  /** Owning lane, e.g. "lane-02". External entries name their implementer. */
  readonly owner: string;
  readonly kind: "builtin" | "helper";
  /** Signature as stated in DESIGN §3 / §13. */
  readonly signature: string;
  readonly effects: "pure" | "server-default-only" | "state-read";
  readonly availability: "planned" | "implemented" | "external";
  readonly deprecation?: string;
  readonly notes?: string;
}

export interface CatalogFeature {
  readonly name: string;
  readonly status: "planned" | "draft" | "implemented";
  readonly description: string;
}

export interface CatalogEnvelope {
  readonly catalog_version: string;
  readonly language_version: string | null;
  readonly entries: ReadonlyArray<CatalogEntry>;
  readonly features: ReadonlyArray<CatalogFeature>;
}
