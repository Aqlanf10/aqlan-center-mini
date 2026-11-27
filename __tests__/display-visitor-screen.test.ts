import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import DisplayScreen from "../app/display/page";

it("renders visitor guidance without mounting operational KPI cards", () => {
  const markup = renderToStaticMarkup(createElement(DisplayScreen));
  expect(markup).toContain("يرجى انتظار النداء");
  expect(markup).toContain("تشغيل صوت النداء");
  for (const label of ["في الانتظار", "متوسط الانتظار اليوم", "في العلاج الآن", "أُنجز اليوم", "جلسات تقويم اليوم"]) {
    expect(markup).not.toContain(label);
  }
});
