import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { createVitest } from 'vitest/node';

it('discovers source tests without rediscovering their Next standalone copies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aqlan-vitest-discovery-'));
  let context: Awaited<ReturnType<typeof createVitest>> | undefined;
  try {
    const originals = ['__tests__/synthetic-owner.test.ts', '__tests__/synthetic-review.test.tsx'];
    for (const source of originals) {
      for (const path of [source, `.next/standalone/${source}`]) {
        const target = join(root, path);
        await mkdir(dirname(target), { recursive: true });
        // Discovery must not execute either the originals or generated copies.
        await writeFile(target, "throw new Error('discovery must not execute fixtures');\n");
      }
    }
    context = await createVitest('test', {
      config: fileURLToPath(new URL('../vitest.config.mts', import.meta.url)),
      root,
      watch: false,
      reporters: [],
    });
    const discovered = (await context.globTestSpecifications())
      .map(specification => relative(root, specification.moduleId).replaceAll('\\', '/')).sort();
    expect(discovered).toEqual([...originals].sort());
  } finally {
    try { await context?.close(); }
    finally { await rm(root, { recursive: true, force: true }); }
  }
});
