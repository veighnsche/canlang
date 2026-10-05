# @canlang/stdlib

CanLang public standard library façade: a thin export assembly from
producer packages. It re-exports producer surfaces verbatim — no
wrappers, no synonyms, no back-imports.

v0 fulfills exactly one filed request: lane-02's FACADE REQUEST
(groups (a)–(d) in `src/index.ts`), 139 runtime names plus the
`@canlang/values` barrel's 66 TS types, guarded by the assembly test.
App-level record/query/mutation/send/schedule builtins are not in v0:
owning producers implement them, then request assembly.

## Install

Workspace package; no separate install. From the repo root:

```sh
bun install
```

`@canlang/values` must be built first (see `tsconfig.json` comment).
Depends on `@canlang/values` (`package.json`).

## Usage

```ts
import { sum, count, STDLIB_CONTRACT_VERSION, encodeValue } from '@canlang/stdlib';
import type { CanValue, MoneyValue } from '@canlang/stdlib';

sum([1n, 2n, 3n], "int"); // 6n
count(["a", "b"]); // 2n
STDLIB_CONTRACT_VERSION; // 1
```

Export groups (all re-exported verbatim from `@canlang/values`):

- `STDLIB_CONTRACT_VERSION` — façade contract version (`1`).
- (a) 32 pure builtins: `abs`, `action`, `add_days`, `add_months`,
  `all`, `any`, `app_url`, `at`, `contains`, `count`, `date`,
  `date_year`, `datetime`, `dates`, `first`, `flatten`, `format`,
  `group`, `join`, `local_date`, `local_instant`, `lower`, `max`,
  `min`, `money`, `overlaps`, `round`, `starts_with`, `sum`,
  `trim`, `upper`, `weekday`.
- (b) 22 §13+gap helpers: `addDecimal`, `addDuration`, `addMoney`,
  `compareDate`, `compareDecimal`, `compareInstant`, `compareMoney`,
  `divideDecimal`, `divideDurationByInt`, `divideMoney`,
  `durationBetween`, `equalMoney`, `equalValue`, `int64`,
  `multiplyDecimal`, `multiplyMoney`, `negateDecimal`, `negateMoney`,
  `same`, `subtractDecimal`, `subtractDuration`, `subtractMoney`.
- (c) 27 operator/lowering names: `absDecimal`, `absDuration`,
  `absInt`, `absMoney`, `addInt`, `compareDuration`, `compareInt`,
  `compareScalar`, `concat`, `divideDurationMs`, `equalDecimal`,
  `formatMessage`, `formatPlain`, `moneyRatio`, `modInt`,
  `multiplyDuration`, `multiplyInt`, `negateDuration`, `negateInt`,
  `remainderDuration`, `scalarChars`, `scalarLength`, `subtractInt`,
  `sumDecimal`, `sumDuration`, `sumInt`, `sumMoney`.
- (d) 58 data-plane names: `assertTimezone`, `canonicalLocale`,
  `CATALOG`, `CURRENCY_MINOR_UNITS`, `currencyScale`,
  `DATETIME_MAX_MS`, `DATETIME_MIN_MS`, `Decimal`,
  `decimalToString`, `decodeValue`, `encodeValue`, `INT64_MAX`,
  `INT64_MIN`, `isActionRef`, `isCurrencyShape`, `isDateValue`,
  `isDatetime`, `isDecimal`, `isDeliveryRef`, `isFileValue`,
  `isKnownCurrency`, `isMemberRef`, `isMessageDescriptor`, `isMoney`,
  `isRecordRef`, `isTimezone`, `isTypeId`, `isUnionValue`,
  `isUpdateOmitted`, `isUserRef`, `LANE02_CATALOG_VERSION`,
  `lookupChain`, `makeActionRef`, `makeDate`, `makeDatetime`,
  `makeDeliveryRef`, `makeFileValue`, `makeMemberRef`,
  `makeMessageDescriptor`, `makeMoney`, `makeRecordRef`,
  `makeUnionValue`, `makeUserRef`, `normalizeSchema`, `parseDecimal`,
  `parseMessageFormat`, `parseTypeId`, `printTypeBase`, `printTypeId`,
  `renderMessage`, `resolveVariant`, `SchemaError`,
  `UPDATE_OMITTED`, `validateMessagePattern`,
  `validateOperationInput`, `validateValue`, `ValueError`,
  `VALUES_CONTRACT_VERSION` (`int64` rides in group (b)).
- 66 TS types, e.g. `CanValue`, `MoneyValue`, `DateValue`,
  `DecimalValue`, `RecordRef`, `UserRef`, `WireValue`,
  `NormalizedSchema`, `Violation` (full list in `src/index.ts`).

## Scripts

Only scripts present in `package.json`:

| Script      | Command                                        |
| ----------- | ---------------------------------------------- |
| `build`     | `tsc -p tsconfig.json`                         |
| `typecheck` | `tsc -p tsconfig.json --noEmit`                |
| `test`      | `bun run build && node --test "dist/test/**/*.test.js"` |
| `clean`     | `rm -rf dist/`                                 |

Run from this directory, e.g. `bun run build`, or via the root
workspace filter: `bun run --filter @canlang/stdlib build`.

## Source layout

- `src/index.ts` — the façade: all re-exports, grouped (a)–(d) plus
  `STDLIB_CONTRACT_VERSION` and the type surface.
- `test/assembly.test.ts` — assembly test: exact-surface,
  identity-with-producer, and live-call checks.
- `package.json`, `tsconfig.json` — manifest (emits `dist/`) and
  strict TS config.

## Ownership

Per `implementation/PLAN.md`: lane 03 owns this package (L3 thin
`@canlang/stdlib` export assembly, `src/index.ts` + `package.json`).
Each lane owns its package manifests. No dependency may import back
through the public façade.
