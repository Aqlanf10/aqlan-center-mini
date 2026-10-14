import { expect } from "vitest";
import type { Locator, Page } from "playwright";

/** Browser geometry and native wheel evidence only; no specialty fixtures. */
export async function settleBrowser(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
export function invoiceViewportProof(node: Element) {
  const rect = node.getBoundingClientRect();
  const obstructions = Array.from(document.querySelectorAll("body *")).flatMap(element => {
    const style = getComputedStyle(element), box = element.getBoundingClientRect();
    if (!["fixed", "sticky"].includes(style.position) || style.visibility !== "visible"
      || style.display === "none" || Number(style.opacity) === 0 || box.width <= 0 || box.height <= 0
      || box.right <= rect.left || box.left >= rect.right || element.contains(node)) return [];
    const edge = style.top !== "auto" && box.top <= 1 && box.bottom > 0 && box.bottom < innerHeight ? "top"
      : style.bottom !== "auto" && box.bottom >= innerHeight - 1 && box.top > 0 && box.top < innerHeight ? "bottom" : null;
    return edge ? [{ edge, tag: element.tagName, position: style.position,
      left: box.left, right: box.right, top: box.top, bottom: box.bottom }] : [];
  });
  const top = Math.max(0, ...obstructions.filter(one => one.edge === "top").map(one => one.bottom));
  const bottom = Math.min(innerHeight, ...obstructions.filter(one => one.edge === "bottom").map(one => one.top));
  const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
  const cornerX = Math.min(8, rect.width / 4), cornerY = Math.min(8, rect.height / 4);
  const edgeX = Math.min(2, rect.width / 4), edgeY = Math.min(2, rect.height / 4);
  const points = [
    { name: "center", x: cx, y: cy },
    { name: "top-edge", x: cx, y: rect.top + edgeY },
    { name: "right-edge", x: rect.right - edgeX, y: cy },
    { name: "bottom-edge", x: cx, y: rect.bottom - edgeY },
    { name: "left-edge", x: rect.left + edgeX, y: cy },
    { name: "top-left", x: rect.left + cornerX, y: rect.top + cornerY },
    { name: "top-right", x: rect.right - cornerX, y: rect.top + cornerY },
    { name: "bottom-right", x: rect.right - cornerX, y: rect.bottom - cornerY },
    { name: "bottom-left", x: rect.left + cornerX, y: rect.bottom - cornerY },
  ];
  const hitPoints = points.map(point => ({ ...point, unobscured: node.contains(document.elementFromPoint(point.x, point.y)) }));
  return { tag: node.tagName, label: node.getAttribute("aria-label") ?? node.textContent?.trim(),
    x: rect.x, y: rect.y, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
    width: rect.width, height: rect.height, hitPoints, unobscured: hitPoints.every(point => point.unobscured),
    availableViewport: { top, bottom, height: bottom - top, obstructions },
    viewportWidth: innerWidth, viewportHeight: innerHeight, scrollWidth: document.documentElement.scrollWidth, scrollY,
    dir: document.documentElement.dir };
}
export function assertInvoiceViewportBounds(proof: ReturnType<typeof invoiceViewportProof>, width: number) {
  expect(proof.dir).toBe("rtl"); expect(proof.viewportWidth).toBe(width);
  expect(proof.width).toBeGreaterThan(0); expect(proof.height).toBeGreaterThan(0);
  expect(proof.availableViewport.height).toBeGreaterThan(0);
  expect(proof.left).toBeGreaterThanOrEqual(0); expect(proof.right).toBeLessThanOrEqual(proof.viewportWidth);
  expect(proof.top).toBeGreaterThanOrEqual(proof.availableViewport.top);
  expect(proof.bottom).toBeLessThanOrEqual(proof.availableViewport.bottom);
  expect(proof.hitPoints).toHaveLength(9);
  for (const point of proof.hitPoints) expect(point.unobscured, `${proof.tag}: ${point.name}`).toBe(true);
  expect(proof.unobscured).toBe(true); expect(proof.scrollWidth).toBeLessThanOrEqual(proof.viewportWidth + 1);
}
export async function revealInvoiceControlByWheel(page: Page, control: Locator) {
  expect(await control.count()).toBe(1);
  await page.evaluate(async () => { await document.fonts.ready; });
  await settleBrowser(page);
  const before = await control.evaluate(invoiceViewportProof);
  expect(before.height).toBeGreaterThan(0);
  expect(before.height).toBeLessThanOrEqual(before.availableViewport.height);
  const y = (before.availableViewport.top + before.availableViewport.bottom) / 2;
  // Use the page-content gutter, checking the actual pointer target so a native
  // select/textarea cannot consume the wheel or silently change its own value.
  const pointer = await control.evaluate((node, y) => {
    const main = node.closest("main");
    const x = Math.max(2, Math.min(innerWidth - 2, (main?.getBoundingClientRect().left ?? 0) + 4));
    const target = document.elementFromPoint(x, y);
    return { x, y, targetTag: target?.tagName ?? null,
      nativeField: target?.closest("input,textarea,select")?.tagName ?? null };
  }, y);
  expect(pointer.targetTag).not.toBeNull(); expect(pointer.nativeField).toBeNull();
  const distance = before.top + before.height / 2 - y;
  const deltaY = Math.abs(distance) < 1 ? 2 : distance;
  await page.mouse.move(pointer.x, pointer.y); await page.mouse.wheel(0, deltaY);
  await settleBrowser(page);
  const wheelInputs = [deltaY];
  await expect.poll(async () => {
    const proof = await control.evaluate(invoiceViewportProof);
    const reachable = proof.top >= proof.availableViewport.top && proof.bottom <= proof.availableViewport.bottom && proof.unobscured;
    // Account siblings can settle after the first wheel. Reframe by actual
    // native input; every final bounds and nine-point hit assertion still runs.
    if (!reachable && wheelInputs.length < 5) {
      const adjustment = proof.top + proof.height / 2 - y;
      wheelInputs.push(Math.abs(adjustment) < 1 ? 2 : adjustment);
      await page.mouse.move(pointer.x,pointer.y); await page.mouse.wheel(0,wheelInputs.at(-1)!);
      await settleBrowser(page);
    }
    return reachable;
  }).toBe(true);
  await settleBrowser(page);
  const proof = await control.evaluate(invoiceViewportProof);
  assertInvoiceViewportBounds(proof, before.viewportWidth);
  return { ...proof, reachability: { method: "native-mouse-wheel", pointer, deltaY, wheelInputs,
    beforeTop: before.top, beforeBottom: before.bottom, beforeScrollY: before.scrollY, afterScrollY: proof.scrollY } };
}
