import { beforeEach, describe, expect, it, vi } from "vitest";
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/lib/db", () => ({
  ensureSchema: vi.fn(), getPool: () => ({ query }),
  getCephStudy: vi.fn(), getPatient: vi.fn(), getCephReferenceSet: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ requireSession: vi.fn() }));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: vi.fn() }));
vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NOT_FOUND"); },
  redirect: () => { throw new Error("LOGIN"); },
}));
vi.mock("@/components/CephTracer", () => ({ CephTracer: vi.fn() }));
vi.mock("@/components/CephCompareView", () => ({ CephCompareView: vi.fn() }));
import { getCephStudy, getPatient, getCephReferenceSet } from "@/lib/db";
import { canAccessPatient } from "@/lib/patient-access";
import { requireSession } from "@/lib/session";
import Workspace from "@/app/ceph/[id]/page";
import Compare from "@/app/ceph/compare/page";

const session = { userId: 1, username: "synthetic", role: "doctor" as const, expiresAt: Date.now() + 60_000 };
const workspace = () => Workspace({ params: Promise.resolve({ id: "1" }) });
const compare = (patient?: string) => Compare({ searchParams: Promise.resolve({ first: "1", second: "2", patient }) });
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireSession).mockResolvedValue(session);
  query.mockResolvedValue({ rows: [{ patient_id: 42 }] });
  vi.mocked(canAccessPatient).mockResolvedValue(false);
});
function noSensitiveReads() {
  expect(getCephStudy).not.toHaveBeenCalled();
  expect(getPatient).not.toHaveBeenCalled();
  expect(getCephReferenceSet).not.toHaveBeenCalled();
}

describe.each([["workspace", workspace], ["comparison", compare]] as const)("%s admission before clinical reads", (_name, page) => {
  it("checks the canonical X-ray permission using stored ownership", async () => {
    await expect(page()).rejects.toThrow("NOT_FOUND");
    expect(canAccessPatient).toHaveBeenCalledWith(session, 42, "canViewXrays");
    noSensitiveReads();
  });
  it("fails closed when the policy check throws", async () => {
    vi.mocked(canAccessPatient).mockRejectedValue(new Error("policy unavailable"));
    await expect(page()).rejects.toThrow("NOT_FOUND");
    noSensitiveReads();
  });
  it("does not read clinical data when ownership lookup fails", async () => {
    query.mockRejectedValue(new Error("database unavailable"));
    await expect(page()).rejects.toThrow("database unavailable");
    noSensitiveReads();
  });
  it("stops when no active study exists", async () => {
    query.mockResolvedValue({ rows: [] });
    await expect(page()).rejects.toThrow("NOT_FOUND");
    expect(canAccessPatient).not.toHaveBeenCalled();
    noSensitiveReads();
  });
  it("requires a session before any study lookup", async () => {
    vi.mocked(requireSession).mockResolvedValue(null);
    await expect(page()).rejects.toThrow("LOGIN");
    expect(query).not.toHaveBeenCalled();
    noSensitiveReads();
  });
});
it("rejects different stored patient identities before fetching the patient", async () => {
  vi.mocked(canAccessPatient).mockResolvedValue(true);
  query.mockResolvedValueOnce({ rows: [{ patient_id: 42 }] }).mockResolvedValueOnce({ rows: [{ patient_id: 43 }] });
  await expect(compare()).rejects.toThrow("NOT_FOUND");
  noSensitiveReads();
});
it("rejects a patient parameter conflicting with both stored studies", async () => {
  vi.mocked(canAccessPatient).mockResolvedValue(true);
  await expect(compare("43")).rejects.toThrow("NOT_FOUND");
  noSensitiveReads();
});
it("admits the workspace clinical read only after authorization", async () => {
  vi.mocked(canAccessPatient).mockResolvedValue(true);
  vi.mocked(getCephStudy).mockRejectedValue(new Error("clinical read admitted"));
  await expect(workspace()).rejects.toThrow("clinical read admitted");
  expect(vi.mocked(canAccessPatient).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(getCephStudy).mock.invocationCallOrder[0]);
});
it("admits the comparison patient read only after authorizing both studies", async () => {
  vi.mocked(canAccessPatient).mockResolvedValue(true);
  vi.mocked(getPatient).mockRejectedValue(new Error("patient read admitted"));
  await expect(compare()).rejects.toThrow("patient read admitted");
  expect(canAccessPatient).toHaveBeenCalledTimes(2);
  for (const order of vi.mocked(canAccessPatient).mock.invocationCallOrder) {
    expect(order).toBeLessThan(vi.mocked(getPatient).mock.invocationCallOrder[0]);
  }
  expect(getPatient).toHaveBeenCalledWith(42);
});

it.each([
  ['reception', true, true], ['doctor', false, true], ['doctor', true, false], ['admin', true, false],
] as const)('passes explicit clinical read-only capability for %s (upload %s)', async (role, upload, expectedReadOnly) => {
  vi.mocked(requireSession).mockResolvedValue({ ...session, role });
  vi.mocked(canAccessPatient).mockImplementation(async (_session, _id, permission) => permission === 'canViewXrays' || upload);
  vi.mocked(getCephStudy).mockResolvedValue({ analysis: { id: 1, documentId: 51, patientId: 42, status: 'draft', refSet: '' }, landmarks: [], measurements: [], diagnosis: null } as never);
  vi.mocked(getPatient).mockResolvedValue({ fullName: 'Synthetic patient', birthYear: null } as never);
  vi.mocked(getCephReferenceSet).mockResolvedValue(null);
  const page = await workspace();
  const children = page.props.children as Array<{ props?: { readOnly?: boolean; analysis?: { status: string } } }>;
  const tracer = children.find(child => child?.props?.analysis);
  expect(tracer?.props?.readOnly).toBe(expectedReadOnly);
  expect(tracer?.props?.analysis?.status).toBe('draft');
});

it("passes the exact draft source reference snapshot and never rereads mutable reference catalog", async () => {
  vi.mocked(canAccessPatient).mockResolvedValue(true);
  const completionSources={state:"available",identity:{schemaVersion:1,documentId:51,imageSha256:"a".repeat(64),referenceSetKey:"saved",
    referenceSetSha256:"b".repeat(64),engineVersion:"v1",engineSourceSha256:"c".repeat(64)},
    referenceSet:{key:"saved",name:"Viewed source reference",version:"saved-v1",values:[{code:"SNA",mean:93,sd:6}]}};
  vi.mocked(getCephStudy).mockResolvedValue({analysis:{id:1,documentId:51,patientId:42,status:"draft",refSet:"saved"},landmarks:[],measurements:[],diagnosis:null,completionSources} as never);
  vi.mocked(getPatient).mockResolvedValue({fullName:"Synthetic",birthYear:null} as never);
  const page=await workspace();
  const children=page.props.children as Array<{key?:string;props?:{analysis?:unknown;completionSources?:unknown;refValues?:unknown;refSetName?:string}}>;
  const tracer=children.find(child=>child?.props?.analysis);
  expect(tracer?.props?.completionSources).toBe(completionSources);
  expect(tracer?.props?.refValues).toEqual({SNA:{mean:93,sd:6}});
  expect(tracer?.props?.refSetName).toBe("Viewed source reference");
  expect(tracer?.key).toContain(completionSources.identity.imageSha256);
  expect(getCephReferenceSet).not.toHaveBeenCalled();
});

it("remounts the review when a returned source identity changes, even with identical analysis and document IDs", async () => {
  vi.mocked(canAccessPatient).mockResolvedValue(true);
  vi.mocked(getPatient).mockResolvedValue({fullName:"Synthetic",birthYear:null} as never);
  const identity={schemaVersion:1,documentId:51,imageSha256:"a".repeat(64),referenceSetKey:"saved",referenceSetSha256:"b".repeat(64),engineVersion:"v1",engineSourceSha256:"c".repeat(64)};
  const fixture={analysis:{id:1,documentId:51,patientId:42,status:"draft",refSet:"saved"},landmarks:[],measurements:[],diagnosis:null,
    completionSources:{state:"available",identity,referenceSet:{key:"saved",name:"Saved",values:[]}}};
  vi.mocked(getCephStudy).mockResolvedValue(fixture as never);
  const first=await workspace();
  vi.mocked(getCephStudy).mockResolvedValue({...fixture,completionSources:{...fixture.completionSources,identity:{...identity,referenceSetSha256:"d".repeat(64)}}} as never);
  const second=await workspace();
  const child=(page:typeof first)=>(page.props.children as Array<{key?:string;props?:{analysis?:unknown}}>).find(row=>row?.props?.analysis);
  expect(child(first)?.key).not.toBe(child(second)?.key);
  expect(getCephReferenceSet).not.toHaveBeenCalled();
});

it('remounts same-name actor replacements and write-permission changes without reusing the old queue owner',async()=>{
 vi.mocked(canAccessPatient).mockResolvedValue(true);
 vi.mocked(getCephStudy).mockResolvedValue({analysis:{id:1,documentId:51,patientId:42,status:'draft',refSet:''},landmarks:[],measurements:[],diagnosis:null} as never);
 vi.mocked(getPatient).mockResolvedValue({fullName:'Synthetic',birthYear:null} as never);
 const tracer=async()=>{const page=await workspace();return (page.props.children as Array<{key?:string;props?:{actorId?:number;analysis?:unknown}}>).find(c=>c?.props?.analysis)!;};
 const first=await tracer();expect(first.props?.actorId).toBe(1);
 vi.mocked(requireSession).mockResolvedValue({...session,userId:2});const next=await tracer();expect(next.props?.actorId).toBe(2);expect(next.key).not.toBe(first.key);
 vi.mocked(canAccessPatient).mockImplementation(async(_s,_id,permission)=>permission==='canViewXrays');expect((await tracer()).key).not.toBe(next.key);
});
