# @canlang/services

Provider-owned capability adapters with verified ingress and completion
envelopes: mail, models (Ollama chat), judgments (SystemOne), and media
(ComfyUI native). Internal package; the public surface assembles in
`@canlang/stdlib`. The root entry and explicit package subpaths load emitted
modules; consumers do not import package source paths.

Ownership per `implementation/PLAN.md`: lane 4 (provider adapters,
durable events/schedules/deliveries, file lifecycle, observable runs).

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

Lane note: provider behavior and its fixtures stay in lane 4; do not
reimplement adapters or harnesses elsewhere. The package is private
(`"private": true`); the repo has no top-level license file.
