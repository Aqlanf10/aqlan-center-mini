#!/usr/bin/env python3
"""Run reviewed contract/unit source in a temporary offline-only workspace.

This helper is for the temporary proof workflow, never a production release gate.
The parent passes no platform-token variables and gives this process a minimal env.
This audited, pinned source runner is not a general sandbox for untrusted code.
"""
import importlib
import json
import os
from pathlib import Path
import sys
import unittest


def main():
    if len(sys.argv) != 5 or sys.argv[1] not in ('contract', 'unit'):
        raise ValueError('expected contract|unit, workspace, expected-tests, result-file')
    mode = sys.argv[1]
    workspace = Path(sys.argv[2]).resolve(strict=True)
    expected_path = Path(sys.argv[3]).resolve(strict=True)
    result_path = Path(sys.argv[4]).resolve()
    if not result_path.is_relative_to(workspace):
        raise ValueError('result path outside temporary workspace')
    expected = json.loads(expected_path.read_text())
    sys.dont_write_bytecode = True

    def inside(value):
        if isinstance(value, int):
            return True
        try:
            return Path(value).resolve().is_relative_to(workspace)
        except (TypeError, ValueError):
            return False

    def audit(event, args):
        if event.startswith('socket.') or event in {
            'subprocess.Popen', 'os.system', 'os.exec', 'os.posix_spawn', 'pty.spawn',
            'ctypes.dlopen', 'ctypes.dlsym', 'os.fork', 'os.forkpty'}:
            raise RuntimeError('proof policy denies network/native loading/process launch: ' + event)
        if event == 'open':
            path, mode, flags = args
            writing = (isinstance(mode, str) and any(c in mode for c in 'wax+')) or (
                isinstance(flags, int) and flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND))
            if writing and not inside(path):
                raise RuntimeError('proof policy denies write outside isolated workspace')
        if event in {'os.remove', 'os.rmdir', 'os.mkdir', 'os.chmod', 'os.chown', 'os.utime', 'os.truncate'}:
            if not inside(args[0]):
                raise RuntimeError('proof policy denies mutation outside isolated workspace')
        if event in {'os.rename', 'os.link', 'os.symlink'}:
            if not inside(args[0]) or not inside(args[1]):
                raise RuntimeError('proof policy denies link/rename outside isolated workspace')

    sys.addaudithook(audit)
    os.chdir(workspace)
    sys.path.insert(0, str(workspace / '.github/ci'))
    if mode == 'contract':
        module = importlib.import_module('workflow')
        graph = module.check_repository(workspace)
        report = {'format': 'ci-proof-contract-v1', 'success': True,
                  'jobIds': list(graph['jobs']), 'executedCheck': 'workflow.check_repository',
                  'scope': 'source DAG/YAML/inventory/protected-file checks only'}
        result_path.write_text(json.dumps(report, indent=2) + '\n')
        print('The exact candidate workflow contract passed in the isolated source workspace.')
        return 0

    suite = unittest.TestLoader().discover(str(workspace / '.github/ci/tests'), pattern='test_*.py')

    def ids(node):
        if isinstance(node, unittest.TestSuite):
            return [name for child in node for name in ids(child)]
        return [node.id()]

    collected = ids(suite)
    if sorted(collected) != expected['testIds'] or len(collected) != len(set(collected)) or not collected:
        raise ValueError('discovered unit/fault cases differ from the reviewed source inventory')
    result = unittest.TextTestRunner(stream=sys.stderr, verbosity=2).run(suite)
    passed = (result.wasSuccessful() and result.testsRun == len(collected)
              and not result.skipped and not result.expectedFailures and not result.unexpectedSuccesses)
    report = {'format': 'ci-proof-unit-v1', 'success': bool(passed), 'testsRun': result.testsRun,
              'collectedTestIds': sorted(collected),
              'failures': [{'test': test.id(), 'traceback': trace} for test, trace in result.failures],
              'errors': [{'test': test.id(), 'traceback': trace} for test, trace in result.errors],
              'skipped': [{'test': test.id(), 'reason': reason} for test, reason in result.skipped],
              'expectedFailures': [{'test': test.id(), 'traceback': trace} for test, trace in result.expectedFailures],
              'unexpectedSuccesses': [test.id() for test in result.unexpectedSuccesses],
              'scope': 'real candidate pure validators and in-memory synthetic faults; transport is mocked, not a release proof'}
    result_path.write_text(json.dumps(report, indent=2) + '\n')
    return 0 if passed else 1


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        print('Proof child failed: ' + type(error).__name__ + ': ' + str(error), file=sys.stderr)
        sys.exit(1)
