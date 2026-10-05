# @canlang/services

Provider-owned capability adapters with verified ingress and completion
envelopes: mail, models (Ollama chat), judgments (SystemOne), and media
(ComfyUI native). Internal package; the public surface assembles in
`@canlang/stdlib`. There is no barrel `index.ts`: import from the module
paths under `src/` (as `test/*.test.ts` does).

Ownership per `implementation/PLAN.md`: lane 4 (provider adapters,
durable events/schedules/deliveries, file lifecycle, observable runs).

Install (workspace, from the repo root):

```sh
bun install
```

Usage:

```ts
import { EmailV1Adapter } from '@canlang/services/src/mail/adapter.ts';
import { fixedClock } from '@canlang/services/src/ports.ts';

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

Scripts (the only scripts in `package.json`; no `build` script):

| Script | Command | Purpose |
| --- | --- | --- |
| `typecheck` | `tsc --noEmit` | Typecheck the package |
| `test` | `node --test 'test/**/*.test.ts'` | Run the `node:test` suite |

Run from the repo root, e.g.
`bun run --filter @canlang/services test`.

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
