import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Page } from "playwright";

/** Synthetic component fixture evidence, never an integrated clinical-page claim.
 * The run result and teardown must pass before these artifacts are accepted. */
export async function retainIndependentOrthoEvidence(page: Page, name: string) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error("Invalid evidence filename");
  const dir = process.env.ORTHO_INDEPENDENT_EVIDENCE_DIR ?? ".settings-ui-artifacts";
  // Let finite CSS transitions finish naturally so a screenshot cannot retain
  // the previous tab's highlight after React has committed the new selection.
  await page.evaluate(async () => {
    await Promise.all(document.getAnimations()
      .filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
      .map(animation => animation.finished.catch(() => undefined)));
  });
  const bounds = await page.evaluate(() => ({ width: innerWidth, height: innerHeight,
    scrollWidth: document.documentElement.scrollWidth, text: document.body.innerText }));
  if (bounds.scrollWidth > bounds.width) throw new Error("Independent Ortho component overflows the viewport");
  const png = await page.screenshot({ fullPage: true });
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.png`), png);
  await writeFile(join(dir, `${name}.json`), JSON.stringify({ scope: "synthetic independent React component; transport simulated",
    ...bounds, pngSha256: createHash("sha256").update(png).digest("hex") }, null, 2) + "\n");
}
