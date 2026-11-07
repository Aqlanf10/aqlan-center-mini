import { cephComparisonProjectionSha256 } from "../lib/ceph-comparison-projection";
import type { CephAnalysisForCompare } from "../lib/db";
import {beforeEach,describe,expect,it,vi} from "vitest";
const m=vi.hoisted(()=>({session:vi.fn(),access:vi.fn(),study:vi.fn()}));
vi.mock("../lib/session",()=>({requireSession:m.session}));
vi.mock("../lib/patient-access",()=>({canAccessPatient:m.access}));
vi.mock("../lib/db",()=>({getCephAnalysisForCompare:m.study}));
import {GET as compare} from "../app/api/ceph/compare/route";
import {GET as overlay} from "../app/api/ceph/superimpose/route";
beforeEach(()=>{vi.clearAllMocks();m.session.mockResolvedValue({role:"doctor",username:"synthetic"});m.access.mockResolvedValue(true);});
describe("completed comparison provenance boundary",()=>{
  it.each([compare,overlay])("blocks legacy and corrupt endpoints before numeric or overlay output",async(route)=>{
    m.study.mockImplementation(async(id:number)=>({id,patientId:1,comparisonUnavailableReason:"Historical units and calculation version unavailable",measurements:[{code:"SNA",value:82}],points:{}}));
    const response=await route(new Request("http://localhost/api/ceph/compare?first=1&second=2"));
    expect(response.status).toBe(409);expect(await response.json()).toEqual({message:"Historical units and calculation version unavailable"});
  });
  it("does not disclose the provenance blocker before current image-scope admission",async()=>{
    m.study.mockImplementation(async(id:number)=>({id,patientId:1,comparisonUnavailableReason:"Private source detail"}));m.access.mockResolvedValue(false);
    const response=await compare(new Request("http://localhost/api/ceph/compare?first=1&second=2"));
    expect(response.status).toBe(403);expect(JSON.stringify(await response.json())).not.toContain("Private source detail");
  });
});

const draft = (id: number): Omit<CephAnalysisForCompare, "projectionSha256"> => ({
  id, patientId: 11, documentId: id + 50, status: "draft", provenanceState: "not_completed", imageSha256: null,
  phase: "pretreatment", xrayDate: id === 1 ? "2020-01-01" : "2022-01-01", createdAt: id === 1 ? "2020-01-01" : "2022-01-01",
  mmPerPixel: .1, points: { S: { x: 20, y: 20 }, N: { x: 80, y: 20 }, Me: { x: 60, y: 100 } },
  documentWidth: 800, documentHeight: 600,
  measurements: [{ code: "SNA", name: "SNA", value: 82, mean: 82, unit: "°" }],
  comparisonUnavailableReason: null, provenanceNotice: "Draft preview",
});
describe("comparison and overlay projected source contract", () => {
  it("forwards both matching opaque identities after chronological ordering of a reversed request", async () => {
    m.study.mockImplementation(async (id: number) => { const source = draft(id); return { ...source, projectionSha256: cephComparisonProjectionSha256(source) }; });
    const request = () => new Request("http://localhost/api/ceph/compare?first=2&second=1");
    const compared = await (await compare(request())).json(), placed = await (await overlay(request())).json();
    expect(compared.before.id).toBe(1); expect(compared.after.id).toBe(2);
    for (const side of ["before", "after"]) {
      expect(placed[side].id).toBe(compared[side].id);
      expect(placed[side].projectionSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(placed[side].projectionSha256).toBe(compared[side].projectionSha256);
    }
  });
  it.each((["before", "after"] as const).flatMap(side => ["landmarks", "scale", "projected mean"].map(change => ({ side, change })) ))(
    "identifies a same-ID $side $change mutation between the two real handlers", async ({ side, change }) => {
      const sources = [draft(1), draft(2)];
      m.study.mockImplementation(async (id: number) => { const source = sources[id - 1]; return { ...source, projectionSha256: cephComparisonProjectionSha256(source) }; });
      const request = () => new Request("http://localhost/api/ceph/compare?first=1&second=2");
      const compared = await (await compare(request())).json();
      const changed = sources[side === "before" ? 0 : 1];
      if (change === "landmarks") changed.points.N!.x += 10;
      if (change === "scale") changed.mmPerPixel = .2;
      if (change === "projected mean") changed.measurements[0].mean = 90;
      const response = await overlay(request()); expect(response.status).toBe(200);
      const placed = await response.json();
      expect(placed[side].id).toBe(compared[side].id); expect(placed[side].status).toBe("draft");
      expect(placed[side].projectionSha256).not.toBe(compared[side].projectionSha256);
      const unchanged = side === "before" ? "after" : "before";
      expect(placed[unchanged].projectionSha256).toBe(compared[unchanged].projectionSha256);
    });
  it.each([compare, overlay])("does not let projection identity bypass current patient access", async route => {
    m.study.mockImplementation(async (id: number) => { const source = draft(id); return { ...source, projectionSha256: cephComparisonProjectionSha256(source) }; });
    m.access.mockResolvedValue(false);
    const response = await route(new Request("http://localhost/api/ceph/compare?first=1&second=2"));
    expect(response.status).toBe(403); expect(await response.text()).not.toContain("projectionSha256");
  });
});
