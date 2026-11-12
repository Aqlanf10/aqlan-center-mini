import hashlib
import json
import pathlib
import subprocess
import sys

root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
base = "f3ce7bbb7b22ea0a4800154b6a1d7dbe037bf2a0"

def old(path, revision=base):
    return subprocess.check_output(["git", "show", f"{revision}:{path}"], cwd=root).decode()

def current(path):
    return (root / path).read_text()

before, after = old("lib/db.ts"), current("lib/db.ts")
start = "export async function duplicateCephAnalysis("
end = "\n/**\n * قياس واحد على تحليل معتمد"
original = before.split(start, 1)[1].split(end, 1)[0]
body = "    // DATE يُقرأ نصًّا:" + original.split("    // DATE يُقرأ نصًّا:", 1)[1].split('    await client.query("COMMIT");', 1)[0]
body = body.replace('await client.query("ROLLBACK"); ', '').replace('      await client.query("ROLLBACK");\n', '')
extracted = "  // DATE يُقرأ نصًّا:" + after.split("export async function duplicateCephAnalysisInTransaction", 1)[1].split("  // DATE يُقرأ نصًّا:", 1)[1].split("  return { ok: true, id: newId };", 1)[0]
normalize = lambda text: "\n".join(line.strip() for line in text.strip().splitlines())
checks = {
    "exact_original_copy_body_without_transaction_controls": normalize(body) == normalize(extracted),
    "db_prefix_unchanged": before.split(start, 1)[0] == after.split("/** Original copy rules and SQL", 1)[0],
    "db_suffix_unchanged": before.split(end, 1)[1] == after.split(end, 1)[1],
}
route = "app/api/ceph/[id]/duplicate/route.ts"
checks["legacy_route_tail_identical"] = old(route).split("  const session = await requireSession();", 1)[1] == current(route).split("  const session = await requireSession();", 1)[1]
wrapper = after.split(start, 1)[1].split(end, 1)[0]
checks["legacy_post_commit_audit_and_unique_refusal_unchanged"] = original.split('    await client.query("COMMIT");', 1)[1].replace("String(newId)", "String(result.id)").replace("return { ok: true, id: newId };", "return result;") == wrapper.split('    await client.query("COMMIT");', 1)[1]
for path in ["lib/canonical-ceph-reads.ts", "lib/canonical-ceph-pair-reads.ts", "lib/canonical-ceph-projection.ts", "lib/staff-capability-catalogue.ts", "lib/canonical-record-reads.ts", "lib/commission.ts", "lib/canonical-patient-reads.ts", "lib/canonical-problem-create-command.ts", "lib/canonical-plan-dependency-command.ts", "components/PatientCeph.tsx", "components/CephTracer.tsx", "components/CephCompareView.tsx", "app/ceph/[id]/page.tsx", "app/print/ceph/[id]/page.tsx"]:
    checks[path] = old(path) == current(path)
runtime = old("lib/staff-operation-runtime.ts").replace('"clinical.visits.document"] as const', '"clinical.visits.document", "clinical.ceph.analyze"] as const').replace('"clinical.visits.document"]);', '"clinical.visits.document","clinical.ceph.analyze"]);')
checks["only_exact_analyze_action_added_to_runtime"] = runtime == current("lib/staff-operation-runtime.ts")
guard = old("scripts/audits/staff-cutover-readiness.test.mjs").replace("'clinical.visits.document']);", "'clinical.visits.document','clinical.ceph.analyze']);")
checks["only_exact_action_added_to_literal_guard"] = guard == current("scripts/audits/staff-cutover-readiness.test.mjs")
checks["immutable_migrations"] = not subprocess.check_output(["git", "diff", base, "--", "migrations"], cwd=root).strip()
assert all(checks.values()), checks
historical = 0
for manifest in (root / "docs/review/evidence").glob("**/manifest.json"):
    data = json.loads(manifest.read_text())
    revision = data.get("sourceRevision")
    if not revision:
        continue
    for path, expected in (data.get("sourceSha256") or data.get("sourceFilesSha256") or {}).items():
        actual = hashlib.sha256(subprocess.check_output(["git", "show", f"{revision}:{path}"], cwd=root)).hexdigest()
        assert actual == expected, (str(manifest), revision, path)
        historical += 1
print(json.dumps({"baseRevision": base, "checks": checks, "passed": len(checks), "historicalSourceHashes": historical}, indent=2))
