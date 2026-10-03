import { afterEach, describe, expect, it, vi } from "vitest";
import { PerioApiError, perioWorkspaceApi, readExam } from "../components/periodontics/api";
import { examFixture } from "./periodontics-workspace-fixtures";
const signal = () => new AbortController().signal;
afterEach(() => vi.unstubAllGlobals());
describe("periodontal workspace same-origin API contract", () => {
  it("rejects cross-patient, invalid and mixed snapshots", () => {
    expect(() => readExam(examFixture({ patientId: 2 }), 1)).toThrow(PerioApiError);
    expect(() => readExam(examFixture({ revision: 0 }), 1)).toThrow(PerioApiError);
    expect(() => readExam({ ...examFixture(), sites: [{ toothCode: 11, site: "MB", probingDepthMm: "1", bleedingOnProbing: false }] }, 1)).toThrow(PerioApiError);
    expect(() => readExam({ ...examFixture(), addenda: [{}] }, 1)).toThrow(PerioApiError);
  });
  it("recomputes coverage from the verified snapshot without trusting stale summary counts", () => {
    const result = readExam({ ...examFixture(), summary: { recordedDepthSites: 999 } }, 1);
    expect(result.summary.recordedDepthSites).toBe(2); expect(result.summary.bleedingPercent).toBe(0);
  });
  it("loads no-cache canonical history with same-origin credentials", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ exams: [examFixture()] })); vi.stubGlobal("fetch", fetch);
    const result = await perioWorkspaceApi.list(1, signal());
    expect(result).toHaveLength(1); expect(fetch).toHaveBeenCalledWith("/api/patients/1/perio", expect.objectContaining({ method: "GET", cache: "no-store", credentials: "same-origin" }));
  });
  it("sends exact numeric context/revision, preserving explicit null, zero and false", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ exam: examFixture(), unchanged: false })); vi.stubGlobal("fetch", fetch);
    const body = { doctorId: 7, caseId: null, expectedRevision: 3, sites: examFixture().sites };
    await perioWorkspaceApi.save(1, 11, body, signal());
    expect(fetch).toHaveBeenCalledWith("/api/patients/1/perio/visits/11", expect.objectContaining({ method: "PUT", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }));
  });
  it("does not accept a mutation response for a different visit or exam", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ exam: examFixture({ visitId: 12 }) })); vi.stubGlobal("fetch", fetch);
    await expect(perioWorkspaceApi.save(1, 11, { ...examFixture(), expectedRevision: 3 }, signal())).rejects.toBeInstanceOf(PerioApiError);
    fetch.mockResolvedValue(Response.json({ exam: examFixture({ id: 102 }) }));
    await expect(perioWorkspaceApi.addendum(1, 101, { text: "Correction", requestKey: "perio:stable" }, signal())).rejects.toBeInstanceOf(PerioApiError);
  });
  it("preserves stable conflict codes and classifies network/server/malformed success as uncertain", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ message: "Conflict", code: "revision_conflict" }, { status: 409 })); vi.stubGlobal("fetch", fetch);
    await expect(perioWorkspaceApi.list(1, signal())).rejects.toMatchObject({ status: 409, code: "revision_conflict", uncertain: false });
    fetch.mockRejectedValue(new TypeError("network")); await expect(perioWorkspaceApi.list(1, signal())).rejects.toMatchObject({ uncertain: true });
    fetch.mockResolvedValue(Response.json({ message: "unknown" }, { status: 500 })); await expect(perioWorkspaceApi.list(1, signal())).rejects.toMatchObject({ uncertain: true });
    fetch.mockResolvedValue(new Response("not JSON")); await expect(perioWorkspaceApi.list(1, signal())).rejects.toMatchObject({ uncertain: true });
  });
  it("rejects duplicate visit snapshots rather than silently choosing one", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ exams: [examFixture(), examFixture({ id: 102 })] })));
    await expect(perioWorkspaceApi.list(1, signal())).rejects.toBeInstanceOf(PerioApiError);
  });
});
