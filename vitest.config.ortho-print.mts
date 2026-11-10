import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
/** Synthetic SSR + real browser print proof, separate from built Next/DB security. */
export default defineConfig({ resolve:{alias:{'@':fileURLToPath(new URL('.',import.meta.url))}},
  test:{include:['__tests__/print-visual/ortho-full-study-print.test.tsx'],pool:'forks',fileParallelism:false,maxConcurrency:1,testTimeout:120000,hookTimeout:120000} });
