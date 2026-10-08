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
   invoice items/discount/net and receipt amount. Complete colon-bearing signature
   labels and signer are checked in native RTL order on one bounded 8pt-style row.
   Clinic header/title
   uses ordered bbox words inside the first 180 pt (and first half) of page one,
   with calibrated lam-alef glyph pairing. The actual PDF raster must retain
   colored logo ink in the existing centered 11 mm region. The reprint watermark
   uses exact spatial glyph order in its central large-font region, including
   explicit absence on a first print. WhatsApp link annotations must be absent.
4. Independent actual negative PDFs hide the header/logo, signature row or watermark:
   their respective oracles must reject the missing region while the other
   region still passes. A separate negative PDF restores the toolbar's inline
   display; the same annotation validator must reject its WhatsApp link. Every
   temporary inline style is restored, and screen controls return afterward.
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

## Actual extraction calibration, 2026-10-08

Initial PR290 head `c865e06c47415dd072e19d54f36129313742fc9d` failed its Arabic
whole-word text oracle, after invoice screen/print DOM checks. Diagnostic-only
head `c8730406378f90c7571777578c9e39a54143feca`, exact run `37709082384` and checkout
`53365afb482f79744bb35f00bcd81a9f264173e3`, retained that failure and emitted one
strictly framed failed synthetic invoice PDF. Its 295,834 bytes have SHA-256
`d93af041b99a8b493f54df253efa0fd80b7c336cad3fde654de4480cace09756`. This is failed-run
diagnostic evidence, not six-file acceptance or release proof. That run passed
7,183 unit and 1,403 PostgreSQL tests; HTTP had 1,044 passes and this one failure.
The inherited commission screenshot case passed all 17 cases on that run.

The actual one-page A4 raster shows the correct clinic name, logo, financial
content and watermark without the WhatsApp toolbar. Its raw bbox word is
`نلاقع` (U+0646 U+0644 U+0627 U+0642 U+0639), while the rendered word is `عقلان`.
The extracted code points already retain the lam-alef pair; reversing before or
after Unicode normalization alone does not resolve it. The new helper retains
lam plus alef as one expected glyph cluster, consumes header words in native
line/RTL order and refuses missing/reordered/out-of-region words. It does not
accept unordered character membership across the page.

The diagonal watermark yields 12 large-font fragments. Their spatial RTL order
reconstructs exactly `نسخةمعادطباعتها`; the helper does not search the whole-page
text for independent watermark letters. The observed 96 dpi centered logo region
contains 192 colored-ink pixels, above the conservative 20-pixel threshold. Real
header-hidden, signature-hidden and watermark-hidden PDF controls must validate
these independent oracles on the next exact-head CI run.

Offline parsing/raster inspection of that retained PDF calibrated the proposed
oracles; no local app, database, TypeScript test or browser test was executed.
The newly changed test source, its negative PDFs and the receipt PDF still need
fresh full CI and six-file pixel review. Calibration is limited to these existing
synthetic document styles and this bounded header/watermark layout, not arbitrary
Arabic PDFs, fonts or clinic-wide print certification. Product rendering, logo,
watermark placement and financial values remain unchanged.

Offline review of all remaining invoice Arabic assertions also found colon/dot
bidi reordering in layout text: `المحاسب................ :` while the bbox contains
the intact `:بساحملا` word. Signature proof therefore consumes the full labels
and signer on one geometrically ordered row in the lower document region;
colons are required. Missing, moved, reordered and punctuation-lost unit controls
and a real signature-hidden PDF must fail, with header/logo/watermark retained.
The next fresh receipt PDF is still needed to validate its corresponding row.

The original toolbar regression preserved verification/tax wording as rendering
content only; it did not establish any certification. The bounded document-copy
correction now uses a neutral invoice heading and the existing invoice-number/id
reference. It removes the unconditional verification badge and the unsupported
tax/registration lookups and invented fallback. Those keys are outside the
settings allowlist, so the normal settings reader never supplies them.

The native-PDF regression requires the neutral labels/reference and rejects the
former assertions while retaining its independent header/logo, signature,
watermark and financial-content checks. Server-render fixtures cover ordinary,
paid, cancelled and reprinted invoices, including extra unrecognized identifier
values without adding a settings policy. Receipt content is unchanged.

This is a source-level document-truthfulness correction. The clinic's legal or
tax status is not assessed, and no electronic-invoice certification is claimed.
Fresh exact-head CI and native-PDF inspection are still required for release.
