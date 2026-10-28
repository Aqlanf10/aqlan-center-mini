/** Pinned PostgreSQL18.6 v2 proposal descriptor; never adopted from a runtime database. */
function freeze(value){if(value&&typeof value==="object"){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
export const EXPECTED_RUNTIME_CATALOGUE=freeze({
  "relations": [
    {
      "relname": "parties",
      "relkind": "r",
      "relpersistence": "p",
      "relrowsecurity": false,
      "relforcerowsecurity": false
    },
    {
      "relname": "staff_authority_control",
      "relkind": "r",
      "relpersistence": "p",
      "relrowsecurity": false,
      "relforcerowsecurity": false
    },
    {
      "relname": "staff_identity_binding_events",
      "relkind": "r",
      "relpersistence": "p",
      "relrowsecurity": false,
      "relforcerowsecurity": false
    },
    {
      "relname": "staff_identity_current",
      "relkind": "r",
      "relpersistence": "p",
      "relrowsecurity": false,
      "relforcerowsecurity": false
    },
    {
      "relname": "staff_identity_generations",
      "relkind": "r",
      "relpersistence": "p",
      "relrowsecurity": false,
      "relforcerowsecurity": false
    },
    {
      "relname": "staff_identity_state",
      "relkind": "r",
      "relpersistence": "p",
      "relrowsecurity": false,
      "relforcerowsecurity": false
    },
    {
      "relname": "staff_identity_subjects",
      "relkind": "r",
      "relpersistence": "p",
      "relrowsecurity": false,
      "relforcerowsecurity": false
    },
    {
      "relname": "users",
      "relkind": "r",
      "relpersistence": "p",
      "relrowsecurity": false,
      "relforcerowsecurity": false
    }
  ],
  "columns": [
    {
      "relname": "parties",
      "attname": "clinical_authority_epoch",
      "type": "bigint",
      "attnotnull": true,
      "attidentity": "",
      "attgenerated": "",
      "default_value": "1"
    },
    {
      "relname": "parties",
      "attname": "id",
      "type": "integer",
      "attnotnull": true,
      "attidentity": "",
      "attgenerated": "",
      "default_value": "nextval('parties_id_seq'::regclass)"
    },
    {
      "relname": "staff_authority_control",
      "attname": "activated_at",
      "type": "timestamp with time zone",
      "attnotnull": false,
      "attidentity": "",
      "attgenerated": "",
      "default_value": null
    },
    {
      "relname": "staff_authority_control",
      "attname": "binding_epoch",
      "type": "bigint",
      "attnotnull": true,
      "attidentity": "",
      "attgenerated": "",
      "default_value": "1"
    },
    {
      "relname": "staff_authority_control",
      "attname": "conversion_digest",
      "type": "text",
      "attnotnull": false,
      "attidentity": "",
      "attgenerated": "",
      "default_value": null
    },
    {
      "relname": "staff_authority_control",
      "attname": "owner_user_id",
      "type": "integer",
      "attnotnull": false,
      "attidentity": "",
      "attgenerated": "",
      "default_value": null
    },
    {
      "relname": "staff_authority_control",
      "attname": "pending_owner_user_id",
      "type": "integer",
      "attnotnull": false,
      "attidentity": "",
      "attgenerated": "",
      "default_value": null
    },
    {
      "relname": "staff_authority_control",
      "attname": "prepared_at",
      "type": "timestamp with time zone",
      "attnotnull": false,
      "attidentity": "",
      "attgenerated": "",
      "default_value": null
    },
    {
      "relname": "staff_authority_control",
      "attname": "realm_id",
      "type": "text",
      "attnotnull": true,
      "attidentity": "",
      "attgenerated": "",
      "default_value": "(gen_random_uuid())::text"
    },
    {
      "relname": "staff_authority_control",
      "attname": "recovery_reference",
      "type": "text",
      "attnotnull": false,
      "attidentity": "",
      "attgenerated": "",
      "default_value": null
    },
    {
      "relname": "staff_authority_control",
      "attname": "singleton",
      "type": "boolean",
      "attnotnull": true,
      "attidentity": "",
      "attgenerated": "",
      "default_value": "true"
    },
    {
      "relname": "staff_authority_control",
      "attname": "state",
      "type": "text",
      "attnotnull": true,
      "attidentity": "",
      "attgenerated": "",
      "default_value": "'unbound'::text"
    },
    {
      "relname": "staff_identity_binding_events",
      "attname": "generation_id",
      "type": "uuid",
      "attnotnull": true,
      "attidentity": "",
      "attgenerated": "",
      "default_value": null
    },
    {
      "relname": "staff_identity_binding_events",
      "attname": "new_subject_id",
      "type": "uuid",
      "attnotnull": false,
      "attidentity": "",
      "attgenerated": "",
      "default_value": null
    },
    {
      "relname": "staff_identity_binding_events",
      "attname": "previous_subject_id",
      "type": "uuid",
      "attnotnull": false,
      "attidentity": "",
      "attgenerated": "",
      "default_value": null
    },
    {
      "relname": "staff_identity_binding_events",
      "attname": "registry_revision",
      "type": "bigint",
      "attnotnull": true,
      "attidentity": "",
      "attgenerated": "",
      "default_value": null
    },
    {
      "relname": "staff_identity_binding_events",
      "attname": "user_id",
      "type": "integer",
      "attnotnull": true,
      "attidentity": "",
      "attgenerated": "",
      "default_value": null
    },
    {
      "relname": "staff_identity_current",
      "attname": "bound_registry_revision",
      "type": "bigint",
      "attnotnull": true,
      "attidentity": "",
      "attgenerated": "",
      "default_value": null
    },
    {
      "relname": "staff_identity_current",
      "attname": "subject_id",
      "type": "uuid",
      "attnotnull": true,
      "attidentity": "",
      "attgenerated": "",
      "default_value": null
    },
    {
      "relname": "staff_identity_current",
      "attname": "user_id",
      "type": "integer",
      "attnotnull": true,
      "attidentity": "",
      "attgenerated": "",
      "default_value": null
    },
    {
      "relname": "staff_identity_generations",
      "attname": "generation_id",
      "type": "uuid",
      "attnotnull": true,
      "attidentity": "",
      "attgenerated": "",
      "default_value": null
    },
    {
      "relname": "staff_identity_generations",
      "attname": "previous_generation_id",
      "type": "uuid",
      "attnotnull": false,
      "attidentity": "",
      "attgenerated": "",
      "default_value": null
    },
    {
      "relname": "staff_identity_generations",
      "attname": "realm_id",
      "type": "uuid",
      "attnotnull": true,
      "attidentity": "",
      "attgenerated": "",
      "default_value": null
    },
    {
      "relname": "staff_identity_generations",
      "attname": "reason",
      "type": "text",
      "attnotnull": true,
      "attidentity": "",
      "attgenerated": "",
      "default_value": null
    },
    {
      "relname": "staff_identity_state",
      "attname": "generation_id",
      "type": "uuid",
      "attnotnull": true,
      "attidentity": "",
      "attgenerated": "",
      "default_value": null
    },
    {
      "relname": "staff_identity_state",
      "attname": "ready_control_epoch",
      "type": "bigint",
      "attnotnull": false,
      "attidentity": "",
      "attgenerated": "",
      "default_value": null
    },
    {
      "relname": "staff_identity_state",
      "attname": "ready_owner_subject_id",
      "type": "uuid",
      "attnotnull": false,
      "attidentity": "",
      "attgenerated": "",
      "default_value": null
    },
    {
      "relname": "staff_identity_state",
      "attname": "realm_id",
      "type": "uuid",
      "attnotnull": true,
      "attidentity": "",
      "attgenerated": "",
      "default_value": null
    },
    {
      "relname": "staff_identity_state",
      "attname": "registry_revision",
      "type": "bigint",
      "attnotnull": true,
      "attidentity": "",
      "attgenerated": "",
      "default_value": null
    },
    {
      "relname": "staff_identity_state",
      "attname": "singleton",
      "type": "boolean",
      "attnotnull": true,
      "attidentity": "",
      "attgenerated": "",
      "default_value": "true"
    },
    {
      "relname": "staff_identity_state",
      "attname": "status",
      "type": "text",
      "attnotnull": true,
      "attidentity": "",
      "attgenerated": "",
      "default_value": null
    },
    {
      "relname": "staff_identity_subjects",
      "attname": "created_generation_id",
      "type": "uuid",
      "attnotnull": true,
      "attidentity": "",
      "attgenerated": "",
      "default_value": null
    },
    {
      "relname": "staff_identity_subjects",
      "attname": "created_registry_revision",
      "type": "bigint",
      "attnotnull": true,
      "attidentity": "",
      "attgenerated": "",
      "default_value": null
    },
    {
      "relname": "staff_identity_subjects",
      "attname": "realm_id",
      "type": "uuid",
      "attnotnull": true,
      "attidentity": "",
      "attgenerated": "",
      "default_value": null
    },
    {
      "relname": "staff_identity_subjects",
      "attname": "subject_id",
      "type": "uuid",
      "attnotnull": true,
      "attidentity": "",
      "attgenerated": "",
      "default_value": null
    },
    {
      "relname": "staff_identity_subjects",
      "attname": "user_id_at_binding",
      "type": "integer",
      "attnotnull": true,
      "attidentity": "",
      "attgenerated": "",
      "default_value": null
    },
    {
      "relname": "users",
      "attname": "authorization_epoch",
      "type": "bigint",
      "attnotnull": true,
      "attidentity": "",
      "attgenerated": "",
      "default_value": "1"
    },
    {
      "relname": "users",
      "attname": "authorization_mode",
      "type": "text",
      "attnotnull": true,
      "attidentity": "",
      "attgenerated": "",
      "default_value": "'legacy'::text"
    },
    {
      "relname": "users",
      "attname": "id",
      "type": "integer",
      "attnotnull": true,
      "attidentity": "",
      "attgenerated": "",
      "default_value": "nextval('users_id_seq'::regclass)"
    }
  ],
  "constraints": [
    {
      "relname": "staff_authority_control",
      "conname": "staff_authority_control_binding_epoch_check",
      "contype": "c",
      "convalidated": true,
      "condeferrable": false,
      "condeferred": false,
      "definition": "CHECK (binding_epoch > 0)"
    },
    {
      "relname": "staff_authority_control",
      "conname": "staff_authority_control_binding_epoch_not_null",
      "contype": "n",
      "convalidated": true,
      "condeferrable": false,
      "condeferred": false,
      "definition": "NOT NULL binding_epoch"
    },
    {
      "relname": "staff_authority_control",
      "conname": "staff_authority_control_check",
      "contype": "c",
      "convalidated": true,
      "condeferrable": false,
      "condeferred": false,
      "definition": "CHECK ((state = ANY (ARRAY['unbound'::text, 'quarantined'::text])) AND owner_user_id IS NULL AND pending_owner_user_id IS NULL OR (state = ANY (ARRAY['prepared'::text, 'prepared-recovery'::text])) AND owner_user_id IS NULL AND pending_owner_user_id IS NOT NULL AND conversion_digest IS NOT NULL AND recovery_reference IS NOT NULL AND conversion_digest ~ '^[a-f0-9]{64}$'::text AND length(recovery_reference) >= 1 AND length(recovery_reference) <= 200 OR state = 'active'::text AND owner_user_id IS NOT NULL AND pending_owner_user_id IS NULL AND conversion_digest IS NOT NULL AND recovery_reference IS NOT NULL AND conversion_digest ~ '^[a-f0-9]{64}$'::text AND length(recovery_reference) >= 1 AND length(recovery_reference) <= 200)"
    },
    {
      "relname": "staff_authority_control",
      "conname": "staff_authority_control_owner_user_id_fkey",
      "contype": "f",
      "convalidated": true,
      "condeferrable": false,
      "condeferred": false,
      "definition": "FOREIGN KEY (owner_user_id) REFERENCES $SCHEMA.users(id) ON DELETE RESTRICT"
    },
    {
      "relname": "staff_authority_control",
      "conname": "staff_authority_control_pending_owner_user_id_fkey",
      "contype": "f",
      "convalidated": true,
      "condeferrable": false,
      "condeferred": false,
      "definition": "FOREIGN KEY (pending_owner_user_id) REFERENCES $SCHEMA.users(id) ON DELETE RESTRICT"
    },
    {
      "relname": "staff_authority_control",
      "conname": "staff_authority_control_pkey",
      "contype": "p",
      "convalidated": true,
      "condeferrable": false,
      "condeferred": false,
      "definition": "PRIMARY KEY (singleton)"
    },
    {
      "relname": "staff_authority_control",
      "conname": "staff_authority_control_realm_id_check",
      "contype": "c",
      "convalidated": true,
      "condeferrable": false,
      "condeferred": false,
      "definition": "CHECK (realm_id ~ '^[a-f0-9-]{36}$'::text)"
    },
    {
      "relname": "staff_authority_control",
      "conname": "staff_authority_control_realm_id_not_null",
      "contype": "n",
      "convalidated": true,
      "condeferrable": false,
      "condeferred": false,
      "definition": "NOT NULL realm_id"
    },
    {
      "relname": "staff_authority_control",
      "conname": "staff_authority_control_singleton_check",
      "contype": "c",
      "convalidated": true,
      "condeferrable": false,
      "condeferred": false,
      "definition": "CHECK (singleton)"
    },
    {
      "relname": "staff_authority_control",
      "conname": "staff_authority_control_singleton_not_null",
      "contype": "n",
      "convalidated": true,
      "condeferrable": false,
      "condeferred": false,
      "definition": "NOT NULL singleton"
    },
    {
      "relname": "staff_authority_control",
      "conname": "staff_authority_control_state_check",
      "contype": "c",
      "convalidated": true,
      "condeferrable": false,
      "condeferred": false,
      "definition": "CHECK (state = ANY (ARRAY['unbound'::text, 'prepared'::text, 'active'::text, 'quarantined'::text, 'prepared-recovery'::text]))"
    },
    {
      "relname": "staff_authority_control",
      "conname": "staff_authority_control_state_not_null",
      "contype": "n",
      "convalidated": true,
      "condeferrable": false,
      "condeferred": false,
      "definition": "NOT NULL state"
    },
    {
      "relname": "staff_identity_binding_events",
      "conname": "staff_identity_binding_events_check",
      "contype": "c",
      "convalidated": true,
      "condeferrable": false,
      "condeferred": false,
      "definition": "CHECK (previous_subject_id IS DISTINCT FROM new_subject_id)"
    },
    {
      "relname": "staff_identity_binding_events",
      "conname": "staff_identity_binding_events_generation_id_fkey",
      "contype": "f",
      "convalidated": true,
      "condeferrable": false,
      "condeferred": false,
      "definition": "FOREIGN KEY (generation_id) REFERENCES $SCHEMA.staff_identity_generations(generation_id) ON DELETE RESTRICT"
    },
    {
      "relname": "staff_identity_binding_events",
      "conname": "staff_identity_binding_events_generation_id_not_null",
      "contype": "n",
      "convalidated": true,
      "condeferrable": false,
      "condeferred": false,
      "definition": "NOT NULL generation_id"
    },
    {
      "relname": "staff_identity_binding_events",
      "conname": "staff_identity_binding_events_new_subject_id_fkey",
      "contype": "f",
      "convalidated": true,
      "condeferrable": false,
      "condeferred": false,
      "definition": "FOREIGN KEY (new_subject_id) REFERENCES $SCHEMA.staff_identity_subjects(subject_id) ON DELETE RESTRICT"
    },
    {
      "relname": "staff_identity_binding_events",
      "conname": "staff_identity_binding_events_new_subject_id_key",
      "contype": "u",
      "convalidated": true,
      "condeferrable": false,
      "condeferred": false,
      "definition": "UNIQUE (new_subject_id)"
    },
    {
      "relname": "staff_identity_binding_events",
      "conname": "staff_identity_binding_events_pkey",
      "contype": "p",
      "convalidated": true,
      "condeferrable": false,
      "condeferred": false,
      "definition": "PRIMARY KEY (registry_revision)"
    },
    {
      "relname": "staff_identity_binding_events",
      "conname": "staff_identity_binding_events_previous_subject_id_fkey",
      "contype": "f",
      "convalidated": true,
      "condeferrable": false,
      "condeferred": false,
      "definition": "FOREIGN KEY (previous_subject_id) REFERENCES $SCHEMA.staff_identity_subjects(subject_id) ON DELETE RESTRICT"
    },
    {
      "relname": "staff_identity_binding_events",
      "conname": "staff_identity_binding_events_registry_revision_check",
      "contype": "c",
      "convalidated": true,
      "condeferrable": false,
      "condeferred": false,
      "definition": "CHECK (registry_revision > 1)"
    },
    {
      "relname": "staff_identity_binding_events",
      "conname": "staff_identity_binding_events_registry_revision_not_null",
      "contype": "n",
      "convalidated": true,
      "condeferrable": false,
      "condeferred": false,
      "definition": "NOT NULL registry_revision"
    },
    {
      "relname": "staff_identity_binding_events",
      "conname": "staff_identity_binding_events_user_id_check",
      "contype": "c",
      "convalidated": true,
      "condeferrable": false,
      "condeferred": false,
      "definition": "CHECK (user_id > 0)"
    },
    {
      "relname": "staff_identity_binding_events",
      "conname": "staff_identity_binding_events_user_id_not_null",
      "contype": "n",
      "convalidated": true,
      "condeferrable": false,
      "condeferred": false,
      "definition": "NOT NULL user_id"
    },
    {
      "relname": "staff_identity_current",
      "conname": "staff_identity_current_bound_registry_revision_fkey",
      "contype": "f",
      "convalidated": true,
      "condeferrable": false,
      "condeferred": false,
      "definition": "FOREIGN KEY (bound_registry_revision) REFERENCES $SCHEMA.staff_identity_binding_events(registry_revision) ON DELETE RESTRICT"
    },
    {
      "relname": "staff_identity_current",
      "conname": "staff_identity_current_bound_registry_revision_key",
      "contype": "u",
      "convalidated": true,
      "condeferrable": false,
      "condeferred": false,
      "definition": "UNIQUE (bound_registry_revision)"
    },
    {
      "relname": "staff_identity_current",
      "conname": "staff_identity_current_bound_registry_revision_not_null",
      "contype": "n",
      "convalidated": true,
      "condeferrable": false,
      "condeferred": false,
      "definition": "NOT NULL bound_registry_revision"
    },
    {
      "relname": "staff_identity_current",
      "conname": "staff_identity_current_pkey",
      "contype": "p",
      "convalidated": true,
      "condeferrable": false,
      "condeferred": false,
      "definition": "PRIMARY KEY (user_id)"
    },
    {
      "relname": "staff_identity_current",
      "conname": "staff_identity_current_subject_id_fkey",
      "contype": "f",
      "convalidated": true,
      "condeferrable": false,
      "condeferred": false,
      "definition": "FOREIGN KEY (subject_id) REFERENCES $SCHEMA.staff_identity_subjects(subject_id) ON DELETE RESTRICT"
    },
    {
      "relname": "staff_identity_current",
      "conname": "staff_identity_current_subject_id_key",
      "contype": "u",
      "convalidated": true,
      "condeferrable": false,
      "condeferred": false,
      "definition": "UNIQUE (subject_id)"
    },
    {
      "relname": "staff_identity_current",
      "conname": "staff_identity_current_subject_id_not_null",
      "contype": "n",
      "convalidated": true,
      "condeferrable": false,
      "condeferred": false,
      "definition": "NOT NULL subject_id"
    },
    {
      "relname": "staff_identity_current",
      "conname": "staff_identity_current_user_id_fkey",
      "contype": "f",
      "convalidated": true,
      "condeferrable": false,
      "condeferred": false,
      "definition": "FOREIGN KEY (user_id) REFERENCES $SCHEMA.users(id) ON DELETE RESTRICT"
    },
    {
      "relname": "staff_identity_current",
      "conname": "staff_identity_current_user_id_not_null",
      "contype": "n",
      "convalidated": true,
      "condeferrable": false,
      "condeferred": false,
      "definition": "NOT NULL user_id"
    },
    {
      "relname": "staff_identity_generations",
      "conname": "staff_identity_generations_check",
      "contype": "c",
      "convalidated": true,
      "condeferrable": false,
      "condeferred": false,
      "definition": "CHECK ((reason = 'initialize'::text) = (previous_generation_id IS NULL))"
    },
    {
      "relname": "staff_identity_generations",
      "conname": "staff_identity_generations_generation_id_not_null",
      "contype": "n",
      "convalidated": true,
      "condeferrable": false,
      "condeferred": false,
      "definition": "NOT NULL generation_id"
    },
    {
      "relname": "staff_identity_generations",
      "conname": "staff_identity_generations_pkey",
      "contype": "p",
      "convalidated": true,
      "condeferrable": false,
      "condeferred": false,
      "definition": "PRIMARY KEY (generation_id)"
    },
    {
      "relname": "staff_identity_generations",
      "conname": "staff_identity_generations_previous_generation_id_fkey",
      "contype": "f",
      "convalidated": true,
      "condeferrable": false,
      "condeferred": false,
      "definition": "FOREIGN KEY (previous_generation_id) REFERENCES $SCHEMA.staff_identity_generations(generation_id) ON DELETE RESTRICT"
    },
    {
      "relname": "staff_identity_generations",
      "conname": "staff_identity_generations_realm_id_not_null",
      "contype": "n",
      "convalidated": true,
      "condeferrable": false,
      "condeferred": false,
      "definition": "NOT NULL realm_id"
    },
    {
      "relname": "staff_identity_generations",
      "conname": "staff_identity_generations_reason_check",
      "contype": "c",
      "convalidated": true,
      "condeferrable": false,
      "condeferred": false,
      "definition": "CHECK (reason = ANY (ARRAY['initialize'::text, 'reset'::text, 'restore'::text]))"
    },
    {
      "relname": "staff_identity_generations",
      "conname": "staff_identity_generations_reason_not_null",
      "contype": "n",
      "convalidated": true,
      "condeferrable": false,
      "condeferred": false,
      "definition": "NOT NULL reason"
    },
    {
      "relname": "staff_identity_state",
      "conname": "staff_identity_state_generation_id_fkey",
      "contype": "f",
      "convalidated": true,
      "condeferrable": false,
      "condeferred": false,
      "definition": "FOREIGN KEY (generation_id) REFERENCES $SCHEMA.staff_identity_generations(generation_id) ON DELETE RESTRICT"
    },
    {
      "relname": "staff_identity_state",
      "conname": "staff_identity_state_generation_id_not_null",
      "contype": "n",
      "convalidated": true,
      "condeferrable": false,
      "condeferred": false,
      "definition": "NOT NULL generation_id"
    },
    {
      "relname": "staff_identity_state",
      "conname": "staff_identity_state_pkey",
      "contype": "p",
      "convalidated": true,
      "condeferrable": false,
      "condeferred": false,
      "definition": "PRIMARY KEY (singleton)"
    },
    {
      "relname": "staff_identity_state",
      "conname": "staff_identity_state_ready_owner_subject_id_fkey",
      "contype": "f",
      "convalidated": true,
      "condeferrable": false,
      "condeferred": false,
      "definition": "FOREIGN KEY (ready_owner_subject_id) REFERENCES $SCHEMA.staff_identity_subjects(subject_id) ON DELETE RESTRICT"
    },
    {
      "relname": "staff_identity_state",
      "conname": "staff_identity_state_realm_id_not_null",
      "contype": "n",
      "convalidated": true,
      "condeferrable": false,
      "condeferred": false,
      "definition": "NOT NULL realm_id"
    },
    {
      "relname": "staff_identity_state",
      "conname": "staff_identity_state_registry_revision_check",
      "contype": "c",
      "convalidated": true,
      "condeferrable": false,
      "condeferred": false,
      "definition": "CHECK (registry_revision > 0)"
    },
    {
      "relname": "staff_identity_state",
      "conname": "staff_identity_state_registry_revision_not_null",
      "contype": "n",
      "convalidated": true,
      "condeferrable": false,
      "condeferred": false,
      "definition": "NOT NULL registry_revision"
    },
    {
      "relname": "staff_identity_state",
      "conname": "staff_identity_state_singleton_check",
      "contype": "c",
      "convalidated": true,
      "condeferrable": false,
      "condeferred": false,
      "definition": "CHECK (singleton)"
    },
    {
      "relname": "staff_identity_state",
      "conname": "staff_identity_state_singleton_not_null",
      "contype": "n",
      "convalidated": true,
      "condeferrable": false,
      "condeferred": false,
      "definition": "NOT NULL singleton"
    },
    {
      "relname": "staff_identity_state",
      "conname": "staff_identity_state_status_not_null",
      "contype": "n",
      "convalidated": true,
      "condeferrable": false,
      "condeferred": false,
      "definition": "NOT NULL status"
    },
    {
      "relname": "staff_identity_state",
      "conname": "staff_identity_state_v2_readiness",
      "contype": "c",
      "convalidated": true,
      "condeferrable": false,
      "condeferred": false,
      "definition": "CHECK (status = 'quarantined'::text AND ready_owner_subject_id IS NULL AND ready_control_epoch IS NULL OR status = 'ready'::text AND ready_owner_subject_id IS NOT NULL AND ready_control_epoch IS NOT NULL AND ready_control_epoch > 0)"
    },
    {
      "relname": "staff_identity_subjects",
      "conname": "staff_identity_subjects_created_generation_id_fkey",
      "contype": "f",
      "convalidated": true,
      "condeferrable": false,
      "condeferred": false,
      "definition": "FOREIGN KEY (created_generation_id) REFERENCES $SCHEMA.staff_identity_generations(generation_id) ON DELETE RESTRICT"
    },
    {
      "relname": "staff_identity_subjects",
      "conname": "staff_identity_subjects_created_generation_id_not_null",
      "contype": "n",
      "convalidated": true,
      "condeferrable": false,
      "condeferred": false,
      "definition": "NOT NULL created_generation_id"
    },
    {
      "relname": "staff_identity_subjects",
      "conname": "staff_identity_subjects_created_registry_revision_check",
      "contype": "c",
      "convalidated": true,
      "condeferrable": false,
      "condeferred": false,
      "definition": "CHECK (created_registry_revision > 1)"
    },
    {
      "relname": "staff_identity_subjects",
      "conname": "staff_identity_subjects_created_registry_revision_not_null",
      "contype": "n",
      "convalidated": true,
      "condeferrable": false,
      "condeferred": false,
      "definition": "NOT NULL created_registry_revision"
    },
    {
      "relname": "staff_identity_subjects",
      "conname": "staff_identity_subjects_pkey",
      "contype": "p",
      "convalidated": true,
      "condeferrable": false,
      "condeferred": false,
      "definition": "PRIMARY KEY (subject_id)"
    },
    {
      "relname": "staff_identity_subjects",
      "conname": "staff_identity_subjects_realm_id_not_null",
      "contype": "n",
      "convalidated": true,
      "condeferrable": false,
      "condeferred": false,
      "definition": "NOT NULL realm_id"
    },
    {
      "relname": "staff_identity_subjects",
      "conname": "staff_identity_subjects_subject_id_not_null",
      "contype": "n",
      "convalidated": true,
      "condeferrable": false,
      "condeferred": false,
      "definition": "NOT NULL subject_id"
    },
    {
      "relname": "staff_identity_subjects",
      "conname": "staff_identity_subjects_user_id_at_binding_check",
      "contype": "c",
      "convalidated": true,
      "condeferrable": false,
      "condeferred": false,
      "definition": "CHECK (user_id_at_binding > 0)"
    },
    {
      "relname": "staff_identity_subjects",
      "conname": "staff_identity_subjects_user_id_at_binding_not_null",
      "contype": "n",
      "convalidated": true,
      "condeferrable": false,
      "condeferred": false,
      "definition": "NOT NULL user_id_at_binding"
    }
  ],
  "indexes": [
    {
      "relname": "staff_authority_control",
      "index_name": "staff_authority_control_pkey",
      "indisvalid": true,
      "indisready": true,
      "indisunique": true,
      "indisprimary": true,
      "definition": "CREATE UNIQUE INDEX staff_authority_control_pkey ON $SCHEMA.staff_authority_control USING btree (singleton)"
    },
    {
      "relname": "staff_identity_binding_events",
      "index_name": "staff_identity_binding_events_new_subject_id_key",
      "indisvalid": true,
      "indisready": true,
      "indisunique": true,
      "indisprimary": false,
      "definition": "CREATE UNIQUE INDEX staff_identity_binding_events_new_subject_id_key ON $SCHEMA.staff_identity_binding_events USING btree (new_subject_id)"
    },
    {
      "relname": "staff_identity_binding_events",
      "index_name": "staff_identity_binding_events_pkey",
      "indisvalid": true,
      "indisready": true,
      "indisunique": true,
      "indisprimary": true,
      "definition": "CREATE UNIQUE INDEX staff_identity_binding_events_pkey ON $SCHEMA.staff_identity_binding_events USING btree (registry_revision)"
    },
    {
      "relname": "staff_identity_current",
      "index_name": "staff_identity_current_bound_registry_revision_key",
      "indisvalid": true,
      "indisready": true,
      "indisunique": true,
      "indisprimary": false,
      "definition": "CREATE UNIQUE INDEX staff_identity_current_bound_registry_revision_key ON $SCHEMA.staff_identity_current USING btree (bound_registry_revision)"
    },
    {
      "relname": "staff_identity_current",
      "index_name": "staff_identity_current_pkey",
      "indisvalid": true,
      "indisready": true,
      "indisunique": true,
      "indisprimary": true,
      "definition": "CREATE UNIQUE INDEX staff_identity_current_pkey ON $SCHEMA.staff_identity_current USING btree (user_id)"
    },
    {
      "relname": "staff_identity_current",
      "index_name": "staff_identity_current_subject_id_key",
      "indisvalid": true,
      "indisready": true,
      "indisunique": true,
      "indisprimary": false,
      "definition": "CREATE UNIQUE INDEX staff_identity_current_subject_id_key ON $SCHEMA.staff_identity_current USING btree (subject_id)"
    },
    {
      "relname": "staff_identity_generations",
      "index_name": "staff_identity_generations_pkey",
      "indisvalid": true,
      "indisready": true,
      "indisunique": true,
      "indisprimary": true,
      "definition": "CREATE UNIQUE INDEX staff_identity_generations_pkey ON $SCHEMA.staff_identity_generations USING btree (generation_id)"
    },
    {
      "relname": "staff_identity_state",
      "index_name": "staff_identity_state_pkey",
      "indisvalid": true,
      "indisready": true,
      "indisunique": true,
      "indisprimary": true,
      "definition": "CREATE UNIQUE INDEX staff_identity_state_pkey ON $SCHEMA.staff_identity_state USING btree (singleton)"
    },
    {
      "relname": "staff_identity_subjects",
      "index_name": "staff_identity_subjects_pkey",
      "indisvalid": true,
      "indisready": true,
      "indisunique": true,
      "indisprimary": true,
      "definition": "CREATE UNIQUE INDEX staff_identity_subjects_pkey ON $SCHEMA.staff_identity_subjects USING btree (subject_id)"
    }
  ],
  "triggers": [
    {
      "relname": "parties",
      "tgname": "staff_clinical_authority_epoch",
      "tgtype": 23,
      "tgenabled": "O",
      "tgdeferrable": false,
      "tginitdeferred": false,
      "tgnargs": 0,
      "args": "",
      "attrs": "",
      "condition": null,
      "proname": "staff_clinical_authority_epoch_guard",
      "function_schema": "$SCHEMA"
    },
    {
      "relname": "staff_authority_control",
      "tgname": "staff_authority_control_guard_row",
      "tgtype": 31,
      "tgenabled": "O",
      "tgdeferrable": false,
      "tginitdeferred": false,
      "tgnargs": 0,
      "args": "",
      "attrs": "",
      "condition": null,
      "proname": "staff_authority_control_guard",
      "function_schema": "$SCHEMA"
    },
    {
      "relname": "staff_authority_control",
      "tgname": "staff_authority_control_guard_truncate",
      "tgtype": 34,
      "tgenabled": "O",
      "tgdeferrable": false,
      "tginitdeferred": false,
      "tgnargs": 0,
      "args": "",
      "attrs": "",
      "condition": null,
      "proname": "staff_authority_control_guard",
      "function_schema": "$SCHEMA"
    },
    {
      "relname": "staff_identity_binding_events",
      "tgname": "staff_identity_binding_events_guard",
      "tgtype": 7,
      "tgenabled": "O",
      "tgdeferrable": false,
      "tginitdeferred": false,
      "tgnargs": 0,
      "args": "",
      "attrs": "",
      "condition": null,
      "proname": "staff_identity_event_guard",
      "function_schema": "$SCHEMA"
    },
    {
      "relname": "staff_identity_binding_events",
      "tgname": "staff_identity_binding_events_immutable",
      "tgtype": 27,
      "tgenabled": "O",
      "tgdeferrable": false,
      "tginitdeferred": false,
      "tgnargs": 0,
      "args": "",
      "attrs": "",
      "condition": null,
      "proname": "staff_identity_history_guard",
      "function_schema": "$SCHEMA"
    },
    {
      "relname": "staff_identity_binding_events",
      "tgname": "staff_identity_binding_events_no_truncate",
      "tgtype": 34,
      "tgenabled": "O",
      "tgdeferrable": false,
      "tginitdeferred": false,
      "tgnargs": 0,
      "args": "",
      "attrs": "",
      "condition": null,
      "proname": "staff_identity_history_guard",
      "function_schema": "$SCHEMA"
    },
    {
      "relname": "staff_identity_current",
      "tgname": "staff_identity_current_guard",
      "tgtype": 31,
      "tgenabled": "O",
      "tgdeferrable": false,
      "tginitdeferred": false,
      "tgnargs": 0,
      "args": "",
      "attrs": "",
      "condition": null,
      "proname": "staff_identity_current_guard",
      "function_schema": "$SCHEMA"
    },
    {
      "relname": "staff_identity_current",
      "tgname": "staff_identity_current_no_truncate",
      "tgtype": 34,
      "tgenabled": "O",
      "tgdeferrable": false,
      "tginitdeferred": false,
      "tgnargs": 0,
      "args": "",
      "attrs": "",
      "condition": null,
      "proname": "staff_identity_current_guard",
      "function_schema": "$SCHEMA"
    },
    {
      "relname": "staff_identity_generations",
      "tgname": "staff_identity_generations_immutable",
      "tgtype": 27,
      "tgenabled": "O",
      "tgdeferrable": false,
      "tginitdeferred": false,
      "tgnargs": 0,
      "args": "",
      "attrs": "",
      "condition": null,
      "proname": "staff_identity_history_guard",
      "function_schema": "$SCHEMA"
    },
    {
      "relname": "staff_identity_generations",
      "tgname": "staff_identity_generations_no_truncate",
      "tgtype": 34,
      "tgenabled": "O",
      "tgdeferrable": false,
      "tginitdeferred": false,
      "tgnargs": 0,
      "args": "",
      "attrs": "",
      "condition": null,
      "proname": "staff_identity_history_guard",
      "function_schema": "$SCHEMA"
    },
    {
      "relname": "staff_identity_state",
      "tgname": "staff_identity_state_guard",
      "tgtype": 31,
      "tgenabled": "O",
      "tgdeferrable": false,
      "tginitdeferred": false,
      "tgnargs": 0,
      "args": "",
      "attrs": "",
      "condition": null,
      "proname": "staff_identity_state_guard",
      "function_schema": "$SCHEMA"
    },
    {
      "relname": "staff_identity_state",
      "tgname": "staff_identity_state_no_truncate",
      "tgtype": 34,
      "tgenabled": "O",
      "tgdeferrable": false,
      "tginitdeferred": false,
      "tgnargs": 0,
      "args": "",
      "attrs": "",
      "condition": null,
      "proname": "staff_identity_state_guard",
      "function_schema": "$SCHEMA"
    },
    {
      "relname": "staff_identity_subjects",
      "tgname": "staff_identity_subjects_guard",
      "tgtype": 7,
      "tgenabled": "O",
      "tgdeferrable": false,
      "tginitdeferred": false,
      "tgnargs": 0,
      "args": "",
      "attrs": "",
      "condition": null,
      "proname": "staff_identity_subject_guard",
      "function_schema": "$SCHEMA"
    },
    {
      "relname": "staff_identity_subjects",
      "tgname": "staff_identity_subjects_immutable",
      "tgtype": 27,
      "tgenabled": "O",
      "tgdeferrable": false,
      "tginitdeferred": false,
      "tgnargs": 0,
      "args": "",
      "attrs": "",
      "condition": null,
      "proname": "staff_identity_history_guard",
      "function_schema": "$SCHEMA"
    },
    {
      "relname": "staff_identity_subjects",
      "tgname": "staff_identity_subjects_no_truncate",
      "tgtype": 34,
      "tgenabled": "O",
      "tgdeferrable": false,
      "tginitdeferred": false,
      "tgnargs": 0,
      "args": "",
      "attrs": "",
      "condition": null,
      "proname": "staff_identity_history_guard",
      "function_schema": "$SCHEMA"
    },
    {
      "relname": "users",
      "tgname": "staff_account_authority_epoch",
      "tgtype": 31,
      "tgenabled": "O",
      "tgdeferrable": false,
      "tginitdeferred": false,
      "tgnargs": 0,
      "args": "",
      "attrs": "",
      "condition": null,
      "proname": "staff_account_authority_epoch_guard",
      "function_schema": "$SCHEMA"
    }
  ],
  "functions": [
    {
      "proname": "staff_account_authority_epoch_guard",
      "arguments": "",
      "returns": "trigger",
      "lanname": "plpgsql",
      "prokind": "f",
      "prosecdef": false,
      "provolatile": "v",
      "proisstrict": false,
      "proleakproof": false,
      "proparallel": "u",
      "proconfig": null,
      "prosrc": "\nDECLARE control RECORD;\nBEGIN\n  SELECT state, owner_user_id INTO control FROM staff_authority_control WHERE singleton FOR SHARE;\n  IF NOT FOUND THEN RAISE EXCEPTION 'staff authority control missing'; END IF;\n  IF TG_OP = 'DELETE' THEN\n    IF control.owner_user_id = OLD.id THEN RAISE EXCEPTION 'owner account is protected'; END IF;\n    RETURN OLD;\n  END IF;\n  IF NEW.authorization_mode NOT IN ('legacy','canonical') THEN RAISE EXCEPTION 'invalid staff authority mode'; END IF;\n  IF control.state = 'active' AND NEW.authorization_mode <> 'canonical' THEN\n    RAISE EXCEPTION 'legacy staff authority is disabled';\n  END IF;\n  IF control.owner_user_id = NEW.id AND (NOT NEW.is_active OR NEW.role <> 'admin') THEN\n    RAISE EXCEPTION 'owner account cannot be disabled or demoted';\n  END IF;\n  IF TG_OP = 'INSERT' THEN\n    NEW.authorization_epoch := GREATEST(NEW.authorization_epoch, 1);\n  ELSE\n    IF OLD.authorization_mode = 'canonical' AND NEW.authorization_mode <> 'canonical' THEN\n      RAISE EXCEPTION 'canonical staff authority cannot downgrade';\n    END IF;\n    NEW.authorization_epoch := OLD.authorization_epoch;\n    IF ROW(NEW.username,NEW.password_hash,NEW.role,NEW.is_active,NEW.party_id,NEW.permissions,NEW.authorization_mode)\n      IS DISTINCT FROM ROW(OLD.username,OLD.password_hash,OLD.role,OLD.is_active,OLD.party_id,OLD.permissions,OLD.authorization_mode) THEN\n      NEW.authorization_epoch := OLD.authorization_epoch + 1;\n    END IF;\n  END IF;\n  RETURN NEW;\nEND "
    },
    {
      "proname": "staff_authority_control_guard",
      "arguments": "",
      "returns": "trigger",
      "lanname": "plpgsql",
      "prokind": "f",
      "prosecdef": false,
      "provolatile": "v",
      "proisstrict": false,
      "proleakproof": false,
      "proparallel": "u",
      "proconfig": null,
      "prosrc": "\nDECLARE account_row RECORD;\nBEGIN\n  IF TG_OP IN ('DELETE','TRUNCATE') THEN\n    RAISE EXCEPTION 'staff authority control cannot be removed';\n  END IF;\n  IF TG_OP = 'UPDATE' THEN\n    IF NEW.realm_id IS DISTINCT FROM OLD.realm_id THEN RAISE EXCEPTION 'target authority realm is immutable'; END IF;\n    IF OLD.state = 'active' AND NEW.state <> 'active' THEN\n      RAISE EXCEPTION 'active staff authority cannot return to legacy mode';\n    END IF;\n    IF OLD.state IN ('quarantined','prepared-recovery') AND NEW.state NOT IN ('quarantined','prepared-recovery','active') THEN\n      RAISE EXCEPTION 'restored authority cannot return to legacy mode';\n    END IF;\n    IF NEW.state = 'active' AND OLD.state NOT IN ('prepared','prepared-recovery','active') THEN\n      RAISE EXCEPTION 'owner activation requires explicit preparation';\n    END IF;\n    IF NEW.state = 'prepared-recovery' AND OLD.state NOT IN ('quarantined','prepared-recovery') THEN\n      RAISE EXCEPTION 'owner recovery requires a quarantined target';\n    END IF;\n    NEW.binding_epoch := OLD.binding_epoch + 1;\n  ELSE\n    IF NEW.state <> 'unbound' THEN RAISE EXCEPTION 'new authority control must be unbound'; END IF;\n    NEW.realm_id := gen_random_uuid()::text;\n    NEW.binding_epoch := 1;\n  END IF;\n  IF NEW.state IN ('prepared','prepared-recovery') THEN\n    SELECT role, is_active INTO account_row FROM users WHERE id=NEW.pending_owner_user_id FOR SHARE;\n    IF NOT FOUND OR account_row.role <> 'admin' OR NOT account_row.is_active THEN\n      RAISE EXCEPTION 'pending owner must be explicitly selected active administrator';\n    END IF;\n  END IF;\n  IF NEW.state = 'active' THEN\n    SELECT role, is_active, authorization_mode INTO account_row FROM users WHERE id = NEW.owner_user_id FOR SHARE;\n    IF NOT FOUND OR account_row.role <> 'admin' OR NOT account_row.is_active OR account_row.authorization_mode <> 'canonical' THEN\n      RAISE EXCEPTION 'owner must be an explicitly bound active canonical administrator';\n    END IF;\n    IF EXISTS (SELECT 1 FROM users WHERE authorization_mode <> 'canonical') THEN\n      RAISE EXCEPTION 'activation requires an explicit conversion for every account';\n    END IF;\n  END IF;\n  RETURN NEW;\nEND "
    },
    {
      "proname": "staff_clinical_authority_epoch_guard",
      "arguments": "",
      "returns": "trigger",
      "lanname": "plpgsql",
      "prokind": "f",
      "prosecdef": false,
      "provolatile": "v",
      "proisstrict": false,
      "proleakproof": false,
      "proparallel": "u",
      "proconfig": null,
      "prosrc": "\nBEGIN\n  IF TG_OP = 'INSERT' THEN NEW.clinical_authority_epoch := GREATEST(NEW.clinical_authority_epoch, 1);\n  ELSE\n    NEW.clinical_authority_epoch := OLD.clinical_authority_epoch;\n    IF ROW(NEW.kind, NEW.is_active) IS DISTINCT FROM ROW(OLD.kind, OLD.is_active) THEN\n      NEW.clinical_authority_epoch := OLD.clinical_authority_epoch + 1;\n    END IF;\n  END IF;\n  RETURN NEW;\nEND "
    },
    {
      "proname": "staff_identity_current_guard",
      "arguments": "",
      "returns": "trigger",
      "lanname": "plpgsql",
      "prokind": "f",
      "prosecdef": false,
      "provolatile": "v",
      "proisstrict": false,
      "proleakproof": false,
      "proparallel": "u",
      "proconfig": [
        "search_path=pg_catalog, $SCHEMA"
      ],
      "prosrc": "DECLARE h RECORD; e RECORD; BEGIN\n      IF TG_OP IN ('UPDATE','TRUNCATE') THEN RAISE EXCEPTION 'current identity binding cannot be updated or truncated'; END IF;\n      SELECT * INTO h FROM $SCHEMA.staff_identity_state WHERE singleton FOR SHARE;\n      IF NOT FOUND OR h.status<>'quarantined' THEN RAISE EXCEPTION 'current binding requires quarantine'; END IF;\n      SELECT * INTO e FROM $SCHEMA.staff_identity_binding_events WHERE registry_revision=h.registry_revision;\n      IF NOT FOUND OR e.generation_id<>h.generation_id THEN RAISE EXCEPTION 'current binding requires exact event'; END IF;\n      IF TG_OP='DELETE' THEN\n        IF e.user_id<>OLD.user_id OR e.previous_subject_id IS DISTINCT FROM OLD.subject_id THEN RAISE EXCEPTION 'current binding retirement mismatch'; END IF;\n        RETURN OLD;\n      END IF;\n      IF e.user_id<>NEW.user_id OR e.new_subject_id IS DISTINCT FROM NEW.subject_id OR NEW.bound_registry_revision<>h.registry_revision THEN RAISE EXCEPTION 'current binding creation mismatch'; END IF;\n      RETURN NEW;\n    END"
    },
    {
      "proname": "staff_identity_event_guard",
      "arguments": "",
      "returns": "trigger",
      "lanname": "plpgsql",
      "prokind": "f",
      "prosecdef": false,
      "provolatile": "v",
      "proisstrict": false,
      "proleakproof": false,
      "proparallel": "u",
      "proconfig": [
        "search_path=pg_catalog, $SCHEMA"
      ],
      "prosrc": "DECLARE h RECORD; old_subject RECORD; new_subject RECORD; BEGIN\n      SELECT * INTO h FROM $SCHEMA.staff_identity_state WHERE singleton FOR SHARE;\n      IF NOT FOUND OR h.status<>'quarantined' OR NEW.generation_id<>h.generation_id OR NEW.registry_revision<>h.registry_revision THEN RAISE EXCEPTION 'invalid binding event state'; END IF;\n      IF NEW.previous_subject_id IS NOT NULL THEN\n        SELECT * INTO old_subject FROM $SCHEMA.staff_identity_subjects WHERE subject_id=NEW.previous_subject_id;\n        IF NOT FOUND OR old_subject.realm_id<>h.realm_id OR old_subject.user_id_at_binding<>NEW.user_id THEN RAISE EXCEPTION 'invalid previous binding subject'; END IF;\n        IF NOT EXISTS(SELECT 1 FROM $SCHEMA.staff_identity_current WHERE user_id=NEW.user_id AND subject_id=NEW.previous_subject_id) THEN RAISE EXCEPTION 'binding event old subject mismatch'; END IF;\n      ELSIF EXISTS(SELECT 1 FROM $SCHEMA.staff_identity_current WHERE user_id=NEW.user_id) THEN RAISE EXCEPTION 'binding event omitted old subject'; END IF;\n      IF NEW.new_subject_id IS NOT NULL THEN\n        SELECT * INTO new_subject FROM $SCHEMA.staff_identity_subjects WHERE subject_id=NEW.new_subject_id;\n        IF NOT FOUND OR new_subject.realm_id<>h.realm_id OR new_subject.user_id_at_binding<>NEW.user_id OR new_subject.created_generation_id<>h.generation_id OR new_subject.created_registry_revision<>h.registry_revision THEN RAISE EXCEPTION 'historical subject cannot be rebound'; END IF;\n      END IF;\n      RETURN NEW;\n    END"
    },
    {
      "proname": "staff_identity_history_guard",
      "arguments": "",
      "returns": "trigger",
      "lanname": "plpgsql",
      "prokind": "f",
      "prosecdef": false,
      "provolatile": "v",
      "proisstrict": false,
      "proleakproof": false,
      "proparallel": "u",
      "proconfig": [
        "search_path=pg_catalog, $SCHEMA"
      ],
      "prosrc": "BEGIN RAISE EXCEPTION 'staff identity history is immutable'; END"
    },
    {
      "proname": "staff_identity_state_guard",
      "arguments": "",
      "returns": "trigger",
      "lanname": "plpgsql",
      "prokind": "f",
      "prosecdef": false,
      "provolatile": "v",
      "proisstrict": false,
      "proleakproof": false,
      "proparallel": "u",
      "proconfig": [
        "search_path=pg_catalog, $SCHEMA"
      ],
      "prosrc": "\nDECLARE g RECORD; c RECORD; b RECORD;\nBEGIN\n IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'staff identity state cannot be removed'; END IF;\n SELECT * INTO g FROM $SCHEMA.staff_identity_generations WHERE generation_id=NEW.generation_id;\n IF NOT FOUND OR g.realm_id<>NEW.realm_id THEN RAISE EXCEPTION 'identity generation mismatch'; END IF;\n IF TG_OP='INSERT' THEN\n  IF NEW.status<>'quarantined' OR NEW.registry_revision<>1 OR g.previous_generation_id IS NOT NULL OR g.reason<>'initialize' THEN RAISE EXCEPTION 'v2 initialization remains quarantined'; END IF;\n ELSIF OLD.status='ready' THEN\n  RAISE EXCEPTION 'ready identity mutation requires a separately reviewed lifecycle';\n ELSIF NEW.status='ready' THEN\n  IF NEW.realm_id<>OLD.realm_id OR NEW.generation_id<>OLD.generation_id OR NEW.registry_revision<>OLD.registry_revision THEN RAISE EXCEPTION 'ready seal cannot mutate identity history'; END IF;\n  SELECT * INTO c FROM $SCHEMA.staff_authority_control WHERE singleton FOR SHARE;\n  IF NOT FOUND OR c.state<>'active' OR c.realm_id<>NEW.realm_id::text OR c.binding_epoch IS DISTINCT FROM NEW.ready_control_epoch THEN RAISE EXCEPTION 'ready seal requires exact active control'; END IF;\n  SELECT * INTO b FROM $SCHEMA.staff_identity_current WHERE user_id=c.owner_user_id;\n  IF NOT FOUND OR b.subject_id IS DISTINCT FROM NEW.ready_owner_subject_id THEN RAISE EXCEPTION 'ready owner incarnation mismatch'; END IF;\n  IF EXISTS(SELECT 1 FROM $SCHEMA.users u LEFT JOIN $SCHEMA.staff_identity_current i ON i.user_id=u.id WHERE u.authorization_mode<>'canonical' OR i.user_id IS NULL) THEN RAISE EXCEPTION 'ready seal requires complete canonical account bindings'; END IF;\n ELSIF NEW.status='quarantined' THEN\n  IF NEW.realm_id<>OLD.realm_id OR NEW.registry_revision<>OLD.registry_revision+1 THEN RAISE EXCEPTION 'invalid identity state revision'; END IF;\n  IF NEW.generation_id<>OLD.generation_id AND g.previous_generation_id IS DISTINCT FROM OLD.generation_id THEN RAISE EXCEPTION 'invalid identity generation chain'; END IF;\n ELSE\n  RAISE EXCEPTION 'unsupported identity state';\n END IF;\n RETURN NEW;\nEND\n"
    },
    {
      "proname": "staff_identity_subject_guard",
      "arguments": "",
      "returns": "trigger",
      "lanname": "plpgsql",
      "prokind": "f",
      "prosecdef": false,
      "provolatile": "v",
      "proisstrict": false,
      "proleakproof": false,
      "proparallel": "u",
      "proconfig": [
        "search_path=pg_catalog, $SCHEMA"
      ],
      "prosrc": "DECLARE h RECORD; BEGIN\n      SELECT * INTO h FROM $SCHEMA.staff_identity_state WHERE singleton FOR SHARE;\n      IF NOT FOUND OR h.status<>'quarantined' OR NEW.realm_id<>h.realm_id OR NEW.created_generation_id<>h.generation_id OR NEW.created_registry_revision<>h.registry_revision THEN RAISE EXCEPTION 'invalid subject provenance'; END IF;\n      RETURN NEW;\n    END"
    }
  ]
});
