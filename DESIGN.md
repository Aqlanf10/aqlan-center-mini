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

## Login reference integration (2026-10-28)

The owner supplied a complete login-page TSX reference. Its two-panel identity/form composition is retained, but the owner explicitly required official center colors. All reference-specific hex values are replaced by canonical `tailwind.config.ts` tokens: navy-900 (#0d2137), navy-800 (#1a3a5c), navy-950 (#081625), brand-orange (#f5922e), and canvas (#f2f6fb). This is not a global token migration. The existing IBM Plex Arabic, configured clinic/doctor names, `Logo` and `InstallApp` remain canonical. A nonexistent doctor photograph is replaced by the existing white logo; no external asset or invented identity is added. Mobile retains natural document scrolling and wraps header actions.

The existing `/api/auth/login` and SessionProvider own authentication. The form preserves IDs, autofill, password paste and HttpOnly server-session boundaries. Password visibility is keyboard-accessible; help is a disclosure, not a password-reset workflow. Only the username may be persisted after explicit opt-in and confirmed login; unchecking removes it immediately. Browser offline status is advisory, never proof of server reachability and never a reason to prevent a real login request. Rate-limit text promises no invented retry interval.

Component interaction tests cover auth/storage/keyboard contracts. Responsive visual verification remains a separate real-browser gate; static or hook tests are not visual acceptance.

### Optional owner-configured login photograph

The owner uploads a JPEG/PNG from Settings → clinic identity, never by committing a personal photo to source control. A replacement is saved hidden; publishing requires the explicit “إظهار الصورة للزوار” action. Hiding retains the immutable file and backups. The settings card explains that publication is public before login and original embedded metadata is not stripped. Original clinic colors and the existing logo fallback remain unchanged.

Only the fixed public image endpoint can expose the currently configured, visible, verified asset. Metadata is private, paths are content-derived in a reserved namespace, and upload/visibility mutations require branding permission and both current version stamps. Settings and audit records commit in one transaction. Invalid, missing or hidden images return no-store 404; clients fall back to the clinic logo. Byte checks bound size, dimensions, PNG chunks and JPEG markers/scans; they are not a full pixel decoder or re-encoding claim. Replaced/orphan files are not deleted. Full backups retain the configured asset even when hidden and validate it against the same database snapshot before restore activation.
