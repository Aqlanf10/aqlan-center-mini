---
name: clinic-leadership
description: Design, implement and verify Aqlan Center's Arabic RTL leadership workspace using the clinic's existing read contracts. Apply to leadership cards, operational review, laboratory follow-up, finance and staff oversight; not to new business workflows or permission policy.
---

# Clinic leadership

Build an original, coherent clinic management surface: concise overview, evidence-backed attention list, then the original working record. Use restrained navy/teal, the existing Arabic font, calm borders and aligned spacing. Fluent is an interaction/hierarchy reference, not a brand to copy. Finance, laboratory and operational sections must share the same visual language rather than appear as embedded legacy pages.

## Read the relevant contracts

- `DESIGN.md`: tokens, canonical navigation, typography and date-input ownership.
- `docs/LEADERSHIP_HUB_SOURCE_MAP.md`: source coverage, component ownership and unsupported claims.
- `LEADERSHIP_OPERATIONS.md`, `lib/leadership-operations.ts`, `lib/lab-backlog.ts`: cohort versus all-open scopes, records and read decoders.
- `lib/executive.ts`, `lib/db.ts:executiveKpis`, `lib/journal-read-integrity.ts`: financial definitions and integrity failures.
- `lib/http-permissions.ts`, source route authorization and HR task visibility: current principal and disclosure boundaries.

Inspect verified readers and tests before changing presentation. A visual redesign does not authorize changing financial math, schema, source scope, roles or clinic procedures.

## Decisions that must remain true

- Distinguish selected arrival/event day, all-date open backlog, financial period, cumulative receivables and current party balances. Show source-specific read timestamps; do not invent a global atomic snapshot.
- Keep every money amount in its source currency. Cash movement is neither drawer balance nor profit. Never sum currencies or allocate unlinked payments by guesswork.
- Separate assigned staff, treating doctor and latest actor/action/time. Show saved due dates; missing due is not overdue. A task or lab delay invites review, not an accusation against staff, laboratory or patient.
- Link only to actual canonical destinations. Opening a record is not resolution; task completion is not clinical completion. Suggested next review steps must not look like recorded commitments.
- Source failure, missing evidence and future arrival times are unknown, not zero. Clear superseded responses and sensitive data on session/principal change; enforce authorization on the server.
- Preserve HR private-task visibility in both rows and counts. Never substitute a capped recent list for an exact global total.

## Presentation and performance

Give each card one question, a prominent truthful value, concise scope/status, and a real route or section action. Do not repeat the same metric in both a hero card and a default table. Use progressive detail for category breakdowns and secondary operational history. Empty sources get compact explanations, not large empty cards. Controls are semantic, labelled, keyboard reachable, visibly focused and usable at narrow widths; color never carries meaning alone.

Keep the existing AppShell and source workflows. Load only bounded overview readers at entry. Open finance, attendance, inventory and detailed review on demand; avoid polling, per-doctor fan-out, N+1 enrichment or cross-request financial caches. Default Today re-resolves clinic day on refresh; explicit date selection/paging retains that cohort until Today is selected again.

## Implementation and acceptance checklist

- [ ] Verify each visible metric, scope, action and ownership label against a named source.
- [ ] Apply the same card/panel/control hierarchy to overview, finance, laboratory and review sections.
- [ ] Test currency separation, cash/debt/date distinctions and integrity-refusal clearing after presentation edits.
- [ ] Test role denial, private-task visibility, stale replies, timeout, unknown/empty states and date independence.
- [ ] Measure query count and latency on a larger synthetic fixture; count initial requests and verify deferred sources are absent.
- [ ] Run the repository environment check, targeted tests, typecheck, lint, build and scoped UI audit without weakening gates.
- [ ] Review rendered desktop and narrow RTL screenshots for populated, empty and error states; exercise keyboard, reduced motion and reflow. Record browser first paint/layout shifts separately from database timings.
- [ ] State unexecuted gates and unsupported features plainly. A build or static audit is not visual acceptance. Release only under the repository's authorized review/deployment process.

Use synthetic data for evidence. Keep credentials, patient records and private operational material out of screenshots, fixtures and this skill. This project-local guide changes no global assistant settings and grants no new deployment or database authority.
