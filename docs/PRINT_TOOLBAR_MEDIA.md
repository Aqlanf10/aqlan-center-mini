# Financial print toolbar containment

## Observation and source diagnosis

The owner reported a WhatsApp action above the printed logo, together with the
browser's page title/URL. These are separate sources of printed content.

On inspected main `bdcaf5bb4829e429fada5f77e23844e0bfb87fa9`:

- `app/print/invoice/[id]/page.tsx` wraps Print and WhatsApp actions in `.no-print`,
  with inline `display: flex`.
- `app/print/print.css` hides `.print-actions` in print media, but has no rule for
  `.no-print`. The Print button disappears while the invoice share link remains.
- `app/print/layout.tsx` already provides the `.print-root` scope and imports the
  stylesheet. No route/component registration change is needed.
- Browser-generated title, URL and date belong to the print dialog's Headers and
  Footers option. An `@page` margin does not disable that preference. The existing
  8 mm document margin is retained and its misleading comment is corrected.

## Bounded correction

Print media hides `.print-root .no-print` with `display: none !important`, so the
rule wins over the existing inline display declaration. Existing `.print-actions`
remain hidden. Screen actions still use their existing layout.

No change is made to document dimensions, logo/clinic identity, legal invoice
content, signatures, reprint watermark, financial values, authorization, print-log
behavior, database schema, production settings or browser preferences.

## Regression contract

`__tests__/security-http/print-toolbar-media-ui.test.ts` is discovered by the
existing security-HTTP test glob and uses the existing built application,
isolated PostgreSQL harness, Chromium and Poppler tools. It creates only its own
synthetic patient, invoice, item, closed shift, receipt and prior-print fixture.
All dated fixture rows use 2000-02-02, separate from current report days and the
P01/commission dates. The 11,000 YER receipt exactly settles 12,500 less 1,500;
no artificial unpaid balance is added to debtor lists.

The test checks:

1. Real invoice toolbar and WhatsApp link visible on screen, despite their inline
   display styles; A4 invoice and A6 receipt screen widths retained.
2. Actual print media with zero-layout invoice toolbar and no visible Print or
   WhatsApp controls. All sheet text, clinic header, logo, signature and existing
   invoice/receipt watermark states remain.
3. Real Chromium PDF text preserving synthetic identity, document numbers,
   invoice items/discount/net, receipt amount and signature, header/title and
   applicable reprint watermark. WhatsApp link annotations must be absent.
4. A negative PDF witness temporarily restores the toolbar's inline display;
   the same annotation validator must reject that PDF. The original inline style
   is restored, and returning to screen media restores usable screen controls.
5. No browser external request, mutation or print-log call; exact fixture invoice,
   item, receipt and print-log rows remain unchanged across viewing/PDF generation.

The PDF call explicitly sets `displayHeaderFooter: false` to isolate application
output. This does not establish control over a user's browser preference.

## Evidence and release boundary

At source preparation, no local installation, runtime, SQL, app server, browser
test or PDF generation was executed. Runtime acceptance remains pending. Run the
normal exact-head CI, including the existing production build and
`npm run test:security-http`, before release. A focused existing-harness command
is `npm run test:security-http -- __tests__/security-http/print-toolbar-media-ui.test.ts`.

The test writes narrowly named synthetic screen/print PNGs and PDFs under
`.settings-ui-artifacts/print-toolbar-*`. After all test assertions, including
context retirement and exact financial-row equality, it emits the six positive
browser-returned buffers via `_print-toolbar-evidence.ts`. No filesystem scan or
existing daily-report artifact name is used.

The `SYNTHETIC_PRINT_EVIDENCE_V1` log transport has per-file BEGIN/END metadata:
`scope`, `file`, `mime`, byte count, SHA-256, chunk count, GitHub run ID, checkout
SHA and `synthetic: true`. CHUNK frames use one-based `index/count` and at most
4,096 base64 characters. A receiver must reject missing/repeated/out-of-order
chunks, unequal BEGIN/END metadata, size/hash mismatch or incomplete files. The
exact allowlist is invoice/receipt screen PNG, print PNG and PDF. Each PNG is
capped at 1 MiB, each PDF at 2 MiB, and all six at 8 MiB; every member is validated
before the first frame. The negative PDF is never transported. Pure helper tests
cover reconstruction, provenance, hashes, framing and fail-before-output cases.

Existing CI upload allowlists and workflow steps are unchanged. These framed
logs provide evidence transport, not a claim that artifact uploads occurred;
actual frames and image/PDF review remain pending until the tests execute.
No owner screenshot or real patient/financial record is copied into fixtures,
source, commits or evidence. Production completion requires normal merge gates
and verification of the exact Railway Production release.
