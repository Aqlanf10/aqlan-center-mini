"""Exercise clean server restart and the native PG logical archive on synthetic rows.

No connection options are accepted. Starts a new loopback-only PG18 cluster in
a temporary directory, and uses only the temporary cluster/database/credentials.
"""
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import tempfile
import uuid

HERE = Path(__file__).resolve().parent
TOOLS = Path(os.environ.get("PG_BIN", "/usr/bin")).resolve()


def run(tool, *args, env, sql_input=None, fail=False):
    result = subprocess.run(
        [str(TOOLS / tool), *map(str, args)], input=sql_input, text=True,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, timeout=60,
    )
    if bool(result.returncode) != fail:
        raise RuntimeError(f"{tool}: unexpected exit ({result.returncode}): {result.stderr.strip()}")
    return result


def assert_same(actual, expected):
    if actual != expected:
        raise AssertionError(f"unexpected synthetic result: {actual!r} != {expected!r}")


def prove(directory):
    password = secrets.token_hex(20)
    pwfile = directory / "password"
    pwfile.write_text(password + "\n", encoding="ascii")
    pwfile.chmod(0o600)
    # Select a loopback port for this temporary isolated postmaster.
    with socket.socket(socket.AF_INET) as port_socket:
        port_socket.bind(("127.0.0.1", 0))
        port = port_socket.getsockname()[1]
    env = {
        "PATH": str(TOOLS) + ":/usr/bin:/bin", "HOME": str(directory), "LC_ALL": "C",
        "PGHOST": "127.0.0.1", "PGPORT": str(port), "PGUSER": "ci", "PGPASSWORD": password,
        "PGSSLMODE": "disable", "PGCONNECT_TIMEOUT": "3",
    }
    cluster, log = directory / "cluster", directory / "postmaster.log"
    version = run("postgres", "--version", env=env).stdout.split()[-1]
    if version.split(".")[0] != "18":
        raise RuntimeError("This proof requires PostgreSQL 18 command-line tools.")

    def start():
        run("pg_ctl", "-D", cluster, "-l", log, "-w",
            "-o", f"-h 127.0.0.1 -k '' -p {port}", "start", env=env)

    def stop():
        run("pg_ctl", "-D", cluster, "-m", "fast", "-w", "stop", env=env)

    def sql(database, statement, *, variables=None, denied_code=None):
        args = [f"--set={key}={val}" for key, val in (variables or {}).items()]
        result = run("psql", "-X", "-qAt", "--set=ON_ERROR_STOP=1", "--set=VERBOSITY=verbose",
                     "-d", database, *args, env=env, sql_input=statement, fail=denied_code is not None)
        if denied_code is not None and f" {denied_code}: " not in result.stderr:
            raise RuntimeError(f"Unexpected denial in the synthetic fixture: {result.stderr.strip()}")
        return result.stdout.strip()

    source = "aqlan_numbering_review_" + uuid.uuid4().hex
    target = "aqlan_numbering_review_" + uuid.uuid4().hex
    run("initdb", "-D", cluster, "-A", "scram-sha-256", "-U", "ci", "--pwfile", pwfile,
        "--no-locale", env=env)
    start()
    try:
        sql("postgres", f"""
          CREATE ROLE aqlan_numbering_data_owner NOLOGIN;
          CREATE ROLE aqlan_numbering_runtime NOLOGIN;
          CREATE ROLE aqlan_numbering_operator NOLOGIN;
          CREATE ROLE aqlan_numbering_app_fixture NOLOGIN;
          GRANT aqlan_numbering_runtime TO aqlan_numbering_app_fixture;
          CREATE DATABASE {source};
        """)
        sql(source, f"""
          GRANT CREATE ON DATABASE {source} TO aqlan_numbering_data_owner;
          GRANT CREATE ON SCHEMA public TO aqlan_numbering_data_owner;
          CREATE TABLE public.patients (
            id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            patient_number text NOT NULL UNIQUE,
            full_name text NOT NULL
          );
          CREATE SEQUENCE public.patient_number_seq;
          SELECT setval('public.patient_number_seq', 7000, false);
          INSERT INTO public.patients(patient_number, full_name) VALUES ('LEGACY-42', 'SYNTHETIC OLD');
          ALTER TABLE public.patients OWNER TO aqlan_numbering_data_owner;
          ALTER SEQUENCE public.patient_number_seq OWNER TO aqlan_numbering_data_owner;
          GRANT USAGE,UPDATE,SELECT ON SEQUENCE public.patient_number_seq TO aqlan_numbering_runtime;
          GRANT SELECT,INSERT,UPDATE ON public.patients TO aqlan_numbering_runtime;
        """)
        for script in ("patient-numbering-fence.pg18.sql", "patient-numbering-recovery.pg18.sql"):
            sql(source, (HERE / script).read_text(encoding="utf8"))

        operator = "SET SESSION AUTHORIZATION aqlan_numbering_operator; "
        owner = "SET SESSION AUTHORIZATION aqlan_numbering_data_owner; "
        app = "SET SESSION AUTHORIZATION aqlan_numbering_app_fixture; "
        checkpoint = "SELECT phase,prefix,revision,last_value,is_called FROM numbering_review.inspect_checkpoint();"
        legacy = """INSERT INTO public.patients(patient_number, full_name) VALUES
          ('P-' || regexp_replace(lpad(nextval('patient_number_seq')::text, 20, '0'), '^0{1,15}', ''),
           'SYNTHETIC LEGACY') RETURNING patient_number;"""
        managed = """INSERT INTO public.patients(patient_number, full_name)
          VALUES (NULL, 'SYNTHETIC MANAGED') RETURNING patient_number;"""
        mapping = "SELECT id,patient_number FROM public.patients ORDER BY id;"

        # Actual postmaster stop/start. Pending sequence tuple and DB binding must survive.
        stop()
        start()
        assert_same(sql(source, operator + checkpoint), "LEGACY|P|1|7000|f")
        assert_same(sql(source, app + legacy), "P-07000")
        assert_same(sql(source, app + legacy), "P-07001")
        assert_same(sql(source, operator + "SELECT numbering_review.set_managed_policy(1,'R',170000);"), "2")
        assert_same(sql(source, app + "BEGIN;" + managed + "ROLLBACK;"), "R-170000")
        stop()
        start()
        assert_same(sql(source, operator + checkpoint), "MANAGED|R|2|170000|t")
        assert_same(sql(source, operator + "SELECT numbering_review.hold_issuance(2);"), "3")
        witness = json.loads(sql(source, owner + "SELECT numbering_review.capture_recovery_witness();"))

        # Real PostgreSQL logical dump and restore. Do not infer allocation from row maxima.
        archive = directory / "numbering-test.dump"
        run("pg_dump", "--format=custom", "--file", archive, source, env=env)
        sql("postgres", f"CREATE DATABASE {target};")
        run("pg_restore", "--exit-on-error", "--dbname", target, archive, env=env)
        assert_same(sql(target, operator + checkpoint), "RECOVERY_HOLD|R|3|170000|t")
        assert_same(sql(target, app + mapping), sql(source, app + mapping))
        sql(target, app + managed, denied_code="55000")
        target_binding = sql(target, owner + "SELECT numbering_review.local_database_binding();")
        resume = "SELECT numbering_review.resume_approved_fixture(:'witness'::jsonb, :'target_binding');"
        approval = {"witness": json.dumps(witness), "target_binding": target_binding}
        sql(target, operator + resume, variables=approval, denied_code="42501")
        sql(target, owner + resume, variables={**approval, "target_binding": witness["binding"]}, denied_code="55000")
        assert_same(sql(target, owner + resume, variables=approval), "4")
        stop()
        start()
        assert_same(sql(target, operator + checkpoint), "MANAGED|R|4|170000|t")
        assert_same(sql(target, app + managed), "R-170001")
        sql(source, app + managed, denied_code="55000")
        sql(target, app + legacy, denied_code="42501")
        print(f"PASS PostgreSQL {version}: actual restarts, native archive restore, targeted fixture recovery and no reuse")
    finally:
        if (cluster / "postmaster.pid").is_file():
            stop()


if __name__ == "__main__":
    if len(sys.argv) != 1:
        raise SystemExit("This script accepts no database or connection parameters.")
    with tempfile.TemporaryDirectory(prefix="aqlan-numbering-restart-") as folder:
        prove(Path(folder))
