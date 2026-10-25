# Statement PDF Arabic label repair

Based independently on frozen verification #439, `9881d33c21c4812ae3e18219a8112438d6192a78`. #444 is unchanged. No financial reader/writer, migration, historical-detail component, global print CSS, or test assertion changes.

## Cause and narrow repair

Under Chromium 151.0.7922.173 / Skia PDF and Poppler 25.03.0, Noto Naskh Arabic's mark positioning produces extracted intra-word gaps: `المحصّل` becomes `المحّص ل`, and `المسدّد` becomes `المسّد د`. The unchanged test's existing diacritic normalization does not remove spaces, so it correctly fails. This is different from the previously repaired lam-alef work-source defect.

The database-free probe varies shaping features and font. Disabling `mark` passes extraction but visibly misplaces shadda; rejected. Disabling only `calt`, `kern` or `mkmk` does not repair the problem. Existing Plex also fails label extraction. The retained probe images/text show those results.

A 39,572-byte self-hosted DejaVu Sans subset with ordinary GSUB/GPOS shaping repairs both labels. A route-local CSS module applies it only to the first span of two explicitly marked rows. Numeric spans, entered text and other routes keep their fonts. No network font dependency. The font is renamed and its distribution license included. Raw combining-mark order may still differ; the original test normalization is unchanged, and no spaces or letters are discarded by a new workaround.

Composition boundary for the separate historical-detail work: only `page.tsx` import and the collected/paid row class attributes change; `presentation.tsx` and global `print.css` are byte-identical to base.

## Acceptance evidence

- Next production build including TypeScript, targeted ESLint, preflight artifact build and runtime braces absence verification passed.
- 46 existing tests in statement-print, account-consistency and portal-parity passed.
- Seven existing real built-route browser/HTTP cases passed, including current and dated statements, normal invoice, A6 receipt and invoice-role checks.
- Crucially the unchanged active-agreement test reached the later payment and second PDF: collected 1,300 → 1,370 SAR; agreement paid 1,200 → 1,270 SAR; remaining 1,800 → 1,730 SAR. Stale-value disappearance assertions passed. Base previously failed at the first collected label before these assertions.
- Before/after full-page PDF renders were visually inspected: correct visible shadda, readable labels, aligned amounts and no clipping. Normal invoice and receipt renders were inspected; their fonts do not include the new font. Font proof and complete synthetic PDF/text/PNG witnesses are retained here.

`product-hashes.json` binds this precommit witness to the exact product and unchanged acceptance test bytes. `unit-result.txt` and `browser-result.txt` preserve local results. These are synthetic checks, not Production compatibility, physical-printer certification or permission to deploy. Fresh final-head CI and independent review remain gates; the separately owned dependency-audit lifecycle issue is not bypassed here.

## Reproduction

Saved environment: Node 22.23.3, PostgreSQL 18.6 (isolated localhost container), Debian 13, system Chromium 151.0.7922.173, Poppler 25.03.0, fonts-noto-core 20201225-2, fontTools 4.61.1. No packages/fonts were downloaded for this repair.

From repository root with existing dependencies/system fonts:

```sh
node docs/review/statement-pdf-arabic-labels/probe/reproduce.cjs /tmp/statement-label-probe
python3 docs/review/statement-pdf-arabic-labels/subset.py /tmp/statement-labels.woff
```

The subset recipe verifies the installed source hash and pins font metadata; output SHA256 is `63e6983e3049f3d9a5d51cd27df9c64aeb38799b85aa3ed852c3fad78d46575b`. Source SHA256 is `57f73e11f51999432bf7ab22ce55b6f945d5eca1bf824404cfa9ec2e3718c84e`. The probe is database-free. Use only the repository's guarded synthetic HTTP harness and an owned localhost PostgreSQL test database for real-route acceptance; never point it at a clinic database.

Selected acceptance invocation after the production build:

```sh
npm run test:security-http -- __tests__/security-http/patient-statement-current-print-ui.test.ts __tests__/security-http/patient-statement-cutoff-ui.test.ts __tests__/security-http/print-toolbar-media-ui.test.ts __tests__/security-http/invoice-quote-statement-http.test.ts
```

Set `TEST_DATABASE_URL` to the owned disposable localhost fixture, `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium`, `SECURITY_HTTP_PORT=3331`, and the repository's documented synthetic environment. The harness starts/stops its local server and creates/drops its synthetic database.
