import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import ServicesPage from "../app/finance/services/page";
import { CLINIC_BASE_CURRENCY, CURRENCY_LABEL } from "../lib/money";

const session = vi.hoisted(() => ({ role: "admin" }));
vi.mock("../components/SessionProvider", () => ({ useSession: () => session }));
vi.mock("../components/PageHeader", () => ({ PageHeader: () => null }));
afterEach(() => { session.role = "admin"; vi.unstubAllGlobals(); });

describe("new service base-currency price label", () => {
  it("renders a persistent visible and accessible YER label without a new currency selector", () => {
    const fetchSpy = vi.fn(); vi.stubGlobal("fetch", fetchSpy);
    const html = renderToStaticMarkup(createElement(ServicesPage));
    const label = `السعر (${CURRENCY_LABEL[CLINIC_BASE_CURRENCY]})`;
    expect(CLINIC_BASE_CURRENCY).toBe("YER");
    const form = html.match(/<form\b[\s\S]*?<\/form>/)?.[0] ?? "";
    expect(form).toContain(`>${label}</span>`);
    expect(form).toContain(`aria-label="${label}"`);
    expect(form).toContain('placeholder="السعر القياسي"');
    expect(form).not.toContain('aria-label="السعر"');
    expect(form).not.toContain('aria-label="العملة"');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("preserves the accountant's read-only service page", () => {
    session.role = "accountant";
    const html = renderToStaticMarkup(createElement(ServicesPage));
    expect(html).not.toContain("<form");
    expect(html).not.toContain('aria-label="السعر');
  });
});
