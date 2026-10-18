# @canlang/services

Provider-owned capability adapters with verified ingress and completion
envelopes: mail, models (Ollama chat), judgments (SystemOne), and media
(ComfyUI native). Internal package; the public surface assembles in
`@canlang/stdlib`. The root entry and explicit package subpaths load emitted
modules; consumers do not import package source paths.

Install (workspace, from the repo root):

```sh
bun install --frozen-lockfile
```

Usage:

```ts
import { EmailV1Adapter } from '@canlang/services/mail/adapter';
import { fixedClock } from '@canlang/services/ports';

const mail = new EmailV1Adapter({
  baseUrl: 'https://mail.example.test',
  timeoutMs: 10_000,
  maxBodyBytes: 1_048_576,
  maxTransportBytes: null,
  clock: fixedClock(Date.now()),
});
```

Key exports: `SERVICES_CATALOG` (`src/catalog.ts`); `EmailV1Adapter`,
`OllamaChatAdapter`, `SystemOneAdapter`, `ComfyUINativeAdapter`;
frozen-request builders `buildFrozenMailRequest`,
`buildFrozenChatRequest`, `buildFrozenJudgmentRequest`; completion
helpers `succeededCompletion`, `failedCompletion`, `unknownCompletion`,
`skippedCompletion`, `assertValidCompletion`; HTTP primitives
`httpRequest`, `httpRequestBinary`, `httpStreamText`, `fetchPage`;
scenario tables `SCENARIO_TABLES`, `parseScenarioTable`,
`findScenarioTable`; controlled harnesses
`startControlledMailServer`, `startControlledOllamaServer`,
`startControlledSystemOneServer`, `startControlledComfyServer`.

HTTP readers share one request deadline across redirect hops and body reads.
Buffered readers copy admitted chunk bytes before the next read so a producer
reusing its buffer cannot change already consumed text or binary content.
After detecting an oversized body, cancellation waits use that same deadline
and caller signal; the original body-limit refusal remains authoritative.
The reader lock is released on return even when physical provider cleanup is
still pending, and a refused redirect body cannot send the next hop.

Media workflow graphs admit own JSON data: plain or null-prototype records,
dense arrays, strings, booleans, null and finite numbers. Graph capture refuses
accessors, executable `toJSON`, undefined, nonfinite numbers, cycles and other
host objects before provider transport. The reviewed artifact digest retains
its sorted-key JSON format. One detached snapshot supplies that digest and the
submitted graph after the declared scalar substitutions; installation captures
its original graph before any JSON conversion. Caller job/delivery retry
identities remain unchanged. This boundary does not sandbox Proxy traps or
modified host intrinsics, and does not change File byte-upload semantics.

## Scripts

From the repository root, after `bun install --frozen-lockfile`:

```sh
bun run build --filter=@canlang/services
bun run --filter @canlang/services typecheck
bun run --filter @canlang/services test
```

The filtered root build schedules this package and its declared producer
dependencies. It emits only each owner’s outputs, cleaning them before execution
or cache restoration. Package `typecheck` and `test` use the same graph, then
run the owning TypeScript check or compiled `node:test` suite uncached.
Internal `build:emit`, `typecheck:check`, and `test:unit` tasks are execution
steps; use the public commands above to prepare dependencies.

Source layout:

- `src/catalog.ts` — `SERVICES_CATALOG` manifest.
- `src/ports.ts` — capability ports (`MailSender`, `ModelChatPort`,
  `JudgmentPort`, `MediaPort`) plus `Clock`, `DeliveryIds`,
  `AttachmentSizes` fakes.
- `src/scenarios.ts` — scenario tables and script checkers.
- `src/http/` — `client.ts`, `errors.ts`, `pagination.ts`.
- `src/mail/` — `adapter.ts` (`EmailV1Adapter`), `redact.ts`.
- `src/models/` — `ollama.ts` (`OllamaChatAdapter`), `harness.ts`.
- `src/judgments/` — `systemone.ts` (`SystemOneAdapter`), `harness.ts`.
- `src/media/` — `comfyui.ts` (`ComfyUINativeAdapter`), `harness.ts`,
  `mapping.ts`.
- `test/` — `node:test` suites, one per adapter area.

Provider behavior and its fixtures live in this private package.
