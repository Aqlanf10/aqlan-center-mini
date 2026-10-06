"""Synthetic in-memory evidence only: no app, registry, database or network."""
import copy
from pathlib import Path
import json
import sys

CI_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(CI_ROOT))
import evidence
import workflow


def configuration():
    return json.loads((CI_ROOT / 'contract.json').read_text())


def graph():
    return json.loads((CI_ROOT / 'workflow.json').read_text())


def identity():
    return {
        'CI_EVENT_NAME': 'pull_request', 'CI_EVENT_SHA': 'a' * 40,
        'CI_SOURCE_HEAD_SHA': 'b' * 40, 'CI_SOURCE_BASE_SHA': 'c' * 40,
        'CI_WORKFLOW_REF': 'Aqlanf10/aqlan-center-mini/.github/workflows/ci.yml@refs/pull/1/merge',
        'CI_WORKFLOW_SHA': 'a' * 40, 'CI_RUN_ID': '123', 'CI_RUN_ATTEMPT': '1',
        'CI_REPOSITORY': 'Aqlanf10/aqlan-center-mini', 'CI_REF': 'refs/pull/1/merge',
        'treeSha': 'd' * 40, 'workflowBlob': 'e' * 40,
        'packageSha256': '1' * 64, 'lockSha256': '2' * 64,
        'contractSha256': '3' * 64, 'evidenceVerifierSha256': '4' * 64}


def needs():
    return {lane: {'result': 'success', 'outputs': {'receipt_id': str(n + 100), 'receipt_digest': 'a' * 64}}
            for n, lane in enumerate(evidence.LANES)}


def steps(lane):
    return {name: {'outcome': 'success', 'conclusion': 'success', 'outputs': {}}
            for name in configuration()['mandatoryStepIds'][lane]}


def payload(path):
    if path.endswith('.png'):
        return b'\x89PNG\r\n\x1a\n' + b'\x00\x00\x00\x0dIHDR' + b'\x00\x00\x00\x01' * 2 + b'\x08\x02\x00\x00\x00' + b'\x00' * 4
    if path.endswith('.pdf'):
        return b'%PDF-1.4\nsynthetic fixture\n%%EOF\n'
    if path.endswith('.stderr.txt'):
        return b''
    return b'{"synthetic":true}\n'


def family(spec, ident=None):
    ident = ident or identity()
    paths = [path for path in spec['paths'] if not ('-attempt-2.' in path or '-attempt-3.' in path)]
    raw = {path: payload(path) for path in paths}
    if spec['semanticName'] in ('scoped-dependency-audit', 'scoped-build-install-audit'):
        proof = {'format': 'aqlan-scoped-braces-exception-v1', 'packageSha256': ident['packageSha256'],
                 'lockSha256': ident['lockSha256'], 'official': {'synthetic': True}}
        for mode, field in [('full', 'rawFullAuditSha256'), ('production', 'rawProductionAuditSha256')]:
            prefix = f'.dependency-audit/{mode}-attempt-1'
            raw[prefix + '.json'] = json.dumps({'auditReportVersion': 2, 'metadata': {
                'vulnerabilities': {'total': 0 if mode == 'production' else 1}}}).encode()
            raw[prefix + '.process.json'] = json.dumps({'registry': 'https://registry.npmjs.org',
                'checkedAt': '2026-10-06T00:00:00+00:00', 'code': 0 if mode == 'production' else 1,
                'error': None, 'signal': None}).encode()
            proof[field] = evidence.digest(raw[prefix + '.json'])
        raw['.dependency-audit/exception-proof.json'] = json.dumps(proof).encode()
    elif spec['semanticName'] == 'braces-runtime-absence':
        raw['.dependency-audit/runtime-proof.json'] = json.dumps({
            'format': 'aqlan-braces-runtime-absence-v1', 'packageSha256': ident['packageSha256'],
            'lockSha256': ident['lockSha256'], 'files': {'synthetic': 'a' * 64}, 'buildId': 'fixture'}).encode()
    mapping = evidence.archive_members(spec, list(raw))
    manifest = [{'sourcePath': path, 'archivePath': mapping[path], 'size': len(data), 'sha256': evidence.digest(data)}
                for path, data in raw.items()]
    return manifest, {mapping[path]: data for path, data in raw.items()}


def receipt(lane):
    config = configuration()
    ident = identity()
    recorded = steps(lane)
    artifacts = {}
    for index, (name, spec) in enumerate(config['artifacts'].items()):
        if spec['lane'] != lane or not spec['releaseRequired']:
            continue
        members, _ = family(spec, ident)
        recorded[spec['uploadStep']]['outputs'] = {'artifact-id': str(index + 1000), 'artifact-digest': 'b' * 64}
        artifacts[name] = {'id': str(index + 1000), 'digest': 'b' * 64,
                           'name': evidence.physical_name(name, ident), 'members': members}
    return {'format': 'aqlan-ci-lane-v1', 'lane': lane, 'identity': ident,
            'startedAt': '2026-10-06T00:00:00+00:00', 'sealedAt': '2026-10-06T00:10:00+00:00',
            'nodeVersion': 'v22.20.0', 'npmVersion': '11.6.0', 'hostname': lane,
            'postgresContainer': lane if lane in ('build_http', 'postgres_schema_journeys') else '',
            'steps': recorded, 'artifacts': artifacts}
