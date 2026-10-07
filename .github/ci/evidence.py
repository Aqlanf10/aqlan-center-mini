#!/usr/bin/env python3
"""Bounded, dependency-free CI receipts and fail-closed artifact verification.

No release bypass, fixture mode, offline success, or Production configuration.
Tests call pure validators with synthetic values; the gate CLI always uses the
current run's immutable artifact IDs and verifies downloaded ZIP bytes itself.
"""
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import socket
import stat
import subprocess
import sys
from datetime import datetime, timezone
from urllib.request import Request, build_opener, HTTPRedirectHandler
from urllib.error import HTTPError
from urllib.parse import urlparse
import zipfile

ROOT = Path(__file__).resolve().parents[2]
LANES = ('security_early', 'static_quality', 'postgres_schema_journeys', 'build_http')
MAX_JSON = 2 * 1024 * 1024
MAX_ZIP = 128 * 1024 * 1024
MAX_MEMBER = 64 * 1024 * 1024
SHA = re.compile(r'^[0-9a-f]{40}$')
SHA256 = re.compile(r'^[0-9a-f]{64}$')
ENV_KEYS = ('CI_EVENT_NAME', 'CI_EVENT_SHA', 'CI_SOURCE_HEAD_SHA', 'CI_SOURCE_BASE_SHA',
            'CI_WORKFLOW_REF', 'CI_WORKFLOW_SHA', 'CI_RUN_ID', 'CI_RUN_ATTEMPT',
            'CI_REPOSITORY', 'CI_REF')


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def no_duplicates(pairs):
    value = {}
    for key, item in pairs:
        require(key not in value, f'duplicate JSON key: {key}')
        value[key] = item
    return value


def decode_json(data, limit=MAX_JSON):
    require(isinstance(data, (str, bytes)) and len(data) <= limit, 'missing/oversized JSON')
    return json.loads(data, object_pairs_hook=no_duplicates,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError('nonfinite JSON')))


def contract():
    return decode_json((ROOT / '.github/ci/contract.json').read_bytes())


def git(*args):
    result = subprocess.run(['git', *args], cwd=ROOT, capture_output=True, check=False)
    require(result.returncode == 0, 'git identity or tracked-source integrity check failed')
    return result.stdout.decode().strip()


def version(command):
    result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, check=False)
    require(result.returncode == 0, 'required tool identity unavailable')
    return result.stdout.strip()


def context(env):
    data = {key: env.get(key, '') for key in ENV_KEYS}
    require(all(isinstance(value, str) and value for value in data.values()), 'incomplete event identity')
    require(data['CI_EVENT_NAME'] in ('push', 'pull_request', 'workflow_dispatch'), 'unsupported event')
    for key in ('CI_EVENT_SHA', 'CI_SOURCE_HEAD_SHA', 'CI_SOURCE_BASE_SHA', 'CI_WORKFLOW_SHA'):
        require(SHA.fullmatch(data[key]), f'invalid {key}')
    for key in ('CI_RUN_ID', 'CI_RUN_ATTEMPT'):
        require(re.fullmatch(r'[1-9][0-9]*', data[key]), f'invalid {key}')
    require(data['CI_REPOSITORY'] == 'Aqlanf10/aqlan-center-mini', 'unexpected repository')
    require(data['CI_WORKFLOW_REF'].startswith(data['CI_REPOSITORY'] + '/.github/workflows/ci.yml@'),
            'unexpected workflow identity')
    if data['CI_EVENT_NAME'] == 'pull_request':
        require(re.fullmatch(r'refs/pull/[1-9][0-9]*/merge', data['CI_REF']), 'PR must test event merge ref')
    elif data['CI_EVENT_NAME'] == 'push':
        require(data['CI_SOURCE_HEAD_SHA'] == data['CI_EVENT_SHA'], 'push head mismatch')
    return data


def source_identity(env):
    data = context(env)
    require(not (ROOT / '.env.local').exists(), 'local environment file forbidden in clean CI')
    require(git('rev-parse', 'HEAD') == data['CI_EVENT_SHA'], 'checkout differs from immutable event SHA')
    git('diff', '--no-ext-diff', '--exit-code', 'HEAD', '--')
    data['treeSha'] = git('rev-parse', 'HEAD^{tree}')
    data['workflowBlob'] = git('rev-parse', 'HEAD:.github/workflows/ci.yml')
    data['packageSha256'] = digest((ROOT / 'package.json').read_bytes())
    data['lockSha256'] = digest((ROOT / 'package-lock.json').read_bytes())
    data['contractSha256'] = digest((ROOT / '.github/ci/contract.json').read_bytes())
    data['evidenceVerifierSha256'] = digest(Path(__file__).read_bytes())
    return data


def physical_name(semantic, identity):
    return f"{semantic}--{identity['CI_RUN_ID']}-{identity['CI_RUN_ATTEMPT']}-{identity['CI_EVENT_SHA']}"


def artifact_output(step):
    require(isinstance(step, dict) and step.get('outcome') == 'success'
            and step.get('conclusion') == 'success', 'artifact uploader was not successful')
    output = step.get('outputs', {})
    artifact_id = output.get('artifact-id', '')
    artifact_digest = output.get('artifact-digest', '')
    require(isinstance(artifact_id, str) and re.fullmatch(r'[1-9][0-9]*', artifact_id), 'missing artifact ID')
    require(isinstance(artifact_digest, str) and SHA256.fullmatch(artifact_digest), 'missing artifact digest')
    return {'id': artifact_id, 'digest': artifact_digest}


def validate_steps(steps, expected):
    require(isinstance(steps, dict), 'missing steps')
    require(set(steps) == set(expected), 'missing, extra or skipped mandatory step receipt')
    for step_id in expected:
        step = steps[step_id]
        require(isinstance(step, dict) and step.get('outcome') == 'success'
                and step.get('conclusion') == 'success', f'mandatory step did not succeed: {step_id}')


BOOTSTRAP_IDS = tuple(f'baseline_{number:02d}' for number in range(1, 6))
SERVICE_LANES = ('postgres_schema_journeys', 'build_http')
RUNNER_PRELUDE_ID = re.compile(r'^[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}$')


def validate_bootstrap_snapshot(snapshot, lane):
    """Bounded native container prelude, observed before lane-specific audit/test/build work.

    Runner v2.337.0 JobExtension creates one Initialize containers pre-job step
    with a Guid.ToString("N") context for these exact hosted-service jobs. This
    is not a regex-only exception to mandatory-step validation: the full early
    snapshot is persisted and must remain byte-structurally equal at sealing.
    """
    require(lane in LANES and isinstance(snapshot, dict), 'invalid bootstrap context')
    declared = {key: snapshot[key] for key in BOOTSTRAP_IDS if key in snapshot}
    validate_steps(declared, BOOTSTRAP_IDS)
    extra = set(snapshot) - set(BOOTSTRAP_IDS)
    require(len(extra) == (1 if lane in SERVICE_LANES else 0), 'unexpected native pre-job context count')
    prelude = {}
    for key in extra:
        require(isinstance(key, str) and RUNNER_PRELUDE_ID.fullmatch(key), 'unrecognized native pre-job identity')
        require(snapshot[key] == {'outputs': {}, 'outcome': 'success', 'conclusion': 'success'},
                'native container initialization must succeed without outputs or extra fields')
        prelude[key] = snapshot[key]
    return prelude


def reconcile_step_snapshot(current, bootstrap, expected, lane):
    prelude = validate_bootstrap_snapshot(bootstrap, lane)
    require(isinstance(current, dict) and set(BOOTSTRAP_IDS) <= set(expected), 'invalid complete step context')
    require(set(current) == set(expected) | set(prelude), 'missing or unexpected complete step context')
    require(all(current[key] == value for key, value in bootstrap.items()),
            'bootstrap or native pre-job context changed after initial capture')
    declared = {key: current[key] for key in expected}
    validate_steps(declared, expected)  # Preserve the original exact mandatory-set/outcome contract.
    return declared, {key: current[key] for key in prelude}


def validate_needs(needs):
    require(isinstance(needs, dict) and set(needs) == set(LANES), 'exact complete lane set required')
    for lane in LANES:
        require(isinstance(needs[lane], dict) and needs[lane].get('result') == 'success',
                f'lane not successful: {lane}')
        outputs = needs[lane].get('outputs', {})
        require(isinstance(outputs, dict) and set(outputs) == {'receipt_id', 'receipt_digest'},
                f'missing receipt outputs: {lane}')
        artifact_output({'outcome': 'success', 'conclusion': 'success', 'outputs': {
            'artifact-id': outputs['receipt_id'], 'artifact-digest': outputs['receipt_digest']}})


def safe_path(name):
    require(isinstance(name, str) and bool(name) and '\\' not in name and '\x00' not in name,
            'unsafe artifact path')
    path = PurePosixPath(name)
    require(not path.is_absolute() and all(p not in ('', '.', '..') for p in name.split('/')),
            'unsafe artifact path')
    require(not re.match(r'^[A-Za-z]:', name), 'unsafe drive path')
    return name


def read_regular(path):
    path = Path(path)
    for part in [path, *path.parents]:
        require(not part.is_symlink(), 'symlink in evidence path')
    info = path.stat()
    require(stat.S_ISREG(info.st_mode) and info.st_size <= MAX_MEMBER, 'invalid/oversized evidence member')
    return path.read_bytes()


def archive_members(spec, existing_paths):
    paths = spec['paths']
    require(len(paths) == len(set(paths)), 'duplicate catalog path')
    require(set(existing_paths) <= set(paths), 'unlisted artifact source path')
    if spec['requireEveryPath']:
        require(set(existing_paths) == set(paths), 'required individual member is missing')
    else:
        # Every executed audit attempt is a contiguous and complete triple.
        require(spec['semanticName'] in ('scoped-dependency-audit', 'scoped-build-install-audit'),
                'unexpected optional members')
        require('.dependency-audit/exception-proof.json' in existing_paths, 'missing exception proof')
        for mode in ('full', 'production'):
            observed = []
            for attempt in range(1, 4):
                prefix = f'.dependency-audit/{mode}-attempt-{attempt}'
                triple = {prefix + ext for ext in ('.json', '.stderr.txt', '.process.json')}
                present = triple & set(existing_paths)
                require(not present or present == triple, 'partial audit attempt triple')
                if present:
                    observed.append(attempt)
            require(observed and observed == list(range(1, max(observed) + 1)), 'missing/noncontiguous audit attempts')
    common = os.path.commonpath([str(Path(path).parent) for path in paths])
    result = {path: safe_path(os.path.relpath(path, common)) for path in existing_paths}
    require(len(set(result.values())) == len(result), 'archive basename collision')
    return result


def validate_content(path, data):
    require(isinstance(data, bytes) and len(data) <= MAX_MEMBER, 'invalid member bytes')
    if path.endswith('.stderr.txt') or re.search(r'/(?:full|production)-attempt-[1-3]\.json$', path):
        # Even empty/malformed failed retries are retained raw. The last attempt
        # is independently bound to a successful verifier and parsed below.
        return
    require(bool(data), 'empty required evidence member')
    if path.endswith('.png'):
        require(data[:8] == b'\x89PNG\r\n\x1a\n' and len(data) >= 33 and data[12:16] == b'IHDR'
                and int.from_bytes(data[16:20], 'big') > 0 and int.from_bytes(data[20:24], 'big') > 0,
                'invalid PNG evidence')
    elif path.endswith('.pdf'):
        require(data.startswith(b'%PDF-') and b'%%EOF' in data[-2048:], 'invalid PDF evidence')
    elif path.endswith('.json'):
        parsed = decode_json(data)
        require(isinstance(parsed, (dict, list)) and bool(parsed), 'empty/malformed JSON evidence')


def validate_audit(files, identity):
    proof = decode_json(files['.dependency-audit/exception-proof.json'])
    require(proof.get('format') == 'aqlan-scoped-braces-exception-v1', 'wrong audit proof format')
    require(proof.get('packageSha256') == identity['packageSha256']
            and proof.get('lockSha256') == identity['lockSha256'], 'audit proof installation identity mismatch')
    require(isinstance(proof.get('official'), dict) and proof['official'], 'missing live official evidence')
    for mode, field in [('full', 'rawFullAuditSha256'), ('production', 'rawProductionAuditSha256')]:
        attempts = sorted(int(re.search(r'attempt-(\d)', path)[1]) for path in files
                          if re.fullmatch(rf'\.dependency-audit/{mode}-attempt-[1-3]\.json', path))
        require(attempts, 'missing raw audit')
        last = f'.dependency-audit/{mode}-attempt-{attempts[-1]}'
        require(digest(files[last + '.json']) == proof.get(field), 'raw audit/proof digest mismatch')
        parsed = decode_json(files[last + '.json'], MAX_MEMBER)
        require(isinstance(parsed, dict) and parsed.get('auditReportVersion') == 2, 'invalid terminal audit JSON')
        if mode == 'production':
            require(parsed.get('metadata', {}).get('vulnerabilities', {}).get('total') == 0,
                    'production audit requires zero total vulnerabilities')
        for attempt in attempts:
            process = decode_json(files[f'.dependency-audit/{mode}-attempt-{attempt}.process.json'])
            require(process.get('registry') == 'https://registry.npmjs.org', 'unofficial raw audit')
            require(isinstance(process.get('checkedAt'), str), 'missing raw process timestamp')
        process = decode_json(files[last + '.process.json'])
        require(process.get('signal') is None and process.get('error') is None
                and type(process.get('code')) is int and process['code'] in ([0] if mode == 'production' else [0, 1]),
                'terminal audit process failed')


def validate_family(spec, members, files, identity):
    require(isinstance(members, list) and all(isinstance(m, dict) for m in members), 'invalid member manifest')
    source_paths = [m.get('sourcePath') for m in members]
    require(len(source_paths) == len(set(source_paths)), 'duplicate source manifest member')
    mapping = archive_members(spec, source_paths)
    require(set(files) == set(mapping.values()), 'downloaded artifact member set mismatch')
    original = {}
    for member in members:
        source = member['sourcePath']
        require(set(member) == {'sourcePath', 'archivePath', 'size', 'sha256'}, 'unknown member manifest fields')
        require(member['archivePath'] == mapping[source], 'archive path mismatch')
        data = files[mapping[source]]
        require(type(member['size']) is int and member['size'] == len(data)
                and member['sha256'] == digest(data), 'artifact bytes changed or are stale')
        validate_content(source, data)
        original[source] = data
    if spec['semanticName'] in ('scoped-dependency-audit', 'scoped-build-install-audit'):
        validate_audit(original, identity)
    elif spec['semanticName'] == 'braces-runtime-absence':
        proof = decode_json(original['.dependency-audit/runtime-proof.json'])
        require(proof.get('format') == 'aqlan-braces-runtime-absence-v1'
                and proof.get('packageSha256') == identity['packageSha256']
                and proof.get('lockSha256') == identity['lockSha256']
                and isinstance(proof.get('files'), dict) and proof['files']
                and isinstance(proof.get('buildId'), str) and proof['buildId'], 'invalid same-build runtime proof')


def zip_members(data, expected_digest):
    require(SHA256.fullmatch(expected_digest or '') and digest(data) == expected_digest, 'ZIP digest mismatch')
    require(len(data) <= MAX_ZIP, 'oversized ZIP')
    files = {}
    names = set()
    total = 0
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        require(len(archive.infolist()) <= 1000, 'excessive ZIP members')
        for entry in archive.infolist():
            name = entry.filename.rstrip('/') if entry.is_dir() else entry.filename
            safe_path(name)
            require(name.casefold() not in names, 'duplicate/case-colliding ZIP path')
            names.add(name.casefold())
            mode = entry.external_attr >> 16
            require(not stat.S_ISLNK(mode) and not (entry.flag_bits & 1), 'symlink/encrypted ZIP member')
            require(stat.S_IFMT(mode) in (0, stat.S_IFREG, stat.S_IFDIR), 'special ZIP member')
            if entry.is_dir():
                continue
            total += entry.file_size
            require(entry.file_size <= MAX_MEMBER and total <= MAX_ZIP, 'excessive uncompressed artifact bytes')
            files[name] = archive.read(entry)  # CRC verified by zipfile; no filesystem extraction.
    return files


def validate_metadata(meta, artifact_id, expected_name, expected_digest, identity):
    require(isinstance(meta, dict) and type(meta.get('id')) is int and str(meta['id']) == artifact_id,
            'artifact metadata ID mismatch')
    require(meta.get('name') == expected_name and meta.get('expired') is False, 'missing/expired/stale artifact')
    require(meta.get('digest') == 'sha256:' + expected_digest, 'server artifact digest mismatch')
    run = meta.get('workflow_run', {})
    require(type(run.get('id')) is int and str(run['id']) == identity['CI_RUN_ID']
            and run.get('head_sha') == identity['CI_SOURCE_HEAD_SHA'], 'cross-run or cross-head artifact')
    require(type(meta.get('size_in_bytes')) is int and 0 < meta['size_in_bytes'] <= MAX_ZIP,
            'invalid artifact size')


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def http_bytes(url, token=None, max_bytes=MAX_JSON, redirect=False):
    require(urlparse(url).scheme == 'https', 'insecure artifact endpoint')
    headers = {'User-Agent': 'aqlan-ci-evidence-v1', 'Accept': 'application/vnd.github+json',
               'X-GitHub-Api-Version': '2022-11-28'}
    if token:
        require(url.startswith('https://api.github.com/'), 'token target is not official API')
        headers['Authorization'] = 'Bearer ' + token
    try:
        with build_opener(NoRedirect()).open(Request(url, headers=headers), timeout=60) as response:
            require(response.status == 200, 'artifact HTTP status was not success')
            data = response.read(max_bytes + 1)
            require(len(data) <= max_bytes, 'artifact response exceeded bound')
            if max_bytes == MAX_JSON:
                require('application/json' in response.headers.get('Content-Type', ''), 'artifact metadata not JSON')
            return data
    except HTTPError as error:
        if redirect and error.code in (301, 302, 303, 307, 308):
            location = error.headers.get('Location', '')
            require(urlparse(location).scheme == 'https' and bool(urlparse(location).hostname),
                    'invalid artifact redirect')
            # A signed storage URL never receives GitHub's token.
            return http_bytes(location, token=None, max_bytes=max_bytes, redirect=False)
        raise ValueError(f'artifact HTTP request failed ({error.code})') from None


def fetch_artifact(artifact_id, expected_name, expected_digest, identity):
    require(re.fullmatch(r'[1-9][0-9]*', artifact_id or ''), 'invalid artifact ID')
    token = os.environ.get('GH_TOKEN', '')
    require(bool(token), 'current-workflow artifact access unavailable')
    url = f"https://api.github.com/repos/{identity['CI_REPOSITORY']}/actions/artifacts/{artifact_id}"
    meta = decode_json(http_bytes(url, token))
    validate_metadata(meta, artifact_id, expected_name, expected_digest, identity)
    data = http_bytes(url + '/zip', token, max_bytes=MAX_ZIP, redirect=True)
    require(len(data) == meta['size_in_bytes'], 'artifact ZIP size mismatch')
    return zip_members(data, expected_digest)


def validate_receipt(receipt, lane, identity, configuration):
    require(isinstance(receipt, dict) and set(receipt) == {
        'format', 'lane', 'identity', 'startedAt', 'sealedAt', 'nodeVersion', 'npmVersion',
        'hostname', 'postgresContainer', 'bootstrapSteps', 'sealSteps', 'runnerPreludeSteps', 'steps', 'artifacts'}, 'invalid receipt schema')
    require(receipt['format'] == 'aqlan-ci-lane-v2' and receipt['lane'] == lane
            and receipt['identity'] == identity, 'cross-commit, lane, event, attempt or workflow receipt')
    require(re.fullmatch(r'v22\.[0-9]+\.[0-9]+', receipt['nodeVersion'] or '')
            and re.fullmatch(r'11\.[0-9]+\.[0-9]+', receipt['npmVersion'] or ''), 'tool contract mismatch')
    start = datetime.fromisoformat(receipt['startedAt'])
    end = datetime.fromisoformat(receipt['sealedAt'])
    require(start.tzinfo and end.tzinfo and start <= end, 'invalid receipt time interval')
    validate_steps(receipt['steps'], configuration['mandatoryStepIds'][lane])
    declared, prelude = reconcile_step_snapshot(receipt['sealSteps'], receipt['bootstrapSteps'],
                                               configuration['mandatoryStepIds'][lane], lane)
    require(receipt['steps'] == declared and receipt['runnerPreludeSteps'] == prelude,
            'receipt differs from full unfiltered initial/seal snapshots')
    expected = {name for name, spec in configuration['artifacts'].items()
                if spec['lane'] == lane and spec['releaseRequired']}
    require(isinstance(receipt['artifacts'], dict) and set(receipt['artifacts']) == expected,
            'missing or extra artifact family')
    for name in expected:
        item = receipt['artifacts'][name]
        require(isinstance(item, dict) and set(item) == {'id', 'digest', 'name', 'members'}, 'invalid artifact receipt')
        require(item['name'] == physical_name(name, identity), 'stale/non-attempt-bound artifact name')
        recorded = artifact_output(receipt['steps'][configuration['artifacts'][name]['uploadStep']])
        require(recorded == {'id': item['id'], 'digest': item['digest']}, 'artifact upload receipt mismatch')


def init():
    lane = os.environ.get('CI_LANE')
    require(lane in LANES, 'unknown lane')
    for path in ('.ci-evidence', '.next', '.preflight', '.dependency-audit', '.settings-ui-artifacts',
                 '.sec-http-state.json', '.sec-http-storage'):
        require(not (ROOT / path).exists(), 'stale output present before mandatory work')
    identity = source_identity(os.environ)
    bootstrap = decode_json(os.environ.get('CI_BOOTSTRAP_STEPS_JSON', ''))
    validate_bootstrap_snapshot(bootstrap, lane)
    receipt = {'identity': identity, 'bootstrapSteps': bootstrap, 'startedAt': datetime.now(timezone.utc).isoformat(),
               'nodeVersion': version(['node', '--version']), 'npmVersion': version(['npm', '--version']),
               'hostname': socket.gethostname(), 'postgresContainer': os.environ.get('CI_POSTGRES_CONTAINER', '')}
    (ROOT / '.ci-evidence').mkdir()
    (ROOT / '.ci-evidence/initial.json').write_text(json.dumps(receipt, indent=2) + '\n')


def seal():
    configuration = contract()
    lane = os.environ.get('CI_LANE')
    require(lane in LANES, 'unknown lane')
    initial = decode_json((ROOT / '.ci-evidence/initial.json').read_bytes())
    identity = source_identity(os.environ)
    require(initial['identity'] == identity, 'source or identity changed during lane')
    current_steps = decode_json(os.environ.get('CI_STEPS_JSON', ''))
    steps, prelude = reconcile_step_snapshot(current_steps, initial['bootstrapSteps'],
                                            configuration['mandatoryStepIds'][lane], lane)
    artifacts = {}
    for name, spec in configuration['artifacts'].items():
        if spec['lane'] != lane or not spec['releaseRequired']:
            continue
        files = {}
        for path in spec['paths']:
            source = Path(path) if Path(path).is_absolute() else ROOT / path
            if source.exists() or source.is_symlink():
                files[path] = read_regular(source)
        mapping = archive_members(spec, list(files))
        members = [{'sourcePath': path, 'archivePath': mapping[path], 'size': len(data), 'sha256': digest(data)}
                   for path, data in sorted(files.items())]
        validate_family(spec, members, {mapping[path]: data for path, data in files.items()}, identity)
        artifacts[name] = {**artifact_output(steps[spec['uploadStep']]),
                           'name': physical_name(name, identity), 'members': members}
    receipt = {'format': 'aqlan-ci-lane-v2', 'lane': lane, **initial, 'runnerPreludeSteps': prelude, 'sealSteps': current_steps,
               'sealedAt': datetime.now(timezone.utc).isoformat(), 'steps': steps, 'artifacts': artifacts}
    validate_receipt(receipt, lane, identity, configuration)
    (ROOT / '.ci-evidence/receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')


def gate():
    from workflow import check_repository
    check_repository(ROOT)
    gate_steps = decode_json(os.environ.get('CI_GATE_STEPS_JSON', ''))
    validate_steps(gate_steps, ['checkout'])
    configuration = contract()
    identity = source_identity(os.environ)
    needs = decode_json(os.environ.get('CI_NEEDS_JSON', ''))
    validate_needs(needs)
    all_ids = set()
    receipts = {}
    family_count = member_count = 0
    for lane in LANES:
        output = needs[lane]['outputs']
        artifact_id = output['receipt_id']
        require(artifact_id not in all_ids, 'duplicate receipt artifact ID')
        all_ids.add(artifact_id)
        files = fetch_artifact(artifact_id, physical_name('ci-receipt-' + lane, identity),
                               output['receipt_digest'], identity)
        require(set(files) == {'receipt.json'}, 'receipt artifact contains unexpected members')
        receipt = decode_json(files['receipt.json'])
        validate_receipt(receipt, lane, identity, configuration)
        receipts[lane] = receipt
        for name, item in receipt['artifacts'].items():
            require(item['id'] not in all_ids, 'reused artifact ID across evidence families')
            all_ids.add(item['id'])
            data = fetch_artifact(item['id'], item['name'], item['digest'], identity)
            validate_family(configuration['artifacts'][name], item['members'], data, identity)
            family_count += 1
            member_count += len(data)
    pg = receipts['postgres_schema_journeys']
    http = receipts['build_http']
    require(pg['postgresContainer'] and http['postgresContainer']
            and pg['postgresContainer'] != http['postgresContainer']
            and pg['hostname'] and http['hostname'] and pg['hostname'] != http['hostname'],
            'PostgreSQL and HTTP must prove distinct service containers and hosted runners')
    print(f'PASS: all four exact-commit lanes, {family_count} required families, {member_count} members verified.')


if __name__ == '__main__':
    try:
        require(len(sys.argv) == 2 and sys.argv[1] in ('init', 'seal', 'gate'), 'expected init, seal or gate')
        {'init': init, 'seal': seal, 'gate': gate}[sys.argv[1]]()
    except Exception as error:
        # Do not print URLs, tokens, environment dumps, or signed download targets.
        print(f'CI evidence rejected: {type(error).__name__}: {str(error)[:240]}', file=sys.stderr)
        sys.exit(1)
