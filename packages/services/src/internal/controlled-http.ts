import type http from 'node:http';

const MAX_HARNESS_BODY = 4_000_000;

export function readTextBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_HARNESS_BODY) {
        reject(new Error('harness body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

export function sendBody(
  res: http.ServerResponse,
  status: number,
  value: unknown,
): void {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const contentType =
    typeof value === 'string'
      ? 'text/plain; charset=utf-8'
      : 'application/json';
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}
