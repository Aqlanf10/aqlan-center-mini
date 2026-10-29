/** Additive structured lab shades; legacy global shade columns are unchanged. */
export const LAB_SHADE_SPECIFICATION_SQL = String.raw`ALTER TABLE lab_orders ADD COLUMN IF NOT EXISTS shade_specification JSONB;
CREATE OR REPLACE FUNCTION aqlan_valid_lab_shade_specification(spec JSONB) RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE tooth JSONB; zone JSONB; code INTEGER; seen INTEGER[] := '{}'; zone_name TEXT;
BEGIN
 IF spec IS NULL THEN RETURN TRUE; END IF;
 IF jsonb_typeof(spec)<>'object' OR spec->'version'<>'1'::jsonb OR jsonb_typeof(spec->'teeth')<>'array'
    OR NOT(spec ?& ARRAY['version','teeth']) OR (SELECT count(*) FROM jsonb_object_keys(spec))<>2 THEN RETURN FALSE; END IF;
 IF jsonb_array_length(spec->'teeth')>52 OR octet_length(spec::text)>32768 THEN RETURN FALSE; END IF;
 FOR tooth IN SELECT value FROM jsonb_array_elements(spec->'teeth') LOOP
  IF jsonb_typeof(tooth)<>'object' OR NOT(tooth ?& ARRAY['toothCode','cervical','body','incisal'])
     OR (SELECT count(*) FROM jsonb_object_keys(tooth))<>4 OR jsonb_typeof(tooth->'toothCode')<>'number' THEN RETURN FALSE; END IF;
  IF (tooth->>'toothCode') !~ '^[1-8][1-8]$' THEN RETURN FALSE; END IF;
  code := (tooth->>'toothCode')::integer;
  IF (code/10>4 AND code%10>5) OR code=ANY(seen) THEN RETURN FALSE; END IF;
  seen := array_append(seen,code);
  FOREACH zone_name IN ARRAY ARRAY['cervical','body','incisal'] LOOP
   zone := tooth->zone_name;
   IF zone='null'::jsonb THEN CONTINUE; END IF;
   IF jsonb_typeof(zone)<>'object' OR NOT(zone ?& ARRAY['guide','code'])
      OR (SELECT count(*) FROM jsonb_object_keys(zone))<>2 OR jsonb_typeof(zone->'code')<>'string' THEN RETURN FALSE; END IF;
   IF zone->>'guide'='vita_classical' THEN
    IF NOT(zone->>'code'=ANY(ARRAY['A1','A2','A3','A3.5','A4','B1','B2','B3','B4','C1','C2','C3','C4','D2','D3','D4'])) THEN RETURN FALSE; END IF;
   ELSIF zone->>'guide'='vita_3d_master' THEN
    IF NOT(zone->>'code'=ANY(ARRAY['0M1','0M2','0M3','1M1','1M2','2L1.5','2L2.5','2M1','2M2','2M3','2R1.5','2R2.5','3L1.5','3L2.5','3M1','3M2','3M3','3R1.5','3R2.5','4L1.5','4L2.5','4M1','4M2','4M3','4R1.5','4R2.5','5M1','5M2','5M3'])) THEN RETURN FALSE; END IF;
   ELSE RETURN FALSE;
   END IF;
  END LOOP;
 END LOOP;
 RETURN TRUE;
EXCEPTION WHEN OTHERS THEN RETURN FALSE;
END $$;
ALTER TABLE lab_orders ADD CONSTRAINT lab_orders_shade_specification_valid CHECK (aqlan_valid_lab_shade_specification(shade_specification));
`;
