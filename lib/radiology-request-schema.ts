/** Exact numbered migration; do not edit independently of the SQL file. */
export const RADIOLOGY_REQUEST_SQL = String.raw`CREATE FUNCTION aqlan_radiology_snapshot_valid(s JSONB, patient INTEGER, visit INTEGER, doctor INTEGER) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT (jsonb_typeof(s)='object'
    AND s->'version'='1'::jsonb
    AND s->'patientId'=to_jsonb(patient)
    AND s->'visitId'=COALESCE(to_jsonb(visit),'null'::jsonb)
    AND s->'doctorId'=to_jsonb(doctor)
    AND jsonb_typeof(s->'centerId')='string'
    AND length(s->>'centerId')<=36
    AND length(btrim(s->>'centerId'))>0
    AND jsonb_typeof(s->'examination')='string'
    AND length(s->>'examination')<=200
    AND length(btrim(s->>'examination'))>0
    AND jsonb_typeof(s->'region')='string'
    AND length(s->>'region')<=200
    AND length(btrim(s->>'region'))>0
    AND jsonb_typeof(s->'notes')='string'
    AND length(s->>'notes')<=2000
    AND jsonb_typeof(s->'patientName')='string'
    AND length(s->>'patientName')<=500
    AND length(btrim(s->>'patientName'))>0
    AND jsonb_typeof(s->'doctorName')='string'
    AND length(s->>'doctorName')<=500
    AND length(btrim(s->>'doctorName'))>0
    AND jsonb_typeof(s->'centerName')='string'
    AND length(s->>'centerName')<=160
    AND length(btrim(s->>'centerName'))>0
    AND jsonb_typeof(s->'centerAddress')='string'
    AND length(s->>'centerAddress')<=400
    AND length(btrim(s->>'centerAddress'))>0
    AND jsonb_typeof(s->'clinicName')='string'
    AND length(s->>'clinicName')<=500
    AND length(btrim(s->>'clinicName'))>0
    AND jsonb_typeof(s->'clinicAddress')='string'
    AND length(s->>'clinicAddress')<=2000
    AND jsonb_typeof(s->'clinicPhone')='string'
    AND length(s->>'clinicPhone')<=200
    AND jsonb_typeof(s->'timeZone')='string'
    AND length(s->>'timeZone')<=100
    AND length(btrim(s->>'timeZone'))>0
    AND (s->>'centerId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND octet_length(s::text)<=32768) IS TRUE
$$;
-- Issued requests are immutable command receipts and clinical snapshots.
CREATE TABLE radiology_requests (
  command_key UUID PRIMARY KEY,
  actor_user_id INTEGER NOT NULL CHECK (actor_user_id > 0),
  actor_username TEXT NOT NULL CHECK (length(actor_username) BETWEEN 1 AND 200),
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  visit_id INTEGER REFERENCES visits(id) ON DELETE RESTRICT,
  doctor_party_id INTEGER NOT NULL REFERENCES parties(id) ON DELETE RESTRICT,
  payload_sha256 CHAR(64) NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  snapshot JSONB NOT NULL CHECK (jsonb_typeof(snapshot) = 'object' AND octet_length(snapshot::text) <= 32768),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT radiology_snapshot_valid CHECK (aqlan_radiology_snapshot_valid(snapshot,patient_id,visit_id,doctor_party_id))
);
CREATE INDEX radiology_requests_patient_history ON radiology_requests(patient_id, created_at DESC, command_key DESC);
CREATE FUNCTION aqlan_radiology_request_immutable() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'RADIOLOGY_REQUEST_HISTORY_RETAINED' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER radiology_request_immutable BEFORE UPDATE OR DELETE ON radiology_requests
FOR EACH ROW EXECUTE FUNCTION aqlan_radiology_request_immutable();
CREATE FUNCTION aqlan_radiology_request_truncate() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.radiology_requests) THEN
    RAISE EXCEPTION 'RADIOLOGY_REQUEST_HISTORY_RETAINED' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER radiology_request_truncate BEFORE TRUNCATE ON radiology_requests
FOR EACH STATEMENT EXECUTE FUNCTION aqlan_radiology_request_truncate();
`;
