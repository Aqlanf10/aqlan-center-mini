import type { Page, Request, Response } from "playwright";
import { hasWalkoutFinancials } from "../../lib/walkout-financial-read";

type Owner = { kind: "workflow" | "walkout" | "payment"; patientId: number; visitId?: number };
type Entry = { epoch: number; navigation: number; kind: Owner["kind"] | "diagnostic"; visitId?: number;
  status?: number; finished?: boolean; failed?: string; json?: "pending" | "parsed" | "invalid";
  details?: ReturnType<typeof financialReadDetails> };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const integer = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);
const codes = new Set(["forbidden", "invalid", "not_found", "patient_mismatch", "financial_review_required", "unavailable", "conflict", "invalid_amount"]);
const failureCodes = new Set(["net::ERR_ABORTED", "net::ERR_FAILED", "net::ERR_CONNECTION_RESET",
  "net::ERR_CONNECTION_REFUSED", "net::ERR_TIMED_OUT", "net::ERR_EMPTY_RESPONSE"]);
const numericMap = (v: unknown) => record(v)
  ? Object.fromEntries(["YER", "SAR", "USD"].map(c => [c, integer(v[c]) ? v[c] : null])) : null;

/** Synthetic fixture facts only. Never retains body text, names, headers, cookies, URLs or messages. */
export function financialReadDetails(body: unknown, owner: Owner) {
  if (!record(body)) return { object: false };
  const code = typeof body.code === "string" ? body.code : typeof body.reason === "string" ? body.reason : null;
  const safeCode = code === null ? null : codes.has(code) ? code : "unclassified";
  // A payment request has a known fixture owner, but its response has no owner proof.
  if (owner.kind === "payment") return { object: true, code: safeCode,
    receiptId: integer(body.id) && body.id > 0 ? body.id : null };
  const invoice = record(body.invoice) ? body.invoice : null;
  const checkout = record(body.checkout) ? body.checkout : null;
  const ownerMatches = owner.kind === "workflow" ? record(body.patient) && body.patient.id === owner.patientId
    : owner.kind === "walkout" ? body.patientId === owner.patientId && body.visitId === owner.visitId : undefined;
  if (ownerMatches === false) return { object: true, ownerMatches: false };
  return {
    object: true,
    code: safeCode,
    ownerMatches,
    financialsAccepted: owner.kind === "walkout" && owner.visitId !== undefined
      ? hasWalkoutFinancials(body, owner.patientId, owner.visitId) : undefined,
    invoiceId: invoice && integer(invoice.id) ? invoice.id : null,
    invoiceCurrency: invoice && typeof invoice.currency === "string" && ["YER", "SAR", "USD"].includes(invoice.currency) ? invoice.currency : null,
    invoiceNetMinor: invoice && integer(invoice.netMinor) ? invoice.netMinor : null,
    invoicePaidMinor: checkout && integer(checkout.invoicePaidMinor) ? checkout.invoicePaidMinor : null,
    previous: checkout ? numericMap(checkout.previous) : null,
    current: checkout ? numericMap(checkout.current) : null,
    signed: typeof body.signedAt === "string" && Number.isFinite(Date.parse(body.signedAt)),
    signedToday: typeof body.signedToday === "boolean" ? body.signedToday : undefined,
  };
}

/** Observes only caller-owned synthetic endpoints. Sequence IDs expose superseded/failed reads.
 * Bounded to 20 requests; parsing failures are recorded, never allowed to reject an event handler.
 * This witness never retries requests or changes an assertion's outcome.
 */
export function observeOwnedFinancialReads(page: Page, classify: (request: Request) => Owner | null) {
  let epoch = 0, navigation = 0;
  const entries: Entry[] = [];
  const owners = new WeakMap<Request, { entry: Entry; owner: Owner }>();
  const navigated = () => { navigation++; };
  const append = (entry: Entry) => { entries.push(entry); if (entries.length > 20) entries.shift(); };
  const requested = (request: Request) => {
    let owner: Owner | null;
    try { owner = classify(request); }
    catch {
      append({ epoch: ++epoch, navigation, kind: "diagnostic", failed: "classification_failed" });
      return;
    }
    if (!owner) return;
    const entry: Entry = { epoch: ++epoch, navigation, kind: owner.kind, visitId: owner.visitId };
    owners.set(request, { entry, owner }); append(entry);
  };
  const responded = (response: Response) => {
    const tracked = owners.get(response.request());
    if (!tracked) return;
    tracked.entry.status = response.status(); tracked.entry.json = "pending";
    void response.json().then((body: unknown) => {
      tracked.entry.details = financialReadDetails(body, tracked.owner); tracked.entry.json = "parsed";
    }).catch(() => { tracked.entry.json = "invalid"; });
  };
  const finished = (request: Request) => {
    const tracked = owners.get(request); if (tracked) tracked.entry.finished = true;
  };
  const failed = (request: Request) => {
    const tracked = owners.get(request);
    if (tracked) {
      const reason = request.failure()?.errorText ?? "";
      tracked.entry.failed = failureCodes.has(reason) ? reason : "request_failed";
    }
  };
  page.on("framenavigated", navigated); page.on("request", requested); page.on("response", responded);
  page.on("requestfinished", finished); page.on("requestfailed", failed);
  return {
    snapshot: () => entries.map(entry => ({ ...entry })),
    stop: () => {
      page.off("framenavigated", navigated); page.off("request", requested); page.off("response", responded);
      page.off("requestfinished", finished); page.off("requestfailed", failed);
    },
  };
}
