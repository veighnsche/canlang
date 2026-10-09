import { delivery as stateDelivery } from '@canlang/state/effects/delivery';
import { transition as stateTransition } from '@canlang/state/effects/transition';
import { require as stateRequire, hasRole as stateHasRole } from '@canlang/state/effects/guards';
/**
 * Lane 03 S8 stdlib assembly tests: the façade carries exactly lane-02's
 * requested surface plus invocation and choose (141 runtime names verbatim + the barrel's 66 types),
 * every binding identical to the producer's, plus live-call smoke proving
 * the bindings execute. Any producer drift (rename/removal) or façade
 * omission fails loudly here; barrel additions stay out until requested.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as stdlib from '../src/index.js';
import * as values from '@canlang/values';
import type * as stdlibTypes from '../src/index.js';
import type * as valuesTypes from '@canlang/values';

/** Filed FACADE REQUEST plus the existing Values invocation and choose joins. */
const EXPECTED_RUNTIME: ReadonlyArray<string> = [
  // (a) Historical pure builtin list plus invocation and choose.
  'count',
  'flatten',
  'sum',
  'min',
  'max',
  'any',
  'all',
  'first',
  'group',
  'invocation',
  'at',
  'choose',
  'abs',
  'round',
  'lower',
  'upper',
  'trim',
  'contains',
  'starts_with',
  'join',
  'format',
  'app_url',
  'overlaps',
  'local_date',
  'local_instant',
  'add_days',
  'add_months',
  'date_year',
  'weekday',
  'dates',
  'money',
  'date',
  'datetime',
  'action',
  // (b) 22 §13+gap helpers.
  'addMoney',
  'subtractMoney',
  'multiplyMoney',
  'compareMoney',
  'equalMoney',
  'negateMoney',
  'divideDecimal',
  'durationBetween',
  'compareInstant',
  'compareDate',
  'compareDecimal',
  'addDuration',
  'subtractDuration',
  'same',
  'equalValue',
  'int64',
  'addDecimal',
  'subtractDecimal',
  'multiplyDecimal',
  'negateDecimal',
  'divideMoney',
  'divideDurationByInt',
  // (c) 27 operator/lowering names.
  'addInt',
  'subtractInt',
  'multiplyInt',
  'modInt',
  'negateInt',
  'absInt',
  'compareInt',
  'absDecimal',
  'absMoney',
  'absDuration',
  'equalDecimal',
  'moneyRatio',
  'compareDuration',
  'negateDuration',
  'multiplyDuration',
  'remainderDuration',
  'divideDurationMs',
  'concat',
  'scalarLength',
  'scalarChars',
  'compareScalar',
  'sumInt',
  'sumDecimal',
  'sumDuration',
  'sumMoney',
  'formatPlain',
  'formatMessage',
  // (d) 58 data-plane names.
  'makeMoney',
  'makeDate',
  'makeDatetime',
  'makeUserRef',
  'makeMemberRef',
  'makeFileValue',
  'makeDeliveryRef',
  'makeRecordRef',
  'makeActionRef',
  'makeUnionValue',
  'isMoney',
  'isDateValue',
  'isDatetime',
  'isUserRef',
  'isMemberRef',
  'isFileValue',
  'isDeliveryRef',
  'isRecordRef',
  'isActionRef',
  'isUnionValue',
  'isCurrencyShape',
  'isDecimal',
  'Decimal',
  'parseDecimal',
  'decimalToString',
  'INT64_MIN',
  'INT64_MAX',
  'DATETIME_MIN_MS',
  'DATETIME_MAX_MS',
  'currencyScale',
  'isKnownCurrency',
  'CURRENCY_MINOR_UNITS',
  'isTimezone',
  'assertTimezone',
  'canonicalLocale',
  'lookupChain',
  'resolveVariant',
  'isMessageDescriptor',
  'makeMessageDescriptor',
  'parseMessageFormat',
  'validateMessagePattern',
  'renderMessage',
  'parseTypeId',
  'isTypeId',
  'printTypeBase',
  'printTypeId',
  'encodeValue',
  'decodeValue',
  'normalizeSchema',
  'validateValue',
  'validateOperationInput',
  'UPDATE_OMITTED',
  'isUpdateOmitted',
  'ValueError',
  'SchemaError',
  'CATALOG',
  'LANE02_CATALOG_VERSION',
  'VALUES_CONTRACT_VERSION',
];

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

// Type identity pins (compile-time): each fails to compile if the
// façade's re-export drifts from the producer's declaration.
const pin_ActionRef: Equal<stdlibTypes.ActionRef, valuesTypes.ActionRef> = true;
const pin_CanByteQuantity: Equal<stdlibTypes.CanByteQuantity, valuesTypes.CanByteQuantity> = true;
const pin_CanDuration: Equal<stdlibTypes.CanDuration, valuesTypes.CanDuration> = true;
const pin_CanInt: Equal<stdlibTypes.CanInt, valuesTypes.CanInt> = true;
const pin_CanMinor: Equal<stdlibTypes.CanMinor, valuesTypes.CanMinor> = true;
const pin_CanTypeId: Equal<stdlibTypes.CanTypeId, valuesTypes.CanTypeId> = true;
const pin_CanValue: Equal<stdlibTypes.CanValue, valuesTypes.CanValue> = true;
const pin_CanVersion: Equal<stdlibTypes.CanVersion, valuesTypes.CanVersion> = true;
const pin_CatalogEnvelope: Equal<stdlibTypes.CatalogEnvelope, valuesTypes.CatalogEnvelope> = true;
const pin_CatalogEntry: Equal<stdlibTypes.CatalogEntry, valuesTypes.CatalogEntry> = true;
const pin_CatalogFeature: Equal<stdlibTypes.CatalogFeature, valuesTypes.CatalogFeature> = true;
const pin_ContractDescriptor: Equal<stdlibTypes.ContractDescriptor, valuesTypes.ContractDescriptor> = true;
const pin_ContractValue: Equal<stdlibTypes.ContractValue, valuesTypes.ContractValue> = true;
const pin_DateValue: Equal<stdlibTypes.DateValue, valuesTypes.DateValue> = true;
const pin_DatetimeValue: Equal<stdlibTypes.DatetimeValue, valuesTypes.DatetimeValue> = true;
const pin_DecimalValue: Equal<stdlibTypes.DecimalValue, valuesTypes.DecimalValue> = true;
const pin_DeliveryRef: Equal<stdlibTypes.DeliveryRef, valuesTypes.DeliveryRef> = true;
const pin_EnumDescriptor: Equal<stdlibTypes.EnumDescriptor, valuesTypes.EnumDescriptor> = true;
const pin_FieldDescriptor: Equal<stdlibTypes.FieldDescriptor, valuesTypes.FieldDescriptor> = true;
const pin_FileValue: Equal<stdlibTypes.FileValue, valuesTypes.FileValue> = true;
const pin_Fold: Equal<stdlibTypes.Fold, valuesTypes.Fold> = true;
const pin_FormatMessageOptions: Equal<stdlibTypes.FormatMessageOptions, valuesTypes.FormatMessageOptions> = true;
const pin_FormattedMessage: Equal<stdlibTypes.FormattedMessage, valuesTypes.FormattedMessage> = true;
const pin_IcuBranch: Equal<stdlibTypes.IcuBranch, valuesTypes.IcuBranch> = true;
const pin_IcuDateTimeStyle: Equal<stdlibTypes.IcuDateTimeStyle, valuesTypes.IcuDateTimeStyle> = true;
const pin_IcuExactSelector: Equal<stdlibTypes.IcuExactSelector, valuesTypes.IcuExactSelector> = true;
const pin_InvocationRef: Equal<stdlibTypes.InvocationRef, valuesTypes.InvocationRef> = true;
const pin_InvocationWire: Equal<stdlibTypes.InvocationWire, valuesTypes.InvocationWire> = true;
const pin_MemberRef: Equal<stdlibTypes.MemberRef, valuesTypes.MemberRef> = true;
const pin_MessageDescriptor: Equal<stdlibTypes.MessageDescriptor, valuesTypes.MessageDescriptor> = true;
const pin_MessageNode: Equal<stdlibTypes.MessageNode, valuesTypes.MessageNode> = true;
const pin_MessageParam: Equal<stdlibTypes.MessageParam, valuesTypes.MessageParam> = true;
const pin_MessageParamType: Equal<stdlibTypes.MessageParamType, valuesTypes.MessageParamType> = true;
const pin_MoneyValue: Equal<stdlibTypes.MoneyValue, valuesTypes.MoneyValue> = true;
const pin_NormalizedContract: Equal<stdlibTypes.NormalizedContract, valuesTypes.NormalizedContract> = true;
const pin_NormalizedEnum: Equal<stdlibTypes.NormalizedEnum, valuesTypes.NormalizedEnum> = true;
const pin_NormalizedField: Equal<stdlibTypes.NormalizedField, valuesTypes.NormalizedField> = true;
const pin_NormalizedOperation: Equal<stdlibTypes.NormalizedOperation, valuesTypes.NormalizedOperation> = true;
const pin_NormalizedSchema: Equal<stdlibTypes.NormalizedSchema, valuesTypes.NormalizedSchema> = true;
const pin_NormalizedType: Equal<stdlibTypes.NormalizedType, valuesTypes.NormalizedType> = true;
const pin_OperationDescriptor: Equal<stdlibTypes.OperationDescriptor, valuesTypes.OperationDescriptor> = true;
const pin_ParsedMessage: Equal<stdlibTypes.ParsedMessage, valuesTypes.ParsedMessage> = true;
const pin_PlainDisplayValue: Equal<stdlibTypes.PlainDisplayValue, valuesTypes.PlainDisplayValue> = true;
const pin_RecordRef: Equal<stdlibTypes.RecordRef, valuesTypes.RecordRef> = true;
const pin_RenderMessageOptions: Equal<stdlibTypes.RenderMessageOptions, valuesTypes.RenderMessageOptions> = true;
const pin_ResolvedVariant: Equal<stdlibTypes.ResolvedVariant, valuesTypes.ResolvedVariant> = true;
const pin_ScalarName: Equal<stdlibTypes.ScalarName, valuesTypes.ScalarName> = true;
const pin_SecretValue: Equal<stdlibTypes.SecretValue, valuesTypes.SecretValue> = true;
const pin_SchemaDescriptor: Equal<stdlibTypes.SchemaDescriptor, valuesTypes.SchemaDescriptor> = true;
const pin_StringLikeName: Equal<stdlibTypes.StringLikeName, valuesTypes.StringLikeName> = true;
const pin_SumElement: Equal<stdlibTypes.SumElement, valuesTypes.SumElement> = true;
const pin_TypeBase: Equal<stdlibTypes.TypeBase, valuesTypes.TypeBase> = true;
const pin_UnionValue: Equal<stdlibTypes.UnionValue, valuesTypes.UnionValue> = true;
const pin_UpdateContract: Equal<stdlibTypes.UpdateContract, valuesTypes.UpdateContract> = true;
const pin_UserRef: Equal<stdlibTypes.UserRef, valuesTypes.UserRef> = true;
const pin_ValidationMode: Equal<stdlibTypes.ValidationMode, valuesTypes.ValidationMode> = true;
const pin_ValueFailureCode: Equal<stdlibTypes.ValueFailureCode, valuesTypes.ValueFailureCode> = true;
const pin_Violation: Equal<stdlibTypes.Violation, valuesTypes.Violation> = true;
const pin_ViolationCode: Equal<stdlibTypes.ViolationCode, valuesTypes.ViolationCode> = true;
const pin_WireDelivery: Equal<stdlibTypes.WireDelivery, valuesTypes.WireDelivery> = true;
const pin_WireFile: Equal<stdlibTypes.WireFile, valuesTypes.WireFile> = true;
const pin_WireMoney: Equal<stdlibTypes.WireMoney, valuesTypes.WireMoney> = true;
const pin_WireRefMutation: Equal<stdlibTypes.WireRefMutation, valuesTypes.WireRefMutation> = true;
const pin_WireRefRead: Equal<stdlibTypes.WireRefRead, valuesTypes.WireRefRead> = true;
const pin_WireUnion: Equal<stdlibTypes.WireUnion, valuesTypes.WireUnion> = true;
const pin_WireValue: Equal<stdlibTypes.WireValue, valuesTypes.WireValue> = true;

const TYPE_PINS: ReadonlyArray<true> = [
  pin_ActionRef,
  pin_CanByteQuantity,
  pin_CanDuration,
  pin_CanInt,
  pin_CanMinor,
  pin_CanTypeId,
  pin_CanValue,
  pin_CanVersion,
  pin_CatalogEnvelope,
  pin_CatalogEntry,
  pin_CatalogFeature,
  pin_ContractDescriptor,
  pin_ContractValue,
  pin_DateValue,
  pin_DatetimeValue,
  pin_DecimalValue,
  pin_DeliveryRef,
  pin_EnumDescriptor,
  pin_FieldDescriptor,
  pin_FileValue,
  pin_Fold,
  pin_FormatMessageOptions,
  pin_FormattedMessage,
  pin_IcuBranch,
  pin_IcuDateTimeStyle,
  pin_IcuExactSelector,
  pin_InvocationRef,
  pin_InvocationWire,
  pin_MemberRef,
  pin_MessageDescriptor,
  pin_MessageNode,
  pin_MessageParam,
  pin_MessageParamType,
  pin_MoneyValue,
  pin_NormalizedContract,
  pin_NormalizedEnum,
  pin_NormalizedField,
  pin_NormalizedOperation,
  pin_NormalizedSchema,
  pin_NormalizedType,
  pin_OperationDescriptor,
  pin_ParsedMessage,
  pin_PlainDisplayValue,
  pin_RecordRef,
  pin_RenderMessageOptions,
  pin_ResolvedVariant,
  pin_ScalarName,
  pin_SecretValue,
  pin_SchemaDescriptor,
  pin_StringLikeName,
  pin_SumElement,
  pin_TypeBase,
  pin_UnionValue,
  pin_UpdateContract,
  pin_UserRef,
  pin_ValidationMode,
  pin_ValueFailureCode,
  pin_Violation,
  pin_ViolationCode,
  pin_WireDelivery,
  pin_WireFile,
  pin_WireMoney,
  pin_WireRefMutation,
  pin_WireRefRead,
  pin_WireUnion,
  pin_WireValue,
];

describe('stdlib assembly', () => {
  it('exports exactly the requested surface plus the assembly version', () => {
    assert.equal(EXPECTED_RUNTIME.length, 141);
    assert.equal(TYPE_PINS.length, 66);
    const actual = Object.keys(stdlib).sort();
    const expected = [...EXPECTED_RUNTIME, 'transition', 'delivery', 'require', 'hasRole', 'STDLIB_CONTRACT_VERSION'].sort();
    assert.deepEqual(actual, expected);
  });

  it('re-exports producer bindings identically (no wrappers)', () => {
    const facade = stdlib as unknown as Record<string, unknown>;
    const producer = values as unknown as Record<string, unknown>;
    for (const name of EXPECTED_RUNTIME) {
      assert.strictEqual(facade[name], producer[name], `binding ${name} differs`);
    }
    assert.strictEqual(stdlib.transition, stateTransition);
    assert.strictEqual(stdlib.delivery, stateDelivery);
    assert.strictEqual(stdlib.require, stateRequire);
    assert.strictEqual(stdlib.hasRole, stateHasRole);
    assert.equal(stdlib.STDLIB_CONTRACT_VERSION, 1);
  });

  it('holds all 66 type identity pins', () => {
    assert.ok(TYPE_PINS.every((pin) => pin === true));
  });

  it('executes façade bindings against the real producer', () => {
    assert.equal(stdlib.trim('  padded  '), 'padded');
    assert.equal(stdlib.addInt(40n, 2n), 42n);
    assert.equal(stdlib.count(['a', 'b', 'c']), 3n);
    assert.equal(stdlib.int64(7n), 7n);
    const amount = stdlib.makeMoney(100n, 'USD');
    assert.equal(stdlib.isMoney(amount), true);
    assert.equal(stdlib.isDecimal(stdlib.parseDecimal('1.5')), true);
  });
});
