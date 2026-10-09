/** One bounded TypeSafe System One call; packet construction stays in jev-ranker. */
import type { JevChoiceRequest, JevChoiceTransport } from "./jev-ranker.js";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MAX_RESPONSE_BYTES = 64 * 1024;

export class JevProviderRejected extends Error {
  readonly code = "PROVIDER_REJECTED";
  constructor(readonly status: number) {
    super(`Jev rejected the request with HTTP ${status}`);
  }
}

async function readBounded(response: Response): Promise<unknown> {
  if (response.body === null) throw new Error("Jev response body is missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error("Jev response exceeds byte limit");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}

export class JevHttpTransport implements JevChoiceTransport {
  constructor(
    private readonly apiKey: () => string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async choose(request: JevChoiceRequest, signal: AbortSignal): Promise<unknown> {
    const key = this.apiKey()?.trim();
    if (!key) throw new Error("Jev API key is unavailable");
    const response = await this.fetchImpl(ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(request),
      signal,
    });
    if (!response.ok) {
      if (response.status >= 400 && response.status < 500) throw new JevProviderRejected(response.status);
      throw new Error(`Jev HTTP ${response.status}`);
    }
    return readBounded(response);
  }
}
