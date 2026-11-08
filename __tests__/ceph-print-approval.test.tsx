import { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ study: vi.fn() }));
vi.mock("../lib/db", () => ({ getCephStudy: m.study, getSettingsSafe: async () => ({}), getPatient: async () => ({ fullName: "Synthetic" }), getCephReferenceSet: async () => null }));
vi.mock("../lib/session", () => ({ requireSession: async () => ({ username: "VIEWER_NOT_APPROVER" }) }));
vi.mock("../lib/patient-access", () => ({ canAccessPatient: async () => true }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("not found"); } }));
vi.mock("../components/PrintDocument", () => ({ PrintMetadata: ({ children }: { children: ReactNode }) => children, PrintTableFrame: ({ children }: { children: ReactNode }) => children }));
vi.mock("../components/PrintHeader", () => ({ PrintHeader: () => null, PrintFooter: () => null }));
vi.mock("../components/PrintButton", () => ({ PrintButton: () => null }));
import Page from "../app/print/ceph/[id]/page";
let study: { analysis: { status: string; completedBy: string | null; completedAt: string | null; patientId: number; mmPerPixel: number }; landmarks: never[]; measurements: never[]; diagnosis: { finalDx: string; note: string; createdBy: string } | null };
beforeEach(() => {
  study = { analysis: { status: "draft", completedBy: null, completedAt: null, patientId: 1, mmPerPixel: 0.1 }, landmarks: [], measurements: [],
    diagnosis: { finalDx: "Clinician diagnosis", note: "Original clinician plan", createdBy: "AUTHOR_NOT_APPROVER" } };
  m.study.mockImplementation(async () => study);
});
const html = async () => renderToStaticMarkup(await Page({ params: Promise.resolve({ id: "71" }) }));
describe("printed ceph approval provenance", () => {
  it("does not label a draft approved or substitute author/viewer for an approver", async () => {
    const output = await html();
    expect(output).toContain("Draft"); expect(output).toContain("Original clinician plan");
    expect(output).not.toContain("الخلاصة التشخيصية المعتمدة");
    expect(output).not.toContain("حرر واعُتمد بواسطة");
    expect(output).not.toContain("VIEWER_NOT_APPROVER");
    expect(output).toContain("لم يُعتمد بعد");
  });
  it("does not attribute an unsigned draft without a diagnosis to its current viewer", async () => {
    study.diagnosis = null;
    const output = await html();
    expect(output).not.toContain("VIEWER_NOT_APPROVER");
    expect(output).toContain("لم يُعتمد بعد");
  });
  it("shows only the recorded approver for a completed study", async () => {
    study.analysis = { ...study.analysis, status: "completed", completedBy: "RECORDED_APPROVER", completedAt: "2026-11-05T00:00:00Z" };
    const output = await html(); expect(output).toContain("RECORDED_APPROVER");
    expect(output).not.toContain("VIEWER_NOT_APPROVER"); expect(output).toContain("Original clinician plan");
  });
  it("does not invent an approver when a completed archive lacks identity", async () => {
    study.analysis.status = "completed";
    const output = await html(); expect(output).not.toContain("VIEWER_NOT_APPROVER");
    expect(output).not.toContain("بواسطة: </b>AUTHOR_NOT_APPROVER");
    expect(output).toContain("غير موثّق في السجل");
  });
});
