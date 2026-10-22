# FIN-INT-4: an approved agreement funds the orthodontic case

Base: `5206ada2` (Draft PR #408). No migration, no schema change, no backfill.

## Finding (reproduced first)

The invoice or approved agreement is the financial foundation; installments are
only a collection schedule. `ORTHO_CASE_FUNDED_SQL` still required
`plan_installments` on the linked plan. A new orthodontic case linked to a plan
whose full principal was explicitly approved (0064, one invoice for the full
principal) but which had no schedule was therefore classified
`OUTSIDE_CONTRACT`. Each adjustment asked for a billing decision ("خارج العقد —
قرار فوترة") although the treatment was already invoiced. Linking reported
`funded: false`. The ortho agreement panel offered only installment plans for
linking and described the approved plan as "الخطة بلا أقساط".

The red run on the unchanged base: `expected 'OUTSIDE_CONTRACT' to be 'INCLUDED'`
and `funded: false`, in `__tests__/postgres/ortho-approved-agreement-funding.test.ts`.

## Change

- `ORTHO_CASE_FUNDED_SQL` accepts installments OR an approved principal of the
  same patient on the linked, non-cancelled plan. This is the same condition as
  `PLAN_FUNDED_BY_AGREEMENT_SQL`, which the plan-session coverage already uses.
  An invoice reference on a plan item alone still does not fund adjustments.
- The plan listing exposes the money-free boolean `agreementApproved`, including
  the masked doctor projection and the restricted finance projection. No amount is
  exposed by it.
- `OrthoPackageLink` treats an approved plan as the agreement: it is offered for
  linking and shown as "✓ اتفاق معتمد بكامل الأصل". The installment wording is
  unchanged. A cancelled plan neither funds nor is offered.

## Preserved

- An unapproved plan without a schedule still does not fund.
- The installment package behaves as before.
- Another patient's plan is refused at write time.
- The signed adjustment keeps its frozen class.
- Signing adds no invoice and no dues.

## Not connected / remaining

- A prebilled ortho plan-item invoice without approval does not fund adjustments.
  This needs an owner decision on whether a single invoiced ortho item represents
  the whole treatment.
- The legacy-onboarding "plan" step label still says "اتفاق أقساط" for the legacy
  installments mode.
