import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { syntheticStudyCommand } from "./fixtures/ortho-case-study";
import { journeyContentHash } from "../lib/ortho-case-journey-hash";
const state = vi.hoisted(() => ({ session: { userId: 7, username: "SYNTHETIC_VIEWER", role: "doctor" } as Record<string, unknown> | null, read: vi.fn() }));
vi.mock("../lib/session", () => ({ requireSession: async () => state.session }));
vi.mock("../lib/db", () => ({ getSettingsSafe: async () => ({}) }));
vi.mock("../lib/ortho-case-study-store", () => ({ getOrthoCaseStudy: state.read }));
vi.mock("../components/PrintHeader", () => ({ PrintHeader: ({ title }: { title: string }) => <h2>{title}</h2> }));
vi.mock("../components/OrthoStudyPrintButton", () => ({ OrthoStudyPrintButton: () => <button>Print</button> }));
vi.mock("next/navigation", () => ({ notFound: () => { throw Error("not_found"); } }));
import Page from "../app/print/ortho-study/[id]/page";
const input = (query: Record<string, string | string[] | undefined> = { patientId: "19", revisionId: "91" }) => ({ params: Promise.resolve({ id: "41" }), searchParams: Promise.resolve(query) });
beforeEach(() => {
  state.session = { userId: 7, username: "SYNTHETIC_VIEWER", role: "doctor" }; state.read.mockReset();
  const authored = syntheticStudyCommand().content; authored.comment = "SAVED_ONLY <script>synthetic</script>";
  const content = { schemaVersion: 1, capturedAt: "2026-11-05T00:00:00.000Z", recordedPatientId: 19, orthoCaseId: 41, clinicalCaseId: 51, caseStatusAtCapture: "assessment", authored, sources: [] };
  state.read.mockResolvedValue({ ok: true, patientId: 19, orthoCaseId: 41, clinicalCaseId: 51, revision: { id: 91, patientId: 19, orthoCaseId: 41, clinicalCaseId: 51, version: 1, kind: "draft", content, contentHash: journeyContentHash(content) } });
});
describe("authorized saved-study print", () => {
  it("renders exact saved facts safely, provenance and an honest text-only draft label", async () => {
    const html = renderToStaticMarkup(await Page(input()));
    expect(html).toContain("SAVED_ONLY &lt;script&gt;synthetic&lt;/script&gt;"); expect(html).toContain("مسودة"); expect(html).toContain("SHA256:");
    expect(html).toContain("لا تشمل الصور"); expect(html).not.toContain("SYNTHETIC_VIEWER"); expect(html).not.toContain("<script>");
    expect(state.read).toHaveBeenCalledTimes(2);
    expect(state.read).toHaveBeenCalledWith({ session: state.session, patientId: 19, orthoCaseId: 41, revisionId: 91 });
  });
  it("does not expose a printout after current access is revoked during preparation", async () => {
    state.read.mockResolvedValueOnce(await state.read()).mockResolvedValueOnce({ ok: false, status: 403 }); state.read.mockClear();
    await expect(Page(input())).rejects.toThrow("not_found");
  });
  it("requires exact bounded scope and never guesses a revision", async () => {
    for (const query of [{ patientId: "19" }, { patientId: ["19", "20"], revisionId: "91" }, { patientId: "19", revisionId: "91", invoiceId: "7" }])
      await expect(Page(input(query))).rejects.toThrow("not_found");
    expect(state.read).not.toHaveBeenCalled();
    state.session = null; await expect(Page(input())).rejects.toThrow("not_found"); expect(state.read).not.toHaveBeenCalled();
  });
});
