/**
 * Lane 03 S8: thin `@canlang/stdlib` export assembly (v0).
 *
 * The façade re-exports producer surfaces VERBATIM per filed lane
 * requests — no wrappers, no synonyms, no back-imports (PLAN/CONTRACTS).
 * v0 retains lane-02's filed FACADE REQUEST (groups (a)–(d)), the
 * requested type surface and subsequent checked producer joins.
 * Invocation re-exports the existing pure Values constructor for checked
 * complete-call construction; it neither executes nor authorizes a call.
 *
 * NOT in v0 (recorded gaps, not inventions): app-level record/query/
 * mutation/send/schedule builtins (`records`, `create`, `set`, …) have
 * no producer implementation and no filed L1 call-shape contract —
 * owning producers implement them against L1 T4 emission, then request
 * assembly. Engine internals (`@canlang/state` ports, storage,
 * migration) stay producer-direct for platform consumers (L6/L7 import
 * producers, never this façade back).
 */
export const STDLIB_CONTRACT_VERSION = 1;

// (a) Requested pure builtins plus the implemented invocation constructor.
export {
  abs,
  action,
  add_days,
  add_months,
  all,
  any,
  app_url,
  at,
  choose,
  contains,
  count,
  date,
  date_year,
  datetime,
  dates,
  first,
  flatten,
  format,
  group,
  invocation,
  join,
  local_date,
  local_instant,
  lower,
  max,
  min,
  money,
  overlaps,
  round,
  starts_with,
  sum,
  trim,
  upper,
  weekday,
} from '@canlang/values';

// (b) 22 §13+gap helpers (lane-02 request, verbatim).
export {
  addDecimal,
  addDuration,
  addMoney,
  compareDate,
  compareDecimal,
  compareInstant,
  compareMoney,
  divideDecimal,
  divideDurationByInt,
  divideMoney,
  durationBetween,
  equalMoney,
  equalValue,
  int64,
  multiplyDecimal,
  multiplyMoney,
  negateDecimal,
  negateMoney,
  same,
  subtractDecimal,
  subtractDuration,
  subtractMoney,
} from '@canlang/values';

// (c) operator/lowering support, 27 names (lane-02 request, verbatim).
export {
  absDecimal,
  absDuration,
  absInt,
  absMoney,
  addInt,
  compareDuration,
  compareInt,
  compareScalar,
  concat,
  divideDurationMs,
  equalDecimal,
  formatMessage,
  formatPlain,
  moneyRatio,
  modInt,
  multiplyDuration,
  multiplyInt,
  negateDuration,
  negateInt,
  remainderDuration,
  scalarChars,
  scalarLength,
  subtractInt,
  sumDecimal,
  sumDuration,
  sumInt,
  sumMoney,
} from '@canlang/values';

// (d) data plane, 58 names (lane-02 request, verbatim; `int64` rides in
// group (b) and is not repeated here).
export {
  assertTimezone,
  canonicalLocale,
  CATALOG,
  CURRENCY_MINOR_UNITS,
  currencyScale,
  DATETIME_MAX_MS,
  DATETIME_MIN_MS,
  Decimal,
  decimalToString,
  decodeValue,
  encodeValue,
  INT64_MAX,
  INT64_MIN,
  isActionRef,
  isCurrencyShape,
  isDateValue,
  isDatetime,
  isDecimal,
  isDeliveryRef,
  isFileValue,
  isKnownCurrency,
  isMemberRef,
  isMessageDescriptor,
  isMoney,
  isRecordRef,
  isTimezone,
  isTypeId,
  isUnionValue,
  isUpdateOmitted,
  isUserRef,
  LANE02_CATALOG_VERSION,
  lookupChain,
  makeActionRef,
  makeDate,
  makeDatetime,
  makeDeliveryRef,
  makeFileValue,
  makeMemberRef,
  makeMessageDescriptor,
  makeMoney,
  makeRecordRef,
  makeUnionValue,
  makeUserRef,
  normalizeSchema,
  parseDecimal,
  parseMessageFormat,
  parseTypeId,
  printTypeBase,
  printTypeId,
  renderMessage,
  resolveVariant,
  SchemaError,
  UPDATE_OMITTED,
  validateMessagePattern,
  validateOperationInput,
  validateValue,
  ValueError,
  VALUES_CONTRACT_VERSION,
} from '@canlang/values';

// "Corresponding TS types alongside each group" (the request's words):
// the values barrel's full type surface, enumerated explicitly (66
// names). Lane-02 trims on follow-up request; until then the assembly
// stays mechanical-complete rather than curating by guess.
export type {
  ActionRef,
  CanByteQuantity,
  CanDuration,
  CanInt,
  CanMinor,
  CanTypeId,
  CanValue,
  CanVersion,
  CatalogEnvelope,
  CatalogEntry,
  CatalogFeature,
  ContractDescriptor,
  ContractValue,
  DateValue,
  DatetimeValue,
  DecimalValue,
  DeliveryRef,
  EnumDescriptor,
  FieldDescriptor,
  FileValue,
  Fold,
  FormatMessageOptions,
  FormattedMessage,
  IcuBranch,
  IcuDateTimeStyle,
  IcuExactSelector,
  InvocationRef,
  InvocationWire,
  MemberRef,
  MessageDescriptor,
  MessageNode,
  MessageParam,
  MessageParamType,
  MoneyValue,
  NormalizedContract,
  NormalizedEnum,
  NormalizedField,
  NormalizedOperation,
  NormalizedSchema,
  NormalizedType,
  OperationDescriptor,
  ParsedMessage,
  PlainDisplayValue,
  RecordRef,
  RenderMessageOptions,
  ResolvedVariant,
  ScalarName,
  SecretValue,
  SchemaDescriptor,
  StringLikeName,
  SumElement,
  TypeBase,
  UnionValue,
  UpdateContract,
  UserRef,
  ValidationMode,
  ValueFailureCode,
  Violation,
  ViolationCode,
  WireDelivery,
  WireFile,
  WireMoney,
  WireRefMutation,
  WireRefRead,
  WireUnion,
  WireValue,
} from '@canlang/values';

// Stored lifecycle effects are produced by the canonical state engine.
export { transition } from '@canlang/state/effects/transition';

// Filed runtime-export-join request: synchronous handler guards, verbatim.
export { require, hasRole } from '@canlang/state/effects/guards';

// Selected receipt observation is produced by the canonical state scope.
export { delivery } from '@canlang/state/effects/delivery';
