// Exact runtime mirror; never rewrite historical completion witnesses.
export const CEPH_COMPLETION_SOURCE_CAS_SQL = `-- Expand the witness envelope only. Historical v1 rows and their immutable
-- signatures remain unchanged; source-CAS completion writes v2 evidence.
ALTER TABLE ceph_completion_provenance
  DROP CONSTRAINT ceph_completion_provenance_schema_version_check,
  ADD CONSTRAINT ceph_completion_provenance_schema_version_check CHECK(schema_version IN (1,2));
`;
