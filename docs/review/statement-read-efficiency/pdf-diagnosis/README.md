# PDF collected-label failure — unresolved acceptance blocker

Failing unchanged test: `__tests__/security-http/patient-statement-current-print-ui.test.ts`, describe `current patient statement PDF with an active agreement and real on-account payments`, case `prints invoice net/discount, net collected and agreement paid/remaining by currency; the next PDF moves them together`. `pdfLine` line287 requires exactly one matching numeric line; `expectStatement` line311 fails at the **first** PDF, invoked at351. Later payment and second-PDF assertions have NOT run successfully locally. Inheritance does not make the failure acceptable.

Same environment, independently built frozen base9881d33 and candidate8445d830: base1/2 print cases pass; candidate1/2 print plus4/4 portal cases pass. Both fail the same label after on-page financial assertions pass. App source/test/print stylesheet are unchanged between refs. Both extracted PDFs contain:

- Expected: `صافي المحصّل بعد الاستردادات وعكس السندات`
- Actual after existing plain normalization: `صافي المحّص ل بعد الاستردادات وعكس السندات`
- Numeric value remains `1,300.00ر.س`.

The test's existing `arabicKey` removes diacritics but leaves U+0020 between sad and final lam. Source/DOM contains exact expected Unicode; source corruption is not observed. Full codepoint/line evidence is in text-comparison.json and source-and-extractor.json.

Runtime: Node22.23.3; system Chromium151.0.7922.173 (`151.0.7922.173-1~deb13u1`), Debian13; Poppler/pdftotext25.03.0 (`25.03.0-5+deb13u4`); fonts-noto-core20201225-2. Actual PDF embeds NotoNaskhArabic-Regular/Bold and LiberationSans-Regular/Bold with Unicode maps. Print CSS selects Noto Naskh Arabic first. Naskh regular SHA2568c67eaa2f0086872628fc3f7f760386f83c8be5c5e9a1ba3a38891237b2ac7cb; bold b5cbcb561b4b540ff11d7b6934577dbbbbb9e1d152d47f6f31f19176d58ff39c. No browser/font download. Interactive fc-match outside the test's sanitized HOME=/tmp emitted unwritable-cache warnings; embedded PDF fonts provide the direct evidence of actual font use.

## Minimal database-free reproduction

Copy reproduce.cjs.txt to a writable directory as reproduce.cjs; its require path points to the existing candidate's Playwright package and executable `/usr/bin/chromium`. Run with Node22, HOME=/tmp, PATH including pdftotext. It writes local HTML/PDF/text/results, does not contact an app/database/network, and applies the unchanged `plain`/`arabicKey`/one-numeric-line predicate. All variants keep exact DOM/source label and amount.

Noto Naskh and Noto Sans reproduce the mismatch. Disabling liga/rlig with Naskh does NOT repair it. DejaVu Sans, both with and without those features, passes the unchanged predicate in this tiny reproducer. This is diagnostic only, not full print acceptance or a visual-typography verdict.

## Relationship to prior Arabic PDF defect and proposed scope

Prior commit e26ea370071def3c97d0faa1ab381fe9efda7c96 fixed reversed lam-alef Unicode (`بلا`→`بال`) under DejaVu fallback, scoped to visits-report work-source cells. This failure involves Naskh, combining-mark placement and an inserted intra-word space in a patient-statement summary label. Both concern PDF Unicode extraction, but the prior scoped OpenType fix does not repair this reproducer; do not broaden it blindly.

Propose a separate narrowly reviewed print typography/runtime repair: first compare the tiny witness with the approved hosted browser/font stack, then test a deterministic, scoped font selection for statement monetary-summary labels (DejaVu is a diagnostic candidate). Preserve wording, DOM text, actual PDF labels/amounts, financial calculations and all existing assertions. Review rendered Arabic joining/diacritics, widths, wrapping and currency formatting. Require the complete active-agreement test through the additional payment and second PDF, plus basic multi-page statement, dated print and visits no-charge Unicode regression. Reject a repair that merely strips all spaces, loosens label matching, changes the expected string, suppresses the case, or masks missing content. No product repair is implemented in this evidence commit.
