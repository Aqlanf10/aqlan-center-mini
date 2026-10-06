#!/usr/bin/env python3
"""Temporary isolated GitHub CI source proof; never invokes the clinic app.

This runner binds immutable candidate bytes and the unchanged clinical workflow,
then materializes only source needed for the new Python gate/contract tests.
"""
import copy
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
BUNDLE = ROOT / '.ci-proof/parallel-gates'
REPORTS = ROOT / '.ci-proof-results'
BASE = '5da6085f283e88c73305b789e6211946324c69f7'
BASE_TREE = '33dbc08d94158a8e87a5356b1881777e370e6d89'
ROOT_WORKFLOW_BLOB = '8c6c05b480ccf667be716bca44d9ca6c2ba00758'
CANDIDATE_MANIFEST_SHA256 = '194a3cfee6e03267dedd9c15565ad07605fffa14047a1a96d38278498500ce4e'
PROOF_REF = 'refs/heads/ci-proof/parallel-gates-20261006'
REPOSITORY = 'Aqlanf10/aqlan-center-mini'
REPORT_FILES = (
    'identity.json', 'candidate-bytes.json', 'inventory.json',
    'contract.stdout.txt', 'contract.stderr.txt', 'contract.process.json', 'contract-results.json',
    'unit.stdout.txt', 'unit.stderr.txt', 'unit.process.json', 'unit-results.json',
    'source-after.json', 'summary.json', 'steps-context.json')


def require(ok, message):
    if not ok:
        raise ValueError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def blob(data):
    return hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()


def now():
    return datetime.now(timezone.utc).isoformat()


def read_json(path):
    data = Path(path).read_bytes()
    require(len(data) <= 4 * 1024 * 1024, 'oversized proof input')
    return json.loads(data)


def write_report(name, value):
    require(name in REPORT_FILES, 'unlisted proof report')
    (REPORTS / name).write_text(json.dumps(value, indent=2, ensure_ascii=False) + '\n')


def git(*arguments):
    result = subprocess.run(['git', *arguments], cwd=ROOT, capture_output=True, check=False, timeout=60)
    require(result.returncode == 0, 'read-only Git source query failed')
    return result.stdout


def safe_relative(path):
    require(isinstance(path, str) and path and not path.startswith('/') and '\\' not in path
            and all(p not in ('', '.', '..') for p in path.split('/')), 'unsafe proof source path')
    return path


def file_bytes(path):
    require(path.is_file() and not path.is_symlink(), 'proof input is not a regular file')
    for parent in path.parents:
        require(not parent.is_symlink(), 'proof input traverses a symlink')
    data = path.read_bytes()
    require(len(data) <= 4 * 1024 * 1024, 'oversized proof source')
    return data


def verify_identity():
    require(os.environ.get('GITHUB_REPOSITORY') == REPOSITORY, 'unexpected proof repository')
    require(os.environ.get('GITHUB_EVENT_NAME') == 'push' and os.environ.get('GITHUB_REF') == PROOF_REF,
            'proof is limited to the explicit temporary push ref')
    head = os.environ.get('GITHUB_SHA', '')
    require(re.fullmatch(r'[0-9a-f]{40}', head), 'missing immutable event SHA')
    require(git('rev-parse', 'HEAD').decode().strip() == head, 'proof checkout differs from event SHA')
    parents = git('rev-list', '--parents', '-n', '1', 'HEAD').decode().split()
    require(parents == [head, BASE], 'proof commit must have exactly the reviewed clinical base as its parent')
    require(git('rev-parse', BASE + '^{tree}').decode().strip() == BASE_TREE, 'clinical base tree differs')
    require(git('rev-parse', 'HEAD:.github/workflows/ci.yml').decode().strip() == ROOT_WORKFLOW_BLOB,
            'active clinical release workflow was changed')
    git('diff', '--no-ext-diff', '--exit-code', 'HEAD', '--')
    for key in ('GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT'):
        require(re.fullmatch(r'[1-9][0-9]*', os.environ.get(key, '')), 'missing run or attempt identity')
    require(os.environ.get('GITHUB_JOB') == 'gate_contract_proof', 'unexpected proof job')
    identity = {'repository': REPOSITORY, 'event': 'push', 'ref': PROOF_REF, 'eventSha': head,
                'treeSha': git('rev-parse', 'HEAD^{tree}').decode().strip(), 'parentSha': BASE,
                'parentTreeSha': BASE_TREE, 'unchangedClinicalWorkflowBlob': ROOT_WORKFLOW_BLOB,
                'runId': os.environ['GITHUB_RUN_ID'], 'runAttempt': os.environ['GITHUB_RUN_ATTEMPT'],
                'jobId': os.environ['GITHUB_JOB'], 'pythonVersion': sys.version,
                'candidateManifestSha256': CANDIDATE_MANIFEST_SHA256, 'startedAt': now(),
                'scope': 'temporary source/contract proof, not clinic or release CI'}
    write_report('identity.json', identity)
    return identity


def verify_bundle():
    manifest_bytes = file_bytes(BUNDLE / 'candidate-manifest.json')
    require(sha(manifest_bytes) == CANDIDATE_MANIFEST_SHA256, 'reviewed candidate manifest differs')
    manifest = json.loads(manifest_bytes)
    seen = set()
    bytes_by_path = {}
    checked = []
    for record in manifest['sourceFiles']:
        path = safe_relative(record['path'])
        require(path not in seen, 'duplicate candidate source')
        seen.add(path)
        data = file_bytes(BUNDLE / 'candidate' / path)
        require(len(data) == record['bytes'] and sha(data) == record['sha256'] and blob(data) == record['gitBlob'],
                'candidate bytes differ from independently reviewed source: ' + path)
        checked.append({'path': path, 'bytes': len(data), 'sha256': sha(data), 'gitBlob': blob(data)})
        bytes_by_path[path] = data
    actual = {str(p.relative_to(BUNDLE / 'candidate')) for p in (BUNDLE / 'candidate').rglob('*') if p.is_file()}
    require(actual == seen and len(seen) == 11, 'unexpected or missing candidate file')
    package = read_json(BUNDLE / 'proof-package.json')
    require(package['baseCommit'] == BASE and package['baseTree'] == BASE_TREE
            and package['candidateManifestSha256'] == CANDIDATE_MANIFEST_SHA256, 'proof package identity differs')
    for record in package['files']:
        data = file_bytes(ROOT / safe_relative(record['path']))
        require(sha(data) == record['sha256'] and blob(data) == record['gitBlob'], 'proof helper/reference bytes differ')
    changed = {p for p in git('diff', '--name-only', BASE, 'HEAD', '--').decode().splitlines() if p}
    expected_changed = {record['path'] for record in package['files']} | {'.ci-proof/parallel-gates/proof-package.json'}
    require(changed == expected_changed, 'proof commit changes files outside exact reviewed proof payload')
    write_report('candidate-bytes.json', {'candidateManifestSha256': CANDIDATE_MANIFEST_SHA256,
        'files': checked, 'proofPackageSha256': sha((BUNDLE / 'proof-package.json').read_bytes()),
        'changedPaths': sorted(changed), 'allBytesMatch': True})
    return bytes_by_path


def verify_inventory(candidate):
    reference = read_json(BUNDLE / 'inventory-reference.json')
    upstream = git('show', BASE + ':.github/workflows/ci.yml')
    require(blob(upstream) == ROOT_WORKFLOW_BLOB and sha(upstream) == reference['workflowSha256'],
            'prospective workflow reference does not bind actual base bytes')
    config = json.loads(candidate['.github/ci/contract.json'])
    graph = json.loads(candidate['.github/ci/workflow.json'])
    require(graph['on'] == reference['triggers'] and graph['concurrency'] == reference['concurrency'],
            'candidate loses base event/cancellation coverage')
    inherited = {name: spec['paths'] for name, spec in config['artifacts'].items()
                 if name != 'scoped-build-install-audit'}
    require(inherited == reference['artifactPaths'], 'candidate changes prospective clinical artifact inventory')
    suffix = '--${{ github.run_id }}-${{ github.run_attempt }}-${{ github.sha }}'
    candidates = []
    for lane in config['expectedLanes']:
        job = graph['jobs'][lane]
        for key, value in reference['environment'].items():
            require(job['env'][key] == value, 'baseline environment changed')
        if lane in ('postgres_schema_journeys', 'build_http'):
            require(job['services'] == reference['services'], 'isolated database configuration changed')
        for raw in job['steps']:
            step = copy.deepcopy(raw)
            step.pop('id')
            if step.get('uses') == 'actions/checkout@v7':
                require(step.pop('with') == {'ref': '${{ github.sha }}'}, 'checkout not pinned')
            if step.get('uses') == 'actions/upload-artifact@v4':
                name = step['with']['name']
                require(name.endswith(suffix), 'artifact name not exact-run/attempt bound')
                step['with']['name'] = name[:-len(suffix)]
            candidates.append(step)
    matched = []
    for index, step in enumerate(reference['originalSteps']):
        count = candidates.count(step)
        require(count == (4 if index < 5 else 1), 'original command/action/environment missing or changed: ' + step['name'])
        matched.append({'name': step['name'], 'expectedCopies': 4 if index < 5 else 1, 'actualCopies': count})
    report = {'baseCommit': BASE, 'baseWorkflowBlob': ROOT_WORKFLOW_BLOB,
              'sourceStepsPreserved': len(matched), 'stepMatches': matched,
              'inheritedArtifactDefinitions': len(inherited), 'inheritedPaths': sum(map(len, inherited.values())),
              'candidateRequiredFamilies': sum(a['releaseRequired'] for a in config['artifacts'].values()),
              'artifactPaths': inherited, 'eventsAndEnvironmentPreserved': True}
    write_report('inventory.json', report)
    return config


def materialize(candidate, configuration, identity):
    temp = Path(os.environ.get('RUNNER_TEMP', '')).resolve()
    require(temp.is_dir() and temp != ROOT and not temp.is_relative_to(ROOT), 'runner temporary directory unavailable')
    workspace = temp / ('aqlan-gate-proof-' + identity['runId'] + '-' + identity['runAttempt'])
    require(not workspace.exists(), 'proof requires a fresh isolated workspace')
    workspace.mkdir()
    for relative, expected in configuration['protectedSourceSha256'].items():
        safe_relative(relative)
        data = git('show', BASE + ':' + relative)
        require(sha(data) == expected, 'base protected source differs from candidate contract: ' + relative)
        target = workspace / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    for relative, data in candidate.items():
        target = workspace / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    for name in ('tmp', 'home', '.proof-child'):
        (workspace / name).mkdir()
    return workspace


def run_child(mode, workspace):
    destination = workspace / '.proof-child' / (mode + '-results.json')
    command = [sys.executable, '-I', '-B', str(BUNDLE / 'safe_child.py'), mode, str(workspace),
               str(BUNDLE / 'expected-tests.json'), str(destination)]
    environment = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': str(workspace / 'home'),
                   'TMPDIR': str(workspace / 'tmp'), 'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8'}
    start = now()
    result = None
    error = None
    try:
        result = subprocess.run(command, cwd=workspace, env=environment, capture_output=True,
                                check=False, timeout=90 if mode == 'contract' else 600)
        (REPORTS / (mode + '.stdout.txt')).write_bytes(result.stdout)
        (REPORTS / (mode + '.stderr.txt')).write_bytes(result.stderr)
    except subprocess.TimeoutExpired as caught:
        (REPORTS / (mode + '.stdout.txt')).write_bytes(caught.stdout or b'')
        (REPORTS / (mode + '.stderr.txt')).write_bytes(caught.stderr or b'')
        error = 'child timeout'
    except Exception as caught:
        error = type(caught).__name__ + ': ' + str(caught)
    status = result.returncode if result is not None else None
    write_report(mode + '.process.json', {'startedAt': start, 'completedAt': now(), 'returncode': status,
        'signal': -status if status is not None and status < 0 else None, 'error': error,
        'command': [command[0], '-I', '-B', 'safe_child.py', mode, '<isolated-source-workspace>',
                    'expected-tests.json', '<isolated-result>'],
        'environmentKeysOnly': sorted(environment), 'rawStdoutSha256': sha((REPORTS / (mode + '.stdout.txt')).read_bytes()),
        'rawStderrSha256': sha((REPORTS / (mode + '.stderr.txt')).read_bytes())})
    if destination.exists():
        data = file_bytes(destination)
        report = json.loads(data)
        (REPORTS / (mode + '-results.json')).write_bytes(data)
    else:
        report = {'success': False, 'status': 'result missing'}
        write_report(mode + '-results.json', report)
    return status == 0 and error is None and report.get('success') is True


def capture_context():
    require(REPORTS.is_dir(), 'proof did not initialize diagnostic files')
    text = os.environ.get('PROOF_STEPS_JSON', '')
    require(len(text) <= 64 * 1024, 'oversized platform step snapshot')
    value = json.loads(text)
    write_report('steps-context.json', {'rawStepsContext': value, 'capturedAt': now(),
        'note': 'Actual Actions prior-step context; no synthetic outcome substitution'})
    require(set(value) == {'checkout', 'run_proof'}, 'actual platform steps context shape differs')
    for key, step in value.items():
        require(isinstance(step, dict) and 'outcome' in step and 'conclusion' in step,
                'actual platform step outcome/conclusion absent: ' + key)
    print('Actual prior-step context shape retained; this is not full release-gate acceptance.')


def main():
    require(len(sys.argv) == 2 and sys.argv[1] in ('run', 'capture'), 'expected run or capture')
    if sys.argv[1] == 'capture':
        capture_context()
        return 0
    require(not REPORTS.exists(), 'proof reports already exist')
    REPORTS.mkdir()
    for name in REPORT_FILES:
        if name.endswith('.txt'):
            (REPORTS / name).write_bytes(b'')
        else:
            write_report(name, {'status': 'not run', 'success': False})
    identity = None
    passed = False
    failure = None
    try:
        identity = verify_identity()
        candidate = verify_bundle()
        configuration = verify_inventory(candidate)
        workspace = materialize(candidate, configuration, identity)
        contract_ok = run_child('contract', workspace)
        unit_ok = run_child('unit', workspace)  # Retain both real results even if one failed.
        unchanged = []
        for relative, expected in candidate.items():
            actual = file_bytes(workspace / relative)
            require(actual == expected, 'candidate mutated while tests ran: ' + relative)
            unchanged.append({'path': relative, 'sha256': sha(actual)})
        for relative, expected in configuration['protectedSourceSha256'].items():
            require(sha(file_bytes(workspace / relative)) == expected, 'protected source mutated while tests ran')
        git('diff', '--no-ext-diff', '--exit-code', 'HEAD', '--')
        write_report('source-after.json', {'candidateFilesUnchanged': unchanged, 'protectedSourceUnchanged': True,
                                         'clinicalCheckoutUnchanged': True})
        passed = contract_ok and unit_ok
        if not passed:
            failure = 'one or more actual contract/unit subprocesses failed; inspect raw process/stdout/stderr'
    except Exception as error:
        failure = type(error).__name__ + ': ' + str(error)
    write_report('summary.json', {'format': 'ci-gate-source-proof-v1', 'success': passed,
        'completedAt': now(), 'identity': identity, 'failure': failure,
        'candidateManifestSha256': CANDIDATE_MANIFEST_SHA256,
        'scope': 'only source inventory, new gate/contract unit tests and in-memory faults',
        'notEstablished': ['clinic tests/build/runtime security', 'real final-gate artifact transport',
            'full four-lane Actions success/cancel/skip behavior', 'Production health', 'performance target'],
        'rawReports': {name: sha((REPORTS / name).read_bytes()) for name in REPORT_FILES
                       if name not in ('summary.json', 'steps-context.json')}})
    print('Proof subprocesses passed.' if passed else 'Proof rejected: ' + str(failure))
    return 0 if passed else 1


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        print('Proof runner rejected: ' + type(error).__name__ + ': ' + str(error), file=sys.stderr)
        sys.exit(1)
