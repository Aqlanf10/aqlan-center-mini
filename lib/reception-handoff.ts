/** Reception work status is separate from patient debt and financial clearance. */
export type ReceptionHandoffStatus = "pending" | "collected" | "deferred" | "handled";
export interface ReceptionHandoff {
  visitId: number;
  patientId: number;
  patientName: string;
  patientNumber: string;
  signedAt: string;
  status: ReceptionHandoffStatus;
  handledReason: string | null;
}

export interface ReceptionHandoffSnapshot {
  owner: { username: string; role: string };
  fromDate: string;
  toDate: string;
  clinicTimeZone: string;
  items: ReceptionHandoff[];
}

/** Same front-desk roles accepted by canSeeWalkout; cashier cannot open clinical checkout. */
export function canReadReceptionHandoff(role: string | null | undefined): boolean {
  return role === "admin" || role === "reception";
}

export function isHandoffDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < "0001-01-02") return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const positiveId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** Reject incomplete/wrong-owner transport instead of announcing a false empty register. */
export function readReceptionHandoffs(value: unknown, owner: { username: string; role: string }, requestedDate: string | null): ReceptionHandoffSnapshot | null {
  if (!record(value) || !record(value.owner) || value.owner.username !== owner.username
    || value.owner.role !== owner.role || !canReadReceptionHandoff(owner.role)
    || !isHandoffDate(value.fromDate) || !isHandoffDate(value.toDate)
    || (requestedDate !== null && value.toDate !== requestedDate)
    || new Date(`${value.toDate}T00:00:00Z`).getTime() - new Date(`${value.fromDate}T00:00:00Z`).getTime() !== 86_400_000
    || typeof value.clinicTimeZone !== "string" || !Array.isArray(value.items)) return null;
  let day: Intl.DateTimeFormat;
  try { day = new Intl.DateTimeFormat("en-CA", { timeZone: value.clinicTimeZone, year: "numeric", month: "2-digit", day: "2-digit" }); }
  catch { return null; }
  const ids = new Set<number>();
  const items: ReceptionHandoff[] = [];
  for (const row of value.items) {
    if (!record(row) || !positiveId(row.visitId) || !positiveId(row.patientId) || ids.has(row.visitId)
      || typeof row.patientName !== "string" || !row.patientName.trim()
      || typeof row.patientNumber !== "string" || !row.patientNumber.trim()
      || typeof row.signedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(row.signedAt)
      || !Number.isFinite(Date.parse(row.signedAt))
      || typeof row.status !== "string" || !["pending", "collected", "deferred", "handled"].includes(row.status)
      || !(row.handledReason === null || typeof row.handledReason === "string")) return null;
    const parts = day.formatToParts(new Date(row.signedAt));
    const date = ["year", "month", "day"].map(type => parts.find(part => part.type === type)?.value).join("-");
    if (date < value.fromDate || date > value.toDate) return null;
    ids.add(row.visitId);
    items.push({ visitId: row.visitId, patientId: row.patientId, patientName: row.patientName,
      patientNumber: row.patientNumber, signedAt: row.signedAt,
      status: row.status as ReceptionHandoffStatus, handledReason: row.handledReason as string | null });
  }
  return { owner, fromDate: value.fromDate, toDate: value.toDate, clinicTimeZone: value.clinicTimeZone, items };
}

export function receptionCheckoutHref(row: Pick<ReceptionHandoff, "patientId" | "visitId">): string {
  return `/patients/${row.patientId}?tab=today&checkoutVisit=${row.visitId}`;
}
