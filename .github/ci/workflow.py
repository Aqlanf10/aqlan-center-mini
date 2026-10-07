#!/usr/bin/env python3
"""Executable DAG contract and deterministic JSON-graph to YAML equivalence.

The graph is ordinary parsed JSON, not a regex approximation of YAML. A strict
byte-for-byte render check binds that graph to the workflow GitHub executes.
"""
import hashlib
import json
from pathlib import Path
import re
import sys

LANES = ('security_early', 'static_quality', 'postgres_schema_journeys', 'build_http')
SUFFIX = '--${{ github.run_id }}-${{ github.run_attempt }}-${{ github.sha }}'
HEADER = '# Generated from .github/ci/workflow.json; edit the graph, then render it.\n'


def require(ok, message):
    if not ok:
        raise ValueError(message)


def scalar(value):
    if value is None:
        return ''
    if isinstance(value, bool):
        return 'true' if value else 'false'
    if isinstance(value, (int, float)):
        return str(value)
    if (value == '' or value in ('true', 'false', 'null', 'yes', 'no', 'on', 'off')
            or re.fullmatch(r'[0-9]+', value) or value[0] in '[{!&*#|>@`\"\''
            or ': ' in value or ' #' in value):
        return json.dumps(value, ensure_ascii=False)
    return value


def render_lines(value, indent=0):
    out = []
    pad = ' ' * indent
    if isinstance(value, dict):
        for key, child in value.items():
            if isinstance(child, (dict, list)) and child:
                out.append(f'{pad}{key}:')
                out.extend(render_lines(child, indent + 2))
            elif isinstance(child, (dict, list)):
                out.append(f'{pad}{key}: ' + ('{}' if isinstance(child, dict) else '[]'))
            elif isinstance(child, str) and '\n' in child:
                out.append(f'{pad}{key}: |')
                out.extend(' ' * (indent + 2) + line for line in child.rstrip('\n').split('\n'))
            else:
                out.append(f'{pad}{key}: ' + scalar(child))
    elif isinstance(value, list):
        for child in value:
            if isinstance(child, (dict, list)):
                lines = render_lines(child, indent + 2)
                out.append(pad + '- ' + lines[0][indent + 2:])
                out.extend(lines[1:])
            else:
                out.append(pad + '- ' + scalar(child))
    return out


def render(graph):
    return HEADER + '\n'.join(render_lines(graph)) + '\n'


def steps_by_id(job):
    steps = job.get('steps', [])
    require(isinstance(steps, list) and all(isinstance(s, dict) and s.get('id') for s in steps),
            'all steps need explicit outcome identities')
    require(len({s['id'] for s in steps}) == len(steps), 'duplicate step ID')
    return {step['id']: step for step in steps}


def before(steps, earlier, later):
    ids = list(steps)
    require(earlier in ids and later in ids and ids.index(earlier) < ids.index(later),
            f'required DAG edge missing: {earlier} -> {later}')


def validate_graph(graph, contract):
    require(set(graph) == {'name', 'on', 'concurrency', 'jobs'}, 'unexpected workflow-level semantics')
    require(graph['name'] == 'CI' and graph['on'] == contract['triggers']
            and graph['concurrency'] == contract['concurrency'], 'trigger or cancellation contract changed')
    require(contract['expectedLanes'] == list(LANES), 'required lane set changed')
    jobs = graph['jobs']
    require(isinstance(jobs, dict) and set(jobs) == {*LANES, 'quality'}, 'incomplete/unexpected workflow DAG')
    require(sum(job.get('name') == contract['legacyCheckName'] for job in jobs.values()) == 1,
            'legacy check name must appear exactly once')
    identity_env = {
        'CI_EVENT_NAME': '${{ github.event_name }}', 'CI_EVENT_SHA': '${{ github.sha }}',
        'CI_SOURCE_HEAD_SHA': '${{ github.event.pull_request.head.sha || github.sha }}',
        'CI_SOURCE_BASE_SHA': '${{ github.event.pull_request.base.sha || github.event.before || github.sha }}',
        'CI_WORKFLOW_REF': '${{ github.workflow_ref }}', 'CI_WORKFLOW_SHA': '${{ github.workflow_sha }}',
        'CI_RUN_ID': '${{ github.run_id }}', 'CI_RUN_ATTEMPT': '${{ github.run_attempt }}',
        'CI_REPOSITORY': '${{ github.repository }}', 'CI_REF': '${{ github.ref }}'}
    for lane in LANES:
        job = jobs[lane]
        require(set(job) <= {'name', 'runs-on', 'timeout-minutes', 'services', 'permissions', 'env', 'outputs', 'steps'},
                'conditional, dependent, matrix or weakened lane forbidden')
        require(job.get('runs-on') == 'ubuntu-latest' and job.get('timeout-minutes') == 55,
                'runner or timeout changed')
        require(job.get('permissions') == {'contents': 'read'}, 'worker token must be explicitly read-only')
        expected_service = contract['postgresService'] if lane in ('postgres_schema_journeys', 'build_http') else None
        require(job.get('services') == expected_service, 'isolated PostgreSQL service changed')
        expected_env = {**contract['laneEnvironment'], **identity_env, 'CI_LANE': lane}
        require(job.get('env') == expected_env, 'identity or environment mapping changed')
        for key, value in contract['laneEnvironment'].items():
            require(job.get('env', {}).get(key) == value, f'lane environment changed: {lane}/{key}')
        require('NODE_ENV' not in job['env'] and 'CATEGORY_HISTORY_CI_DISPOSABLE_FIXTURE' not in job['env']
                and 'MANUAL_CASH_CI_DISPOSABLE_FIXTURE' not in job['env'], 'unsafe global runtime/reset setting')
        require(not any(isinstance(value, str) and re.search(r'\b(?:job|steps|runner)\.', value)
                        for value in job['env'].values()),
                'runner-only context is unavailable in job-level env')
        steps = steps_by_id(job)
        require(job['steps'][:5] == contract['bootstrapSteps'], 'per-lane bootstrap contract changed')
        expected_init = {
            'name': 'Bind clean checkout and evidence identity', 'id': 'evidence_init',
            'run': 'python3 .github/ci/evidence.py init'}
        if expected_service:
            # job.services is available only after the job starts, at step env scope.
            expected_init['env'] = {'CI_POSTGRES_CONTAINER': '${{ job.services.postgres.id }}'}
        require(list(steps)[5] == 'evidence_init' and steps['evidence_init'] == expected_init,
                'clean-source or step-scoped service provenance gate changed')
        require(list(steps)[-2:] == ['seal', 'receipt_upload'], 'seal must run after every command/uploader')
        require(steps['seal'].get('if') == 'always()'
                and steps['seal'].get('run') == 'python3 .github/ci/evidence.py seal'
                and steps['seal'].get('env') == {'CI_STEPS_JSON': '${{ toJSON(steps) }}'}, 'receipt seal weakened')
        require(steps['receipt_upload'] == {
            'name': 'Upload immutable lane receipt', 'id': 'receipt_upload', 'if': 'always()',
            'uses': 'actions/upload-artifact@v4', 'with': {
                'name': 'ci-receipt-' + lane + SUFFIX, 'path': '.ci-evidence/receipt.json',
                'include-hidden-files': True, 'if-no-files-found': 'error', 'retention-days': 7}},
            'receipt retention or exact allowlist changed')
        require(job['outputs'] == {'receipt_id': '${{ steps.receipt_upload.outputs.artifact-id }}',
                                   'receipt_digest': '${{ steps.receipt_upload.outputs.artifact-digest }}'},
                'immutable upload outputs lost')
        require(list(steps)[:-2] == contract['mandatoryStepIds'][lane], 'mandatory command set/order changed')
        for step in steps.values():
            require('continue-on-error' not in step and 'timeout-minutes' not in step,
                    'mandatory step cannot be softened or separately timed out')
            require(not any(key in step for key in ('working-directory', 'shell')), 'unexpected execution override')
            if 'run' in step and step['id'] != 'seal':
                require('if' not in step, 'mandatory command cannot be conditional')
    for item in contract['preservedSteps']:
        actual = steps_by_id(jobs[item['lane']]).get(item['id'])
        require(actual == item['expected'], f'original step changed/dropped: {item["sourceOrdinal"]}')
    # Preserve every source ordinal: five bootstrap steps repeated in four lanes,
    # followed by the original 68 independent work/upload definitions exactly once.
    ordinals = [item['sourceOrdinal'] for item in contract['preservedSteps']]
    require(set(ordinals) == set(range(1, 74)) and all(ordinals.count(n) == (4 if n <= 5 else 1)
            for n in range(1, 74)), 'baseline 73-step inventory no longer complete')
    build = steps_by_id(jobs['build_http'])
    require(build['build_install_audit'].get('run') == 'node --import tsx scripts/ci-audit.mjs',
            'actual build installation must pass unchanged live audit')
    for early, late in [('evidence_init', 'build_install_audit'), ('build_install_audit', 'baseline_22'),
                        ('baseline_22', 'baseline_23'), ('baseline_23', 'baseline_24'),
                        ('baseline_24', 'baseline_28'), ('baseline_26', 'baseline_28'),
                        ('baseline_27', 'baseline_28')]:
        before(build, early, late)
    pg = steps_by_id(jobs['postgres_schema_journeys'])
    for early, late in [('baseline_10', 'baseline_11'), ('baseline_11', 'baseline_12'),
                        ('baseline_12', 'baseline_13'), ('baseline_13', 'baseline_15'),
                        ('baseline_15', 'baseline_16'), ('baseline_16', 'baseline_17'),
                        ('baseline_17', 'baseline_18')]:
        before(pg, early, late)
    static = steps_by_id(jobs['static_quality'])
    require(static['ci_contract_tests'].get('run') == 'python3 .github/ci/workflow.py --check\n'
            'python3 -m unittest discover -s .github/ci/tests -p "test_*.py"\n', 'fault controls missing')
    final = jobs['quality']
    require(set(final) == {'name', 'if', 'needs', 'runs-on', 'timeout-minutes', 'permissions', 'env', 'steps'},
            'unexpected final gate settings')
    require(final['name'] == contract['legacyCheckName'] and final['if'] == 'always()'
            and final['needs'] == list(LANES), 'final must always need all exact lanes')
    require(final['runs-on'] == 'ubuntu-latest' and final['timeout-minutes'] == 55
            and final['permissions'] == {'contents': 'read', 'actions': 'read'}, 'gate permissions/timeout changed')
    require(final['env'] == identity_env, 'final event identity changed')
    final_steps = steps_by_id(final)
    require(list(final_steps) == ['checkout', 'final_gate'], 'unexpected final steps')
    require(final_steps['checkout'] == {'name': 'Check out exact event commit', 'id': 'checkout',
            'uses': 'actions/checkout@v7', 'with': {'ref': '${{ github.sha }}'}}, 'final checkout is mutable')
    require(final_steps['final_gate'] == {'name': 'Verify complete fail-closed release evidence',
            'id': 'final_gate', 'if': 'always()', 'env': {
                'CI_NEEDS_JSON': '${{ toJSON(needs) }}', 'CI_GATE_STEPS_JSON': '${{ toJSON(steps) }}',
                'GH_TOKEN': '${{ github.token }}'}, 'run': 'python3 .github/ci/evidence.py gate'},
            'final gate cannot be skipped, neutralized or lose needs identity')
    seen = set()
    for name, spec in contract['artifacts'].items():
        require(spec['semanticName'] == name and spec['lane'] in LANES, 'artifact catalog identity mismatch')
        step = steps_by_id(jobs[spec['lane']])[spec['uploadStep']]
        with_ = step.get('with', {})
        require(step.get('uses') == 'actions/upload-artifact@v4' and with_.get('name') == name + SUFFIX,
                'artifact identity/upload action mismatch')
        require(with_.get('path', '').splitlines() == spec['paths']
                and with_.get('retention-days') == 7
                and with_.get('include-hidden-files', False) == spec['includeHiddenFiles']
                and with_.get('if-no-files-found') == spec['currentMissingPolicy'], 'artifact allowlist changed')
        require(set(with_) <= {'name', 'path', 'retention-days', 'include-hidden-files', 'if-no-files-found'},
                'artifact overwrite or additional options forbidden')
        require(name not in seen, 'duplicate artifact family')
        seen.add(name)
        if name == 'settings-ui-screenshots':
            require(spec['paths'] == ['.settings-ui-artifacts/'] and not spec['releaseRequired']
                    and not spec['includeHiddenFiles'] and spec['currentMissingPolicy'] == 'ignore',
                    'legacy no-op must never become broad hidden evidence')
        else:
            require(spec['releaseRequired'] is True, 'real evidence family cannot be made optional')
            for path in spec['paths']:
                require(not any(char in path for char in '*?[]') and not path.endswith('/')
                        and not any(word in path for word in ('.env', '.sec-http', 'storage', '.har', 'trace.zip')),
                        'broad/private artifact path forbidden')
    actual_uploads = {(lane, step['id']) for lane in LANES for step in jobs[lane]['steps']
                      if step.get('uses') == 'actions/upload-artifact@v4' and step['id'] != 'receipt_upload'}
    require(actual_uploads == {(spec['lane'], spec['uploadStep']) for spec in contract['artifacts'].values()},
            'unlisted artifact uploader')
    require('secrets.' not in json.dumps(graph), 'secrets are not part of CI')


def check_repository(root):
    root = Path(root)
    graph = json.loads((root / '.github/ci/workflow.json').read_text())
    contract = json.loads((root / '.github/ci/contract.json').read_text())
    validate_graph(graph, contract)
    require((root / '.github/workflows/ci.yml').read_text() == render(graph), 'workflow YAML differs from parsed DAG')
    for relative, expected in contract['protectedSourceSha256'].items():
        require(hashlib.sha256((root / relative).read_bytes()).hexdigest() == expected,
                f'protected audit/runtime/test-configuration source changed: {relative}')
    return graph


if __name__ == '__main__':
    try:
        root = Path(__file__).resolve().parents[2]
        require(len(sys.argv) == 2 and sys.argv[1] in ('--check', '--export', '--render'), 'expected --check/--export/--render')
        if sys.argv[1] == '--render':
            graph = json.loads((root / '.github/ci/workflow.json').read_text())
            configuration = json.loads((root / '.github/ci/contract.json').read_text())
            validate_graph(graph, configuration)
            (root / '.github/workflows/ci.yml').write_text(render(graph))
        else:
            graph = check_repository(root)
            print(json.dumps(graph) if sys.argv[1] == '--export' else 'CI DAG, original inventory, allowlists and source integrity verified.')
    except Exception as error:
        print(f'CI workflow contract rejected: {error}', file=sys.stderr)
        sys.exit(1)
