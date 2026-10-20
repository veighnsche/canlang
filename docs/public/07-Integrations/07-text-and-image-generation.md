# Text and image generation

Runtime AI capabilities accept bounded typed requests and return durable progress; they are separate from build-time saved-code generation.

## Runtime requests

A request carries a stable source/revision identity, selected deployment profile, policy revision, explicit input and finite token/job/time bounds. Image workflows are inspected and validated before publication; a run uses the frozen definition and validation digest. Generated image bytes are finalized into application-owned file references before they are attached or displayed.

Progress is a typed sequence and may end in succeeded, failed, unknown or cancelled. Partial outputs remain explicit data. Unknown requires reconciliation; cancellation is a request. Validate generated content and apply it only through canonical operations, with human review when the application’s policy requires it. Never put credentials in prompts or trust generated text as instructions.

This is runtime AI. Saved implementation generation occurs before build and is covered by [generation lifecycle](../08-Code-generation/01-generation-lifecycle.md).
