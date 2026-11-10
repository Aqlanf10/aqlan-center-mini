import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it('uploads only eight explicitly named synthetic full-print artifacts and keeps the required hosted proof',()=>{
 const workflow=readFileSync(resolve('.github/workflows/ci.yml'),'utf8');
 const job=workflow.match(/^ {2}contract_print_visual:\n(?:(?!^ {2}\S)[\s\S])*/m)?.[0];expect(job).toBeDefined();
 const steps=job!.split(/^ {6}- /m).filter(step=>step.startsWith('name: Upload synthetic full-study print evidence\n'));expect(steps).toHaveLength(1);
 const paths=steps[0].match(/^ {10}path: \|\n((?: {12}[^\n]+\n)+)/m)?.[1].trim().split('\n').map(path=>path.trim());
 expect(paths).toEqual(['all-layouts.pdf','collage-wide.pdf','all-layouts-first.png','collage-wide-first.png','all-layouts-mapping.json','collage-wide-mapping.json','all-layouts-geometry.json','collage-wide-geometry.json'].map(name=>`.settings-ui-artifacts/ortho-full-print/${name}`));
 expect(paths!.join('\n')).not.toMatch(/[?*]|trace|cookie|\.log|refused|failure/);
 expect(steps[0]).toContain('if-no-files-found: error');expect(steps[0]).toContain('retention-days: 7');
 expect(job).toContain('npm run test:contract-print');expect(job).not.toContain('continue-on-error');
 expect(readFileSync(resolve('vitest.config.print-visual.mts'),'utf8')).toContain('"__tests__/print-visual/ortho-full-study-print.test.tsx"');
});
