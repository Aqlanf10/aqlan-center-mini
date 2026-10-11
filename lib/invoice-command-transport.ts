export const INVOICE_COMMAND_RESPONSE_DEADLINE_MS = 20_000;
/** Bounds headers and body together. Late body/transport settlements never escape this result. */
export async function readInvoiceCommandResponse(run: (signal: AbortSignal) => Promise<Response>, onHeaders?: (response: Response) => void): Promise<{ response: Response; payload: unknown }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const response = Promise.resolve().then(() => run(controller.signal)).then(async response => {
    if (controller.signal.aborted) throw new Error("Invoice response owner retired");
    onHeaders?.(response);
    return { response, payload: await response.json() as unknown };
  });
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error("Invoice response remains unconfirmed")); }, INVOICE_COMMAND_RESPONSE_DEADLINE_MS);
  });
  try { return await Promise.race([response, deadline]); }
  finally { clearTimeout(timer); }
}
