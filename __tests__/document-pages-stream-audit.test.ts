import { Writable, type WritableOptions } from 'node:stream';
import { expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/lib/staff-session-admission', () => ({ selectStaffEnvelope: () => ({ kind: 'legacy' }) }));
vi.mock('@/lib/session', () => ({ requireSessionFromTransport: vi.fn() }));
vi.mock('@/lib/document-route-core', () => ({ documentGet: mocks.get, documentDelete: vi.fn() }));
import handler from '../pages/api/documents/[id]';

class GatedResponse extends Writable {
  statusCode = 0; headers = new Map<string,string>(); firstWrite!: () => void; written = new Promise<void>(resolve => { this.firstWrite = resolve; });
  release?: () => void; bytes = 0; writes = 0;
  constructor(options: WritableOptions = {}) { super({ highWaterMark: 16, ...options }); }
  setHeader(key: string, value: string) { this.headers.set(key.toLowerCase(), value); return this; }
  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.bytes += chunk.length; this.writes++;
    if (this.writes === 1) { this.release = () => callback(); this.firstWrite(); } else callback();
  }
}
function syntheticBody() {
  let produced = 0, cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { if (produced === 32) controller.close(); else { produced++; controller.enqueue(new Uint8Array(65536).fill(produced)); } },
    cancel() { cancelled = true; },
  });
  return { stream, produced: () => produced, cancelled: () => cancelled };
}
const request = { method: 'GET', headers: {}, url: '/api/documents/1', query: { id: '1' } };

it('holds the producer while a slow writable is backpressured, then sends all bytes', async () => {
  const body = syntheticBody();
  mocks.get.mockResolvedValue(new Response(body.stream, { headers: { 'Content-Length': String(32 * 65536), 'Cache-Control':'private, no-store' } }));
  const response = new GatedResponse();
  const completed = handler(request as never, response as never);
  await response.written;
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(response.writes).toBe(1);
  expect(body.produced()).toBeLessThan(32);
  expect(response.headers.get('content-length')).toBe(String(32 * 65536));
  expect(response.headers.get('cache-control')).toBe('private, no-store, no-transform');
  response.release!(); await completed;
  expect(response.bytes).toBe(32 * 65536);
  expect(body.produced()).toBe(32);
});

it('cancels its source and rejects promptly when the destination disconnects', async () => {
  const body = syntheticBody();
  mocks.get.mockResolvedValue(new Response(body.stream, { headers: { 'Content-Length': String(32 * 65536) } }));
  const response = new GatedResponse();
  const completed = handler(request as never, response as never);
  const outcome = completed.then(() => 'resolved', () => 'rejected');
  await response.written; response.destroy();
  expect(await outcome).toBe('rejected');
  expect(body.cancelled()).toBe(true);
  expect(body.produced()).toBeLessThan(32);
});
