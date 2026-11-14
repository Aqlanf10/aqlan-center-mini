---
version: alpha
colors:
  primary: "#057bdc"
  bright: "#079bf5"
  dark: "#0a4788"
  text: "#143f68"
  accent: "#ff8b2b"
  canvas: "#f3f9ff"
  border: "#dcebf7"
typography:
  sans:
    fontFamily: "var(--font-arabic), sans-serif"
rounded:
  card: "10px"
  control: "7px"
spacing:
  panel: "18px"
  gap: "10px"
components:
  InventoryPanel:
    border: "1px solid #dcebf7"
---

## Overview

Inventory product surfaces are operational clinic documents. Use the approved blue/white identity and compact, readable evidence cards. The primary signature is the ordered request→approval→order→receipt→match document chain, with orange reserved for the next decision or unresolved inspection. No decorative dental imagery in quantity or cost tables.

Root owns global design/chrome. This scoped contract records inventory implementation only and deliberately does not introduce a competing root DESIGN.md or change the sidebar. Canonical clinic logo/print identity comes from ReportPrintHeader and SettingsProvider. Existing session and money policies remain authoritative. The explicit user scope and the 499-line inventory attachment govern business behavior.

The Library HTML reference could be resolved but not transferred (9,060,349 bytes; transfer download failure and text read Transport closed). Root supplied an authoritative comparison checkout: `4538f57bb0171ee8d4b9428316633b331e024c0b`, docs/ux/PATIENT_PREMIUM_PHASE1_REVIEW.md and its summary/account reference PNGs. Both images were extracted by git show and visually inspected. They show thin pale-blue borders, white 10px cards, compact blue headings, blue line icons, pale blue canvas and restrained orange actions. The shared sidebar/footer remains outside this inventory scope. This reference is not a claim that that branch has final visual acceptance.

## Colors

Runtime source is components/inventory/inventory.module.css. CSS variables there hold all approved inventory tokens; consumers use module classes. Dark blue owns high-contrast body/actions; bright blue is restrained decoration. Cost completeness uses text labels as well as semantic colors. Missing prices never use green zero-value presentation.

## Typography

Reuse the locally bundled IBM Plex Arabic font through --font-arabic. Headings 19–22px, card titles 14px, supporting labels 12px. Arabic is primary; English changes direction and owned copy. Native money remains explicitly YER/SAR/USD.

## Layout

Use natural document scrolling. Desktop summaries use equal metric columns; data panels use two columns, stacking at 640px. Phone target 390px; desktop 1280px. List navigation belongs inside the panel, not global shell. Print outputs the complete selected report scope and clinic identity.

## Elevation & Depth

White surfaces with pale borders; avoid floating decorative shadows and excessive card nesting.

## Shapes

Cards 10px; controls 7px. Orange underline identifies the primary action without relying on color alone.

## Components

Reuse native buttons/links, existing ReportPrintHeader, SessionProvider and JSON-body guards. Inventory-specific read states are loading/ready/unavailable/denied. A stale or denied report is withdrawn and print disabled. No native alert/confirm/prompt. Controlled document mutations require exact revision and idempotency keys.

## Do's and Don'ts

Keep quantity/debt/cash effects distinct. Preserve clinic stock during doctor transfers. Show missing/estimated cost states. Do not fabricate figures or create patient consumption from unexplained package differences. Sharp/contaminated items are disposed safely; never request return or waste retrieval. No automatic wage deduction or disciplinary debt.

## Reference setup workspace

The first-use setup page uses a restrained enterprise workspace inside the existing
clinic shell: a compact command bar, leading-side section navigation, a searchable
reference table and a contextual inline editor. The established inventory variables
in `components/inventory/inventory.module.css` remain the token owner; scoped
`reference-setup.module.css` adds layout only. IBM Plex Arabic, clinic logo, blue
structure and orange next-action accents remain unchanged. Phone layout stacks the
workspace without imposing a fixed shell height.

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
|---|---|---|---|---|
| Select/Listbox | Native select in InventoryReferenceSetup | Existing inventory forms and this contract | OS-owned popup, app-owned labels | Keyboard/open-popup component check; operational check blocked on canonical authority |
| Form | InventoryReferenceSetup contextual editor | ReferenceInput and reference-validation | Item, package, location, limit | Validation tests; explicit saved draft and pending command states |
| CRUD | Reference setup service and existing inventory lifecycle | Immutable versions, central authorization seam | Create and append revision only | Synthetic-authority PG tests; no claim of operational authorization |
| Toast | Existing inventory inline status/alert regions | Confirmed acknowledgement only | Status, refusal, uncertain | Exact result identity/digest checks |
| Scrollbar | Existing app/browser document and native overflow | Natural scrolling; no hidden scrollbar | Table overflow only | Narrow viewport check; no global scrollbar redesign in this slice |

Setup has no delete or opening-balance action. Package/base-unit history is fixed;
approval limits append revisions and cannot enable self-approval. Local drafts are
explicitly recoverable for seven days under the server-provided realm/subject;
pending commands are separate durable records with no automatic expiry. Neither
403/409 nor a changed generation clears them. A readiness observation shows its
timestamp and unavailable counts distinctly and never exposes an activation button.

The canonical authority adapter is currently unbound and production setup is closed.
Injected synthetic-authority tests prove core contracts only. Historical lookup
also remains held if original numeric actor/username remapped: the existing journal
uses those exact original keys, and no identity rewriting or inferred restore
continuity is supported. Open-flow browser acceptance requires the central adapter.
