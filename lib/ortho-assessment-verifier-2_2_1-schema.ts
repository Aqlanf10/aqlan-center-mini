/** Byte-identical to forward migration0110. Preserve0052 and0106. */
export const ORTHO_ASSESSMENT_VERIFIER_2_2_1_SQL = `-- Forward-only decimal-domain verifier admission. Published0052 and0106 are unchanged.
-- No result recomputation, patient backfill, diagnosis, plan or financial write.
CREATE OR REPLACE FUNCTION check_ortho_assessment_revision_final_state() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_revision ortho_assessment_revisions%ROWTYPE;
  predecessor ortho_assessment_revisions%ROWTYPE;
  current_patient INTEGER;
  bridge_patient INTEGER;
  bridge_ortho INTEGER;
  entry JSONB;
  selection JSONB;
  n INTEGER;
  analysis_ids TEXT[] := ARRAY[]::TEXT[];
  expected_tanaka_engine TEXT;
  expected_tanaka_formula TEXT;
  expected_tanaka_policy TEXT;
BEGIN
  SELECT * INTO current_revision FROM ortho_assessment_revisions WHERE id=NEW.id;
  SELECT patient_id INTO current_patient FROM ortho_cases WHERE id=current_revision.ortho_case_id;
  SELECT patient_id,ortho_case_id INTO bridge_patient,bridge_ortho FROM clinical_cases WHERE id=current_revision.clinical_case_id;
  IF current_patient IS DISTINCT FROM current_revision.patient_id OR bridge_patient IS DISTINCT FROM current_revision.patient_id OR bridge_ortho IS DISTINCT FROM current_revision.ortho_case_id THEN
    RAISE EXCEPTION 'Assessment owner and clinical bridge mismatch' USING ERRCODE='23514';
  END IF;
  IF current_revision.supersedes_revision_id IS NOT NULL THEN
    SELECT * INTO predecessor FROM ortho_assessment_revisions WHERE id=current_revision.supersedes_revision_id AND ortho_case_id=current_revision.ortho_case_id;
    IF NOT FOUND OR predecessor.version+1<>current_revision.version OR predecessor.clinical_case_id<>current_revision.clinical_case_id OR predecessor.schema_version>current_revision.schema_version THEN
      RAISE EXCEPTION 'Assessment lineage mismatch' USING ERRCODE='23514';
    END IF;
  END IF;
  -- Unknown existing schema1 rows are preserved. New application admission refuses
  -- them; this trigger does not guess their old clinical content structure.
  IF current_revision.schema_version=2 THEN
    IF current_revision.content->'schemaVersion' IS DISTINCT FROM '2'::jsonb
      OR COALESCE(current_revision.content->>'verifierVersion','') NOT IN ('ortho-assessment-payload-2.1.0','ortho-assessment-payload-2.2.0','ortho-assessment-payload-2.2.1')
      OR jsonb_typeof(current_revision.content->'draft') IS DISTINCT FROM 'object'
      OR current_revision.content->'draft'->'schemaVersion' IS DISTINCT FROM '2'::jsonb
      OR jsonb_typeof(current_revision.content->'results') IS DISTINCT FROM 'array'
      OR jsonb_typeof(current_revision.content->'draft'->'analyses') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'Assessment payload version mismatch' USING ERRCODE='23514';
    END IF;
    n:=jsonb_array_length(current_revision.content->'results');
    IF n>36 OR n<>jsonb_array_length(current_revision.content->'draft'->'analyses') THEN
      RAISE EXCEPTION 'Assessment result count mismatch' USING ERRCODE='23514';
    END IF;
    IF n>0 THEN FOR i IN 0..n-1 LOOP
      entry:=current_revision.content->'results'->i;
      selection:=current_revision.content->'draft'->'analyses'->i;
      IF jsonb_typeof(entry) IS DISTINCT FROM 'object' OR jsonb_typeof(entry->'result') IS DISTINCT FROM 'object'
        OR jsonb_typeof(selection) IS DISTINCT FROM 'object'
        OR jsonb_typeof(selection->'id') IS DISTINCT FROM 'string'
        OR COALESCE(selection->>'id','') !~ '^[A-Za-z0-9_-]{1,80}$'
        OR (selection->>'id')=ANY(analysis_ids)
        OR jsonb_typeof(entry->'analysisId') IS DISTINCT FROM 'string'
        OR entry->>'analysisId' IS DISTINCT FROM selection->>'id' OR selection->>'state' IS DISTINCT FROM 'draft'
        OR COALESCE(entry->>'resultHash','') !~ '^[a-f0-9]{64}$' THEN
        RAISE EXCEPTION 'Assessment result identity mismatch' USING ERRCODE='23514';
      END IF;
      IF selection->>'method'='tanaka_johnston_1974'
        AND COALESCE(current_revision.content->>'verifierVersion','') NOT IN ('ortho-assessment-payload-2.2.0','ortho-assessment-payload-2.2.1') THEN
        RAISE EXCEPTION 'Assessment method requires payload verifier2.2.0 or2.2.1' USING ERRCODE='23514';
      END IF;
      -- A stored verifier must identify the engine and admission policy that
      -- actually produced this witness. Relabelling must not strand readback.
      -- Historical incomplete/inapplicable results have no arithmetic witness.
      IF selection->>'method'='tanaka_johnston_1974' THEN
        IF current_revision.content->>'verifierVersion'='ortho-assessment-payload-2.2.1' THEN
          expected_tanaka_engine:='ortho-model-2.2.1';
          expected_tanaka_formula:='tanaka_johnston_1974_decimal_domain_v2';
          expected_tanaka_policy:='tanaka_whole_arch_mixed_decimal_v2';
        ELSE
          expected_tanaka_engine:='ortho-model-2.2.0';
          expected_tanaka_formula:='tanaka_johnston_1974_approximation_v1';
          expected_tanaka_policy:='tanaka_whole_arch_mixed_v1';
        END IF;
        IF entry->'result'->>'state'='ready' AND (
          entry->'result'->'witness'->'formula'->>'engineVersion' IS DISTINCT FROM expected_tanaka_engine
          OR entry->'result'->'witness'->'formula'->>'formulaVersion' IS DISTINCT FROM expected_tanaka_formula
          OR entry->'result'->'witness'->'reference'->>'policyVersion' IS DISTINCT FROM expected_tanaka_policy
          OR entry->'result'->'witness'->'result'->>'state' IS DISTINCT FROM 'calculated'
          OR entry->'result'->'witness'->'result'->>'method' IS DISTINCT FROM 'tanaka_johnston_1974_approximation_v1'
        ) THEN
          RAISE EXCEPTION 'Assessment Tanaka witness verifier mismatch' USING ERRCODE='23514';
        END IF;
        IF entry->'result'->>'state'='outside_supported_predictor_domain'
          AND entry->'result'->>'policyVersion' IS DISTINCT FROM expected_tanaka_policy THEN
          RAISE EXCEPTION 'Assessment Tanaka domain policy verifier mismatch' USING ERRCODE='23514';
        END IF;
      END IF;
      analysis_ids:=array_append(analysis_ids,selection->>'id');
    END LOOP; END IF;
  END IF;
  RETURN NEW;
END;
$$;
`;
