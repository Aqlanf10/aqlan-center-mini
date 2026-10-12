import { afterEach, describe, expect, it, vi } from "vitest";
import { INVOICE_COMMAND_RESPONSE_DEADLINE_MS, readInvoiceCommandResponse } from "../lib/invoice-command-transport";
afterEach(() => vi.useRealTimers());
describe("bounded invoice acknowledgement", () => {
  it("returns the response and complete body together", async () => {
    const response = new Response(JSON.stringify({ id: 1 }), { status: 201 });
    expect(await readInvoiceCommandResponse(async () => response)).toEqual({ response, payload: { id: 1 } });
  });
  it.each(["headers", "body"] as const)("retires a held %s result and consumes a later settlement", async phase => {
    vi.useFakeTimers();
    let release!: (response: Response) => void, releaseBody!: (body: unknown) => void, signal!: AbortSignal;
    const response = { json: () => new Promise(resolve => { releaseBody = resolve; }) } as Response;
    const outcome = readInvoiceCommandResponse(async value => {
      signal = value;
      return phase === "headers" ? new Promise<Response>(resolve => { release = resolve; }) : response;
    }).then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
    await vi.advanceTimersByTimeAsync(INVOICE_COMMAND_RESPONSE_DEADLINE_MS);
    const failed = await outcome; expect(failed.ok).toBe(false); expect(signal.aborted).toBe(true);
    if (phase === "headers") { release(new Response(JSON.stringify({ id: 99 }))); }
    else releaseBody({ id: 99 });
    await Promise.resolve(); await Promise.resolve(); expect(await outcome).toBe(failed);
  });
  it("retires denied authority at headers before a held error body and fences late headers", async () => {
    vi.useFakeTimers();
    const headers = vi.fn();
    const pending = readInvoiceCommandResponse(async () => ({ status: 401, json: () => new Promise(() => {}) }) as Response, headers)
      .then(() => false, () => true);
    await vi.advanceTimersByTimeAsync(0); expect(headers).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 401 }));
    await vi.advanceTimersByTimeAsync(INVOICE_COMMAND_RESPONSE_DEADLINE_MS); expect(await pending).toBe(true);
    let release!: (response: Response) => void; headers.mockClear();
    const late = readInvoiceCommandResponse(() => new Promise(resolve => { release = resolve; }), headers).then(() => false, () => true);
    await vi.advanceTimersByTimeAsync(INVOICE_COMMAND_RESPONSE_DEADLINE_MS); expect(await late).toBe(true);
    release(new Response("{}", { status: 401 })); await Promise.resolve(); await Promise.resolve();
    expect(headers).not.toHaveBeenCalled();
  });
  it("malformed successful JSON remains an unknown acknowledgement", async () => {
    await expect(readInvoiceCommandResponse(async () => new Response("invalid", { status: 201 }))).rejects.toThrow();
  });
});
