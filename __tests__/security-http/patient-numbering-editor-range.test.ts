import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import { guardBrowserRoutes } from "../helpers/guarded-browser-routes";

it("previews independent prefixes, preserves the P and legacy floors, and submits canonical settings", async () => {
  const bundle = await build({
    stdin: {
      resolveDir: fileURLToPath(new URL("../../", import.meta.url)),
      loader: "tsx",
      contents: `
        import { useState } from "react";
        import { createRoot } from "react-dom/client";
        import { PatientNumberingEditor } from "./components/settings/PatientNumberingEditor";
        function Fixture() {
          const [settings, save] = useState({ prefix: "P", nextNumber: location.hash === "#exhausted" ? "1000000000000000000" : "7000",
            ...(location.hash && { perPrefix: true }) });
          return <PatientNumberingEditor initial={settings} onSaved={save} />;
        }
        createRoot(document.getElementById("root")).render(<Fixture />);
      `,
    },
    jsx: "automatic",
    bundle: true,
    write: false,
    platform: "browser",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  const origin = "https://numbering.test";
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  try {
    const context = await browser.newContext({ locale: "ar-YE", serviceWorkers: "block" });
    const unexpected: string[] = [];
    const submitted: unknown[] = [];
    const guard = await guardBrowserRoutes(context, origin, unexpected, async (route) => {
      const request = route.request();
      if (request.method() === "GET" && request.url() === origin + "/") {
        return route.fulfill({ contentType: "text/html", body: '<main id="root"></main>' });
      }
      if (request.method() === "PATCH" && request.url() === origin + "/api/settings/patient-numbering") {
        const input = request.postDataJSON();
        submitted.push(input);
        const managed = new URL(request.frame().url()).hash === "#managed";
        return route.fulfill({
          json: { prefix: input.prefix, nextNumber: input.firstNumber, ...(managed && { perPrefix: true }) },
        });
      }
      unexpected.push(request.method() + " " + request.url());
      return route.abort();
    });
    await guard.run(
      async () => {
        async function openEditor(fragment = "") {
          const page = await context.newPage();
          await page.goto(origin + "/" + fragment);
          await page.addScriptTag({ content: bundle.outputFiles[0].text });
          const editor = page.getByRole("form", { name: "ترقيم ملفات المرضى الجديدة" });
          return {
            editor,
            prefix: editor.getByLabel("البادئة", { exact: false }),
            number: editor.getByLabel("أول رقم للملفات الجديدة"),
            save: editor.getByRole("button", { name: "حفظ ترقيم الملفات" }),
          };
        }
        const legacy = await openEditor();
        await legacy.prefix.fill("brw");
        await legacy.number.fill("١٥٠٠");
        expect(await legacy.save.isDisabled()).toBe(true);
        await legacy.number.press("Enter");
        expect(submitted).toHaveLength(0);
        await legacy.number.fill("٧٠٠١");
        await legacy.save.click();
        expect(await legacy.editor.getByRole("status").innerText()).toContain("BRW-07001");

        const { editor, prefix, number, save } = await openEditor("#managed");
        for (const invalid of ["bß", "ı", "ſ", "ﬃ", "ABCDEFG"]) {
          await prefix.fill(invalid);
          expect(await save.isDisabled()).toBe(true);
        }
        await prefix.fill("brw");
        expect(await prefix.inputValue()).toBe("BRW");
        await number.fill("1000000000000000000");
        expect(await save.isDisabled()).toBe(true);
        await number.fill("١٥٠٠");
        expect(await editor.innerText()).toContain("سيتحقق النظام عند الحفظ");
        expect(await editor.innerText()).toContain("BRW-01500");
        await save.click();
        expect(await editor.getByRole("status").innerText()).toContain("BRW-01500");
        await number.fill("١٤٩٩");
        expect(await save.isDisabled()).toBe(true);
        await prefix.fill("p");
        await number.fill("۶۹۹۹");
        expect(await save.isDisabled()).toBe(true);
        await number.fill("۷۰۰۰");
        await save.click();
        expect(await editor.getByRole("status").innerText()).toContain("P-07000");
        const exhausted = await openEditor("#exhausted");
        expect(await exhausted.editor.innerText()).toContain("استُنفد نطاق الترقيم الحالي");
        expect(await exhausted.save.isDisabled()).toBe(true);
        await exhausted.prefix.fill("BRW");
        await exhausted.number.fill("١٥٠٠");
        expect(await exhausted.save.isEnabled()).toBe(true);
      },
      () => {
        expect(unexpected).toEqual([]);
        const requestId = expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        );
        expect(submitted).toEqual([
          { prefix: "BRW", firstNumber: "7001", requestId },
          { prefix: "BRW", firstNumber: "1500", requestId },
          { prefix: "P", firstNumber: "7000", requestId },
        ]);
      },
    );
  } finally {
    await browser.close();
  }
}, 30_000);
