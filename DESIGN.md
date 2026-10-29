---
version: alpha
colors:
  navy: "#0d2137"
  primary: "#1a3a5c"
  accent: "#f5922e"
  canvas: "#f2f6fb"
  warning: "#78350f"
  success: "#047857"
typography:
  sans:
    fontFamily: "var(--font-arabic), system-ui, sans-serif"
rounded:
  card: "1rem"
  control: "0.75rem"
omitted:
  - section: spacing
    reason: "Existing Tailwind spacing utilities remain canonical; no feature-specific spacing scale."
  - section: components
    reason: "Existing application components own behavior and styling; this document does not generate replacements."
---

# Aqlan Center Mini

## Overview

Aqlan Center Mini is the existing Arabic, right-to-left clinic operating application. Its interface is a compact reception and clinical work surface, not a marketing site. Preserve the full clinic identity configured in `lib/settings.ts`, the local Arabic font, and the navy/orange visual language. Do not substitute a generic dashboard theme or introduce AI/Dot features.

This is a bounded record of the existing design, established while adding explicit planned-session rebooking. It does not authorize a redesign or claim application-wide accessibility certification.

## Colors

`tailwind.config.ts` is the runtime source of truth. The frontmatter records its existing navy-900, navy-800, brand-orange, canvas, warning-900, and success-700 values; it does not generate tokens. Navy carries structure, orange is the established primary clinic action, amber explains recoverable uncertainty, and green acknowledges confirmed completion. Status text must explain the meaning independently of color.

## Typography

`app/layout.tsx` loads the existing IBM Plex Arabic font files through `--font-arabic`; `app/globals.css` provides tabular numerals. Retain one Arabic family with stronger weights for labels and actions. Keep Arabic copy concise and preserve readable wrapping instead of truncating appointment history or refusal reasons.

## Layout

Keep the Summary tab's current identity/intake, warnings, current-work cards, planned-session list, and role-gated financial sections in their established order. Rebooking expands inside the existing session row. Date/time controls wrap on narrow screens; the reason occupies its own full-width row. Do not add fixed viewport heights, new scroll containers, financial controls, or a second scheduling surface.

## Elevation & Depth

Retain existing flat bordered Summary surfaces and the shared card/raised shadows only where already used. Rebooking requires no new overlay or animation.

## Shapes

Reuse the existing rounded-2xl cards, rounded-xl action surfaces, and rounded-lg inputs. Global focus-visible styling remains owned by `app/globals.css`.

## Components

The existing `components/patient/SummaryTab.tsx` owns the inline date/time scheduling form; explicit rebooking is a business variant of that same form, not a second editor. Native date/time pickers retain browser/OS popup geometry and locale behavior. Application labels, date-only values, validation, and clinic-timezone calculations remain app-owned through `lib/schedule.ts` and the workflow response's `timeZone`.

`lib/http-permissions.ts`, `lib/referrals.ts`, the server eligibility projection, and the rebook endpoint own authorization. The UI cannot grant a capability. A terminal no-show/cancelled appointment must not offer Start. Rebooking preserves the original appointment/history, requires a reason, and refreshes the Summary only after a confirmed server result. It never creates a receipt or payment.

The existing Summary inline feedback region remains the local feedback owner. Rebooking errors stay beside the form with an accessible alert; success uses a status region. Unknown results lock fields and cancellation, retain the exact request body/identity, and permit only an identical retry or explicit full-file refresh. Synchronous in-flight guards prevent duplicate sends.

## Do's and Don'ts

- Preserve the canonical clinic name, Arabic/RTL layout, existing tokens, and financial boundaries.
- Keep server refusal reasons visible; retain user input for correction after a definite rejection.
- Reuse clinic calendar helpers, not workstation-local date arithmetic.
- Never describe an uncertain request as a failed or successful booking.
- Do not clear historical no-show/cancelled status, silently reschedule it, or start a visit from it.
- Verify changes with the Summary SSR and rebooking hook tests. Browser checks are a separate release activity; static checks do not prove responsive layout or native picker behavior.

## Leadership operational overview

`components/leadership/LeadershipOperationalOverview.tsx` extends the existing executive page with a read-only panel, not another Today workflow. Source filters are labeled Appointments and Referrals; they never imply assignment. Status, a patient link, exact cohort totals, source freshness and unknown/error states remain visible. Scope/ownership explanations live in one native disclosure; individual rebooking evidence is optionally expandable.

The existing native date control remains browser/OS-owned here as in the executive period and Summary controls. The app owns its visible label, ISO clinic-day value and validation. Native `details`/`summary` owns disclosure keyboard and expanded-state semantics. Preserve existing clinic typography, colors, focus styling and natural page flow. Narrow-screen browser acceptance remains a separate hosted gate.

## Leadership hub composition

The owner delegated expert design selection and requested professional cards. The leadership route now uses a restrained Fluent-inspired composition within the unchanged clinic shell: compact source-backed cards, clear evidence lists and original-record drilldowns. Existing clinic navy and IBM Plex Arabic remain canonical. The scoped teal accent (`#0f766e`, pale surface `#f0fdfa`) is owned by `components/leadership/leadership.module.css`; it identifies navigation/read state, never an unproved successful outcome. There is no global palette replacement or external font/dependency.

The four headline cards contain real distinct measures; waiting is visibly a subset of unfinished visits. Unknown sources use a dash plus an explicit error, not zero. On narrow screens cards recompose to two columns and evidence rows wrap with labels. Lower-priority finance, attendance, inventory and detailed cohort panels are loaded on request; they are not big empty cards. All original read, currency, permission and date meanings remain in `docs/LEADERSHIP_HUB_SOURCE_MAP.md`. Native date controls and local section/day state follow the existing executive contract; patient data is never stored in query filters or browser storage.

The leadership financial surface uses four local read views: cash movement, invoices/expenses, debts and period operations. Native-currency amount cards are the sole default value presentation; category breakdowns and current non-period facts are progressive detail. Laboratory record cards and operational source panels share the same restrained panel, button, status and spacing family. Current party balances must never inherit the period-end receivables label. This is presentation over existing readers, not a second ledger or new workflow.

## Unified printed documents

The owner's approved installment contract is the print reference, not an invitation to redesign clinical graphics. `components/PrintHeader.tsx` owns the configured clinic identity and contact footer; `ReportPrintHeader.tsx` is its client adapter. The approved agreement layout, six columns and three paired identity rows remain the reference. The owner later requested a fixed-size page-centered watermark instead of sizing it from the installment table; opacity remains 15%.

`components/PrintDocument.tsx` and `components/print-document.css` own reusable paired RTL metadata, table pagination and decorative screen fallbacks. Layout is compact, white, with the existing official navy/orange logo and pale slate metadata border. Preserve existing paper-family intent, operator-selected A6/A5 paper, and individual numeric typography; never shrink the whole document to one page. Wide reports use their documented landscape variant. Repeated column headings and natural row breaks carry long documents; monetary totals print once. Footers are in normal flow, not overlays. English inventory retains its content direction. Non-table inventory record lists retain their existing structure instead of inventing another financial projection.

Only a selected report modal prints; its CSS isolation is conditional on that modal and must not hide another route's header. Application controls, private offscreen records, and modal siblings do not print. `PrintButton` audit/reprint behavior, source readers, permissions, date/currency arithmetic, report view selection, and lab external-DTO identity policy are unchanged. Signed/archived bytes, saved consent terms/signatures, anatomical charts and cephalometric graphics are not rewritten. Styled SpreadsheetML exports share brand palette only; typed cells, escaping, row order and values are invariant, and raw CSV/data-only exports are unchanged.

Coverage and verification are recorded in `docs/UNIFIED_PRINT_IDENTITY.md`. Synthetic HTML/WeasyPrint evidence is independent document-renderer evidence, never browser acceptance. Hosted Chromium PDF tests and Staging print-dialog acceptance remain distinct release gates.
# Print watermark coverage correction (2026-10-29)

The owner requires the translucent logo on all printed documents, including plain forms and continuation pages. `PrintDocumentWatermark` has exactly one owner at the app body boundary. It uses the existing official image at 15% opacity, is print-only, repeats per physical page, and suppresses ordinary table marks to prevent duplicates. Ordinary and saved agreements use that same fixed 76 × 65 mm page frame, independent of row count; their old table decoration is suppressed in print. This supersedes only the prior logo-sizing anchor, not agreement data or layout. A6/A5 keep operator-selected paper and logical compact-sheet positioning. QR quiet zones, actual stored signature images and clinical geometry stay in opaque protected foreground regions; empty signature rows stay transparent. Missing images are removed without invented branding. Machine exports and immutable uploaded files are excluded; legacy SpreadsheetML has no image-watermark support.
