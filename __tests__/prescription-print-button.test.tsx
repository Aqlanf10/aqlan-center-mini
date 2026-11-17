import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
const state = vi.hoisted(() => ({ set: vi.fn(), fetch: vi.fn(), print: vi.fn() }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useState: (initial: unknown) => [initial, state.set] }));
import { PrintButton } from "../components/PrintButton";
const dataset: Record<string, string> = {};
beforeEach(() => {
  vi.clearAllMocks(); delete dataset.reprint;
  vi.stubGlobal("fetch", state.fetch);
  vi.stubGlobal("window", { print: state.print });
  vi.stubGlobal("document", { documentElement: { dataset } });
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => callback());
});
afterEach(() => vi.unstubAllGlobals());
async function click(docType: "prescription" | "receipt", docId: number | undefined = 42) {
  const tree = PrintButton({ docType, docId, patientId: 123 });
  const button = tree.props.children[1] as ReactElement<{ onClick: () => void }>;
  button.props.onClick();
  await vi.waitFor(() => expect(state.set).toHaveBeenCalledWith(false));
}
describe("prescription print registration gate", () => {
  it.each([
    { ok: false, body: { previous: 0, reprint: false } },
    { ok: true, body: {} },
    { ok: true, body: { previous: "0", reprint: false } },
    { ok: true, body: { previous: 0, reprint: "false" } },
  ])("never opens prescription printing for invalid response %j", async ({ ok, body }) => {
    state.fetch.mockResolvedValue({ ok, json: async () => body });
    await click("prescription");
    expect(state.print).not.toHaveBeenCalled();
  });
  it("fails closed on network failure while preserving financial print fallback", async () => {
    state.fetch.mockRejectedValue(new Error("offline"));
    await click("prescription"); expect(state.print).not.toHaveBeenCalled();
    await click("receipt"); expect(state.print).toHaveBeenCalledTimes(1);
  });
  it("sends patient identity and sets the watermark before opening a registered reprint", async () => {
    state.fetch.mockResolvedValue({ ok: true, json: async () => ({ previous: 1, reprint: true }) });
    state.print.mockImplementation(() => expect(dataset.reprint).toBe("true"));
    await click("prescription");
    expect(state.fetch).toHaveBeenCalledWith("/api/print-log", expect.objectContaining({ body: JSON.stringify({ docType: "prescription", docId: 42, patientId: 123 }) }));
    expect(state.print).toHaveBeenCalledTimes(1);
  });
});
