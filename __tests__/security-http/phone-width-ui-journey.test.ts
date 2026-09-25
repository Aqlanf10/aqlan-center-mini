import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { baseUrl, harness } from "./_server";

/**
 * (P3-4) الشاشات اليومية على هاتفٍ عرضه 390px — بلا تمريرٍ أفقي.
 *
 * العيب (تدقيق الجاهزية): /lab تفيض 113px على الهاتف، فيضيع زرّ أو عمود خارج
 * الشاشة ويسحب المستخدم الصفحة جانبيًّا. المقياس: عرض المستند لا يتجاوز عرض
 * النافذة.
 */

const PHONE = { width: 390, height: 844 };
const SCREENS = ["/", "/lab", "/appointments", "/patients", "/finance", "/waiting-list", "/recall", "/account"];

let browser: Browser;
let context: BrowserContext;
let h: Awaited<ReturnType<typeof harness>>;

function sessionCookie(raw: string): { name: string; value: string } {
  const [name, ...rest] = raw.split("=");
  return { name, value: rest.join("=") };
}

beforeAll(async () => {
  h = await harness();
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  });
  context = await browser.newContext({ viewport: PHONE, locale: "ar-YE", isMobile: true, hasTouch: true });
  await context.addCookies([{ ...sessionCookie(h.sessions.admin.cookie), url: baseUrl }]);
}, 240_000);

afterAll(async () => {
  await context?.close();
  await browser?.close();
});

describe("P3-4 — no horizontal overflow at phone width", () => {
  for (const path of SCREENS) {
    it(`${path} fits a 390px phone`, async () => {
      const page = await context.newPage();
      try {
        const response = await page.goto(`${baseUrl}${path}`, { waitUntil: "networkidle" });
        expect(response?.status()).toBe(200);
        const overflow = await page.evaluate(() => {
          const root = document.documentElement;
          const wide = [...document.querySelectorAll<HTMLElement>("body *")]
            .filter((element) => element.getBoundingClientRect().right > root.clientWidth + 1
              || element.getBoundingClientRect().left < -1)
            .slice(0, 5)
            .map((element) => `${element.tagName.toLowerCase()}.${String(element.className).slice(0, 60)}`);
          return { excess: root.scrollWidth - root.clientWidth, wide };
        });
        expect(overflow.excess, `${path}: ${overflow.wide.join(" | ")}`).toBeLessThanOrEqual(1);
      } finally {
        await page.close();
      }
    }, 60_000);
  }
});
