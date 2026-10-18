# Work kernel

The explicit recovery facade implements only the original synchronous
`planRecoveryScan` whole call. The other registered decision candidates retain
their separate consumer and adoption gates.

```ts
import { createRecoveryPlanner } from '@canlang/work-kernel';
import { distribution } from '@canlang/work-kernel/distribution';

// At startup, compile the producer-owned asset using the host's asset loader.
const module = new WebAssembly.Module(await loadBytes(distribution.recoveryWasm));
const planner = createRecoveryPlanner({ backend: 'wasm', module });
// The existing recovery owner can inject planner into runRecoverySweep.
const plan = planner(originalInput);
```

`createRecoveryPlanner({ backend: 'ts' })` selects the retained TypeScript
implementation. Both choices are explicit; there is no default, load-failure
fallback, native host service import or TypeScript retirement. The supplied
module must have the recovery ABI1 exports and no imports. The ABI uses the
standard wasm32 memory and per-call handles; it does not qualify a native
64-bit pointer host.

Run `build:wasm` explicitly to compile the locked Rust producer and stage
`dist/native/recovery.wasm` after the TypeScript build. Ordinary `build:emit` and `build:prepare` do not
compile or activate a native backend. The package's existing `dist` inventory
includes the staged asset when packing. `distribution.recoveryWasm` names that
exact asset; a caller must refuse missing or invalid assets without substituting
a backend. This manual build does not release the native preparation hold.

The facade retains original row/item/claim/policy references and reads only the
facts demanded by native. Duplicate claim IDs remain last-wins. Native requests
uncertain evidence in original row order; the host executes the existing
synchronous callback with the original input receiver. The ID is read again
after that callback, and callback/property exceptions surface unchanged. Each
call releases its native storage on return or throw; nested calls use separate
handles. The planner returns seven UTF16-sorted action lists and stages no
effects or authority. The recovery owner retains its existing single fenced
action pass and retry evidence reattestation.

The native scalar profile transports string IDs as UTF16, including lone
surrogates, and numeric facts as f64 without integer narrowing or stamp
validation. Absent arithmetic facts become NaN; null numeric reads become zero.
Original null-anchor short circuits and repeat reads are preserved. String,
object, boolean and bigint arithmetic coercions and nonstring IDs are outside
this profile and refuse explicitly. Opaque provider payloads are never cloned,
enumerated or sent to native. Initial numeric validation preserves the original
RangeErrors and demand order.

Native whole-call checks use the actual staged module and retained original
recovery expectations through explicit `test:recovery-wasm`; a missing asset
fails. The existing ordinary `test:unit` inventory remains unchanged. Genuine installed/durable sweep
adoption and its owner effects are checked by Dev. Kernel execution alone
does not authorize serving, publication or activation.
