/**
 * Source contract gates for the proposed appointment-purpose tranche.
 * These are mocked route tests, not PostgreSQL lock or restore proof.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../lib/db", () => ({
  CLINIC_TIME_ZONE: "Asia/Aden", findUserByUsername: vi.fn(), doctorOwnedPatientIds: vi.fn(),
  labWorkForPatients: vi.fn(), listAppointmentsByDate: vi.fn(), lockAppointmentServiceForBooking: vi.fn(),
  getAppointment: vi.fn(), getAppointmentOnClient: vi.fn(), insertAppointmentOnClient: vi.fn(), insertAuditRow: vi.fn(), moveAppointmentOnClient: vi.fn(),
  recordAudit: vi.fn(), writeAppointmentAcrossDays: vi.fn(), writeAppointmentInDay: vi.fn(),
  getPool: vi.fn(), ensureSchema: vi.fn(), schedulePlannedVisit: vi.fn(),
}));
vi.mock("../lib/capacity-context", () => ({ prepareCapacityEvaluator: vi.fn(), loadCapacityContext: vi.fn(), resolveService: vi.fn() }));
vi.mock("../lib/appointment-doctor", () => ({ lockBookableAppointmentDoctor: vi.fn(), APPOINTMENT_DOCTOR_UNAVAILABLE_MESSAGE: "الطبيب غير متاح للحجز." }));
vi.mock("../lib/session", () => ({ requireSession: vi.fn(), readSessionPayload:vi.fn(), revalidateSessionInTransaction: vi.fn() }));
vi.mock("../lib/patient-access", () => ({ canAccessPatient: vi.fn() }));
vi.mock("../lib/appointment-purpose", async importOriginal => ({...await importOriginal<typeof import('../lib/appointment-purpose')>(),
  insertAppointmentPurposeProvenance:vi.fn(),findDirectAppointmentCommandReceipt:vi.fn()}));
import { POST } from "../app/api/appointments/route";
import { GET as commandGET } from '../app/api/appointments/commands/[id]/route';
import { POST as schedulePOST } from "../app/api/planned-visits/[id]/schedule/route";
import { bookAppointment, type BookAppointmentInput } from "../lib/book-appointment";
import { ensureSchema, findUserByUsername, getAppointmentOnClient, getPool, insertAppointmentOnClient, insertAuditRow,
  schedulePlannedVisit, writeAppointmentInDay } from "../lib/db";
import { prepareCapacityEvaluator, loadCapacityContext, resolveService } from "../lib/capacity-context";
import { lockBookableAppointmentDoctor } from "../lib/appointment-doctor";
import { readSessionPayload, requireSession, revalidateSessionInTransaction } from "../lib/session";
import { canAccessPatient } from "../lib/patient-access";
import { findDirectAppointmentCommandReceipt, insertAppointmentPurposeProvenance } from "../lib/appointment-purpose";

const actor = { username: "synthetic", role: "reception", channel: "ui" as const };
const directCommandId = "312dd164-3a68-4b13-98b2-92c41bd7d469";
const request = (purpose?: unknown): BookAppointmentInput => ({ patientId: 19, date: "2030-01-15", time: "16:00",
  durationMinutes: 30, serviceId: null, appointmentType: null,
  ...(purpose === undefined ? {} : { appointmentPurpose: purpose }),
}) as BookAppointmentInput;
const http = (purpose: unknown, commandId: unknown = directCommandId) => new Request("http://example.test/api/appointments", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ ...request(), appointmentPurpose: purpose,
    ...(commandId === undefined ? {} : { commandId }) }),
});
const scheduleHttp = (purpose: unknown) => new Request("http://example.test/api/planned-visits/51/schedule", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ date: "2030-01-15", time: "16:00", appointmentPurpose: purpose }),
});
const scheduleContext = { params: Promise.resolve({ id: "51" }) };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireSession).mockResolvedValue({ username: "synthetic", role: "reception", userId: 1, expiresAt: Date.now() + 60_000 });
  vi.mocked(readSessionPayload).mockResolvedValue({ username: "synthetic", role: "reception", userId: 1, expiresAt: Date.now() + 60_000 });
  vi.mocked(revalidateSessionInTransaction).mockImplementation(async session=>session);
  vi.mocked(findUserByUsername).mockResolvedValue({id:1,partyId:null,permissions:{canOverrideCapacity:false}} as never);
  vi.mocked(loadCapacityContext).mockResolvedValue({ chairs: 3, shifts: [{ start: "09:00", end: "20:00" }],
    nearCapacityPercent: 80, emergencyReserveMinutes: 0, newPatientDailyLimit: 0 });
  vi.mocked(resolveService).mockResolvedValue(null);
  vi.mocked(lockBookableAppointmentDoctor).mockResolvedValue(true);
  vi.mocked(prepareCapacityEvaluator).mockResolvedValue(() => ({ state: "AVAILABLE", occupiedChairs: 0,
    chairs: 3, dayPercent: 0, outsideHours: false, message: "Synthetic capacity available", reasons: [] }));
  vi.mocked(writeAppointmentInDay).mockImplementation(async ({ prelude, beforeLocks, judge, commit }) => {
    const client = {query:vi.fn().mockResolvedValue({rows:[]})} as never;
    const first=await prelude?.(client);
    if (first?.kind==='replayed') return {ok:true,value:first.value,replayed:true};
    if (first?.kind==='rejected') return {ok:false,conflict:first.conflict};
    await beforeLocks?.(client);
    const verdict = await judge([], client);
    return verdict.ok ? { ok: true, value: await commit(client) } : verdict;
  });
  vi.mocked(insertAppointmentOnClient).mockResolvedValue({ id: 101 } as never);
  vi.mocked(findDirectAppointmentCommandReceipt).mockResolvedValue(null);
  vi.mocked(getAppointmentOnClient).mockResolvedValue({id:101,patientId:19,status:'booked'} as never);
  vi.mocked(getPool).mockReturnValue({ query: vi.fn().mockResolvedValue({ rows: [{ patient_id: 19 }] }) } as never);
  vi.mocked(canAccessPatient).mockResolvedValue(true);
  vi.mocked(schedulePlannedVisit).mockResolvedValue({ ok: true, appointmentId: 101, title: "Synthetic planned visit" });
});

describe("explicit appointment purpose persistence — source contract", () => {
  it("rejects direct explicit purpose without a durable command UUID before booking", async () => {
    const response = await POST(new Request("http://example.test/api/appointments", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...request(), appointmentPurpose: "consultation" }),
    }));
    expect(response.status).toBe(400);
    expect(insertAppointmentOnClient).not.toHaveBeenCalled();
  });

  it.each(["1e2", "not-a-uuid", 7, null])("rejects malformed direct command ID %s", async commandId => {
    const response = await POST(http("consultation", commandId));
    expect(response.status).toBe(400);
    expect(insertAppointmentOnClient).not.toHaveBeenCalled();
  });

  it("rejects an unknown purpose at the actual POST boundary instead of silently booking legacy", async () => {
    const response = await POST(http("made_up_treatment"));
    expect(response.status).toBe(400);
    expect(insertAppointmentOnClient).not.toHaveBeenCalled();
  });

  it("persists a direct consultation purpose on the same insert as the appointment", async () => {
    const response = await POST(http("consultation"));
    expect(response.status).toBe(201);
    expect(insertAppointmentOnClient).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({patientId:19}));
    expect(insertAppointmentPurposeProvenance).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({appointmentId:101,purpose:"consultation",sourcePlanId:null,sourcePlannedVisitId:null,
      commandId:directCommandId,actorUserId:1,commandHash:expect.stringMatching(/^[0-9a-f]{64}$/)}));
  });

  it('replays the completed same-actor command without mutable reads, another insert or audit', async()=>{
    const first=await POST(http('consultation'));
    expect(first.status).toBe(201);
    const recorded=vi.mocked(insertAppointmentPurposeProvenance).mock.calls[0][1];
    vi.mocked(findDirectAppointmentCommandReceipt).mockResolvedValue({appointmentId:101,patientId:19,
      actorUserId:1,recordedBy:'synthetic',commandHash:recorded.commandHash!});
    vi.mocked(getAppointmentOnClient).mockResolvedValue({id:101,patientId:19,status:'cancelled'} as never);
    vi.mocked(insertAppointmentOnClient).mockClear();
    vi.mocked(insertAppointmentPurposeProvenance).mockClear();
    vi.mocked(insertAuditRow).mockClear();
    vi.mocked(loadCapacityContext).mockClear();
    vi.mocked(resolveService).mockClear();
    const replay=await POST(http('consultation'));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({id:101,status:'cancelled',replayed:true});
    expect(insertAppointmentOnClient).not.toHaveBeenCalled();
    expect(insertAppointmentPurposeProvenance).not.toHaveBeenCalled();
    expect(insertAuditRow).not.toHaveBeenCalled();
    expect(loadCapacityContext).not.toHaveBeenCalled();
    expect(resolveService).not.toHaveBeenCalled();
  });

  it('rejects a reused key with a different actor without revealing the old appointment',async()=>{
    vi.mocked(findDirectAppointmentCommandReceipt).mockResolvedValue({appointmentId:101,patientId:19,
      actorUserId:2,recordedBy:'another',commandHash:'a'.repeat(64)});
    const response=await POST(http('consultation'));
    expect(response.status).toBe(409);
    expect(JSON.stringify(await response.json())).not.toContain('101');
    expect(insertAppointmentOnClient).not.toHaveBeenCalled();
  });

  it('recovers only the original actor current status and marks response uncacheable',async()=>{
    vi.mocked(getPool).mockReturnValue({connect:vi.fn().mockResolvedValue({
      query:vi.fn().mockResolvedValue({rows:[]}),release:vi.fn()}),query:vi.fn()} as never);
    vi.mocked(findDirectAppointmentCommandReceipt).mockResolvedValue({appointmentId:101,patientId:19,
      actorUserId:1,recordedBy:'synthetic',commandHash:'a'.repeat(64)});
    const response=await commandGET(new Request(`http://example.test/api/appointments/commands/${directCommandId}`),
      {params:Promise.resolve({id:directCommandId})});
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toMatchObject({id:101,status:'booked',replayed:true});
    expect(insertAppointmentOnClient).not.toHaveBeenCalled();
    expect(ensureSchema).not.toHaveBeenCalled();
    expect(requireSession).not.toHaveBeenCalled();
  });

  it('fails closed with 503 if registered 0095 is unavailable instead of initializing it',async()=>{
    const missing=Object.assign(new Error('undefined_table'),{code:'42P01'});
    vi.mocked(getPool).mockReturnValue({connect:vi.fn().mockResolvedValue({
      query:vi.fn().mockResolvedValue({rows:[]}),release:vi.fn()})} as never);
    vi.mocked(findDirectAppointmentCommandReceipt).mockRejectedValue(missing);
    const response=await commandGET(new Request(`http://example.test/api/appointments/commands/${directCommandId}`),
      {params:Promise.resolve({id:directCommandId})});
    expect(response.status).toBe(503);
    expect(ensureSchema).not.toHaveBeenCalled();
  });

  it('denies assistant recovery before UUID parsing or DB access',async()=>{
    vi.mocked(readSessionPayload).mockResolvedValue({username:'assistant',role:'assistant',userId:9,
      expiresAt:Date.now()+60_000});
    const response=await commandGET(new Request('http://example.test/api/appointments/commands/garbage'),
      {params:Promise.resolve({id:'garbage'})});
    expect(response.status).toBe(403);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(getPool).not.toHaveBeenCalled();
  });

  it('rejects the ortho follow-up shortcut on direct classified booking',async()=>{
    const response=await POST(new Request('http://example.test/api/appointments',{method:'POST',
      headers:{'Content-Type':'application/json'},body:JSON.stringify({...request(),
        appointmentPurpose:'consultation',bookingIntent:'ortho_follow_up',commandId:directCommandId})}));
    expect(response.status).toBe(400);
    expect(insertAppointmentOnClient).not.toHaveBeenCalled();
  });

  it('does not silently use a receipt key on the legacy booking path',async()=>{
    const response=await POST(new Request('http://example.test/api/appointments',{method:'POST',
      headers:{'Content-Type':'application/json'},body:JSON.stringify({...request(),commandId:directCommandId})}));
    expect(response.status).toBe(400);
    expect(insertAppointmentOnClient).not.toHaveBeenCalled();
  });

  it("rejects a plan-required purpose from direct booking without a canonical planned visit", async () => {
    const result = await bookAppointment(request("follow_up"), actor);
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(insertAppointmentOnClient).not.toHaveBeenCalled();
  });

  it("keeps legacy purpose absent rather than inferring from appointmentType", async () => {
    const result = await bookAppointment({ ...request(), appointmentType: "follow_up" }, actor);
    expect(result.ok).toBe(true);
    expect(insertAppointmentOnClient).toHaveBeenCalledWith(expect.anything(), expect.not.objectContaining({ appointmentPurpose: "follow_up" }));
  });

  it("rejects an unknown purpose from the existing planned-visit schedule route", async () => {
    const response = await schedulePOST(scheduleHttp("made_up_treatment"), scheduleContext);
    expect(response.status).toBe(400);
    expect(schedulePlannedVisit).not.toHaveBeenCalled();
  });

  it("forwards the explicit purpose and scoped actor into the planned-visit writer", async () => {
    const response = await schedulePOST(scheduleHttp("follow_up"), scheduleContext);
    expect(response.status).toBe(201);
    expect(schedulePlannedVisit).toHaveBeenCalledWith(expect.objectContaining({
      plannedVisitId: 51, appointmentPurpose: "follow_up",
      session: expect.objectContaining({ username: "synthetic", role: "reception" }),
    }));
  });

  it("does not use generic patient access as a canViewPlans grant for a new plan-purpose booking", async () => {
    vi.mocked(requireSession).mockResolvedValue({ username: "synthetic doctor", role: "doctor", userId: 2,
      expiresAt: Date.now() + 60_000 });
    vi.mocked(findUserByUsername).mockResolvedValue({id:2,partyId:10,permissions:{canViewPlans:true}} as never);
    vi.mocked(canAccessPatient).mockImplementation(async (_session, _patientId, permission) => permission !== "canViewPlans");
    const response = await schedulePOST(scheduleHttp("follow_up"), scheduleContext);
    expect(response.status).toBe(403);
    expect(schedulePlannedVisit).not.toHaveBeenCalled();
  });

  it("requires plan-view authority for an explicit direct consultation without changing legacy doctor booking", async () => {
    vi.mocked(requireSession).mockResolvedValue({ username: "synthetic doctor", role: "doctor", userId: 2,
      expiresAt: Date.now() + 60_000 });
    vi.mocked(findUserByUsername).mockResolvedValue({id:2,partyId:10,permissions:{canViewPlans:true}} as never);
    vi.mocked(canAccessPatient).mockImplementation(async (_session, _patientId, permission) => permission !== "canViewPlans");
    const explicit = await POST(http("consultation"));
    expect(explicit.status).toBe(403);
    expect(insertAppointmentOnClient).not.toHaveBeenCalled();
  });

  it("keeps existing planned-visit scheduling without an explicit purpose on its legacy path", async () => {
    const response = await schedulePOST(new Request("http://example.test/api/planned-visits/51/schedule", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: "2030-01-15", time: "16:00" }),
    }), scheduleContext);
    expect(response.status).toBe(201);
    expect(schedulePlannedVisit).toHaveBeenCalledTimes(1);
  });

  it.each(["1e2", "51.0", "__proto__"])("rejects a non-canonical planned visit path ID %s", async (id) => {
    const response = await schedulePOST(scheduleHttp("follow_up"), { params: Promise.resolve({ id }) });
    expect(response.status).toBe(400);
    expect(schedulePlannedVisit).not.toHaveBeenCalled();
  });
});
