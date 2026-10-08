/** Shared read-only evidence projection. Only the 0043-enabled legacy composition imports this module. */
export const LEGACY_ITEM_COVERAGE_CONTEXT_SQL = `(
  SELECT jsonb_build_object(
    'agreementId', la.id, 'serviceId', la.service_id, 'anchorToothCode', la.tooth_code,
    'agreementCount', (SELECT COUNT(*) FROM legacy_treatment_agreements all_history WHERE all_history.plan_item_id = i.id),
    'snapshot', to_jsonb(cs))
  FROM legacy_treatment_agreements la
  LEFT JOIN legacy_treatment_coverage_snapshots cs ON cs.agreement_id = la.id
  WHERE la.plan_item_id = i.id ORDER BY la.id DESC LIMIT 1
)`;
