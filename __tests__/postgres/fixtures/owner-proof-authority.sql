-- Fixture for a separate, empty PostgreSQL authority. Test service logins may
-- inherit their issuer or redeemer role only. The custodian has no login.
BEGIN;
CREATE ROLE proof_issuer NOLOGIN;
CREATE ROLE proof_redeemer NOLOGIN;
CREATE ROLE proof_custodian NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE SCHEMA owner_proof AUTHORIZATION proof_custodian;
SET LOCAL ROLE proof_custodian;
REVOKE ALL ON SCHEMA owner_proof FROM PUBLIC, proof_issuer, proof_redeemer;

-- A digest is retired permanently at issuance, including when its invitation
-- expires, is superseded or is revoked. This table never contains the raw code.
CREATE TABLE owner_proof.used_digests (
  digest bytea PRIMARY KEY CHECK (pg_catalog.octet_length(digest) = 32)
);

CREATE TABLE owner_proof.scopes (
  clinic text COLLATE pg_catalog."C" NOT NULL,
  environment text COLLATE pg_catalog."C" NOT NULL,
  binding_version bigint NOT NULL DEFAULT 0 CHECK (binding_version >= 0),
  account_id integer CHECK (account_id > 0),
  credential_version text COLLATE pg_catalog."C",
  pending_digest bytea REFERENCES owner_proof.used_digests(digest),
  pending_account_id integer CHECK (pending_account_id > 0),
  pending_credential_version text COLLATE pg_catalog."C",
  expires_at timestamptz,
  PRIMARY KEY (clinic, environment),
  CHECK ((account_id IS NULL) = (credential_version IS NULL)),
  CHECK (account_id IS NULL OR pending_digest IS NULL),
  CHECK ((pending_digest IS NULL) = (pending_account_id IS NULL)
     AND (pending_digest IS NULL) = (pending_credential_version IS NULL)
     AND (pending_digest IS NULL) = (expires_at IS NULL))
);

-- account_id identifies the affected account. SESSION_USER identifies the actual
-- database login even in a SECURITY DEFINER function or after SET ROLE.
CREATE TABLE owner_proof.audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event text NOT NULL CHECK (event IN ('issue', 'redeem', 'revoke')),
  actor_principal name NOT NULL DEFAULT SESSION_USER,
  clinic text COLLATE pg_catalog."C" NOT NULL,
  environment text COLLATE pg_catalog."C" NOT NULL,
  account_id integer NOT NULL CHECK (account_id > 0),
  binding_version bigint NOT NULL CHECK (binding_version >= 0),
  occurred_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

CREATE FUNCTION owner_proof.valid_scope(clinic text, environment text)
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT
SET search_path = pg_catalog, pg_temp
RETURN pg_catalog.octet_length($1) BETWEEN 1 AND 64
   AND pg_catalog.octet_length($2) BETWEEN 1 AND 64
   AND $1 COLLATE pg_catalog."C" ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'
   AND $2 COLLATE pg_catalog."C" ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$';

CREATE FUNCTION owner_proof.valid_identity(clinic text, environment text, account_id integer, credential_version text)
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT
SET search_path = pg_catalog, pg_temp
RETURN owner_proof.valid_scope($1, $2) AND $3 > 0
   AND pg_catalog.octet_length($4) BETWEEN 1 AND 128
   AND $4 COLLATE pg_catalog."C" ~ '^[A-Za-z0-9_-]+$';

CREATE FUNCTION owner_proof.issue(clinic text, environment text, account_id integer,
                                   credential_version text, digest bytea, ttl_seconds integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  bound_account integer;
  version_at_issue bigint;
BEGIN
  IF (owner_proof.valid_identity($1, $2, $3, $4) AND pg_catalog.octet_length($5) = 32
      AND $6 BETWEEN 1 AND 60) IS NOT TRUE THEN RETURN false; END IF;

  -- Serialize issuers even on the very first invitation, when there is no
  -- scope row to lock yet. A hash collision only serializes unrelated issuers.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext($1), pg_catalog.hashtext($2));
  SELECT s.account_id INTO bound_account FROM owner_proof.scopes AS s
    WHERE s.clinic = $1 AND s.environment = $2 FOR UPDATE;
  IF bound_account IS NOT NULL THEN RETURN false; END IF;

  INSERT INTO owner_proof.used_digests VALUES ($5) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO owner_proof.scopes AS s
    (clinic, environment, pending_digest, pending_account_id, pending_credential_version, expires_at)
  VALUES ($1, $2, $5, $3, $4, pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => $6))
  ON CONFLICT ON CONSTRAINT scopes_pkey DO UPDATE
    SET pending_digest = excluded.pending_digest,
        pending_account_id = excluded.pending_account_id,
        pending_credential_version = excluded.pending_credential_version,
        expires_at = excluded.expires_at
  RETURNING s.binding_version INTO version_at_issue;
  INSERT INTO owner_proof.audit (event, clinic, environment, account_id, binding_version)
    VALUES ('issue', $1, $2, $3, version_at_issue);
  RETURN true;
END;
$function$;

CREATE FUNCTION owner_proof.redeem(clinic text, environment text, account_id integer,
                                    credential_version text, code bytea)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  invitation owner_proof.scopes%ROWTYPE;
  new_version bigint;
BEGIN
  IF (owner_proof.valid_identity($1, $2, $3, $4)
      AND pg_catalog.octet_length($5) = 32) IS NOT TRUE THEN RETURN false; END IF;

  SELECT s.* INTO invitation FROM owner_proof.scopes AS s
    WHERE s.clinic = $1 AND s.environment = $2 FOR UPDATE;
  -- Check wall-clock time *after* any wait for the row. The transaction start
  -- time would allow an invitation to be redeemed after its true deadline.
  IF NOT FOUND OR invitation.pending_digest IS NULL
      OR invitation.expires_at <= pg_catalog.clock_timestamp()
      OR invitation.pending_account_id <> $3
      OR invitation.pending_credential_version <> $4 COLLATE pg_catalog."C"
      OR invitation.pending_digest <> pg_catalog.sha256($5) THEN RETURN false; END IF;

  UPDATE owner_proof.scopes AS s
    SET account_id = $3, credential_version = $4, binding_version = s.binding_version + 1,
        pending_digest = NULL, pending_account_id = NULL, pending_credential_version = NULL, expires_at = NULL
    WHERE s.clinic = $1 AND s.environment = $2
    RETURNING s.binding_version INTO new_version;
  INSERT INTO owner_proof.audit (event, clinic, environment, account_id, binding_version)
    VALUES ('redeem', $1, $2, $3, new_version);
  RETURN true;
END;
$function$;

CREATE FUNCTION owner_proof.current_binding(clinic text, environment text, account_id integer, credential_version text)
RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
RETURN (
  SELECT s.binding_version FROM owner_proof.scopes AS s
  WHERE owner_proof.valid_identity($1, $2, $3, $4)
    AND pg_catalog.current_setting('transaction_isolation') = 'read committed'
    AND s.clinic = $1 AND s.environment = $2 AND s.account_id = $3 AND s.credential_version = $4
);

CREATE FUNCTION owner_proof.revoke_binding(clinic text, environment text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  affected_account integer;
  new_version bigint;
BEGIN
  IF owner_proof.valid_scope($1, $2) IS NOT TRUE THEN RETURN false; END IF;
  SELECT coalesce(s.account_id, s.pending_account_id) INTO affected_account FROM owner_proof.scopes AS s
    WHERE s.clinic = $1 AND s.environment = $2 FOR UPDATE;
  IF affected_account IS NULL THEN RETURN false; END IF;

  UPDATE owner_proof.scopes AS s
    SET account_id = NULL, credential_version = NULL, binding_version = s.binding_version + 1,
        pending_digest = NULL, pending_account_id = NULL, pending_credential_version = NULL, expires_at = NULL
    WHERE s.clinic = $1 AND s.environment = $2
    RETURNING s.binding_version INTO new_version;
  INSERT INTO owner_proof.audit (event, clinic, environment, account_id, binding_version)
    VALUES ('revoke', $1, $2, affected_account, new_version);
  RETURN true;
END;
$function$;

REVOKE ALL ON ALL TABLES IN SCHEMA owner_proof FROM PUBLIC, proof_issuer, proof_redeemer;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA owner_proof FROM PUBLIC, proof_issuer, proof_redeemer;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA owner_proof FROM PUBLIC, proof_issuer, proof_redeemer;
GRANT USAGE ON SCHEMA owner_proof TO proof_issuer, proof_redeemer;
GRANT EXECUTE ON FUNCTION owner_proof.issue(text,text,integer,text,bytea,integer),
                          owner_proof.revoke_binding(text,text) TO proof_issuer;
GRANT EXECUTE ON FUNCTION owner_proof.redeem(text,text,integer,text,bytea),
                          owner_proof.current_binding(text,text,integer,text) TO proof_redeemer;
COMMIT;
