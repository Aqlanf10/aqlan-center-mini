import copy
import io
import json
import stat
import unittest
from unittest.mock import patch
import zipfile
from fixtures import configuration, evidence, family, identity, needs, receipt, steps


class FinalGateStatusFaults(unittest.TestCase):
    def test_only_complete_all_success_can_pass(self):
        evidence.validate_needs(needs())
        for lane in evidence.LANES:
            for state in ('failure', 'cancelled', 'skipped', 'timed_out', 'neutral', 'action_required', '', None, 'unknown'):
                with self.subTest(lane=lane, state=state):
                    value = needs()
                    value[lane]['result'] = state
                    with self.assertRaises(ValueError):
                        evidence.validate_needs(value)
            missing = needs()
            del missing[lane]
            with self.assertRaises(ValueError):
                evidence.validate_needs(missing)
        unexpected = needs()
        unexpected['another_lane'] = copy.deepcopy(unexpected['build_http'])
        with self.assertRaises(ValueError):
            evidence.validate_needs(unexpected)

    def test_missing_receipt_output_or_digest_never_passes(self):
        for lane in evidence.LANES:
            for key in ('receipt_id', 'receipt_digest'):
                value = needs()
                del value[lane]['outputs'][key]
                with self.assertRaises(ValueError):
                    evidence.validate_needs(value)

    def test_every_required_step_must_really_succeed(self):
        config = configuration()
        for lane in evidence.LANES:
            good = steps(lane)
            evidence.validate_steps(good, config['mandatoryStepIds'][lane])
            for name in good:
                for field, bad in [('outcome', 'failure'), ('outcome', 'cancelled'), ('outcome', 'skipped'),
                                   ('conclusion', 'failure'), ('conclusion', 'skipped')]:
                    value = copy.deepcopy(good)
                    value[name][field] = bad
                    with self.subTest(lane=lane, step=name, field=field, value=bad):
                        with self.assertRaises(ValueError):
                            evidence.validate_steps(value, config['mandatoryStepIds'][lane])
                value = copy.deepcopy(good)
                del value[name]
                with self.assertRaises(ValueError):
                    evidence.validate_steps(value, config['mandatoryStepIds'][lane])

    def test_each_receipt_family_required_and_exact_identity(self):
        config = configuration()
        for lane in evidence.LANES:
            good = receipt(lane)
            evidence.validate_receipt(good, lane, identity(), config)
            for field in identity():
                bad = copy.deepcopy(good)
                bad['identity'][field] += 'changed'
                with self.subTest(lane=lane, identity=field):
                    with self.assertRaises(ValueError):
                        evidence.validate_receipt(bad, lane, identity(), config)
            for name in good['artifacts']:
                bad = copy.deepcopy(good)
                del bad['artifacts'][name]
                with self.subTest(missing=name):
                    with self.assertRaises(ValueError):
                        evidence.validate_receipt(bad, lane, identity(), config)
            forged = copy.deepcopy(good)
            forged['steps'] = {}
            forged['allRequired'] = True
            with self.assertRaises(ValueError):
                evidence.validate_receipt(forged, lane, identity(), config)

    def test_rerun_all_uses_new_names_partial_rerun_is_rejected(self):
        current = identity()
        prior = receipt('build_http')
        current['CI_RUN_ATTEMPT'] = '2'
        self.assertNotEqual(evidence.physical_name('family', identity()), evidence.physical_name('family', current))
        with self.assertRaises(ValueError):
            evidence.validate_receipt(prior, 'build_http', current, configuration())


class ArtifactFaults(unittest.TestCase):
    def test_every_required_family_and_every_member_are_verified(self):
        for name, spec in configuration()['artifacts'].items():
            if not spec['releaseRequired']:
                continue
            members, files = family(spec)
            evidence.validate_family(spec, members, files, identity())
            for missing in files:
                bad = dict(files)
                del bad[missing]
                with self.subTest(family=name, missing=missing):
                    with self.assertRaises(ValueError):
                        evidence.validate_family(spec, members, bad, identity())
            changed = dict(files)
            member = next(iter(files))
            changed[member] += b'tampered'
            with self.assertRaises(ValueError):
                evidence.validate_family(spec, members, changed, identity())
            changed = dict(files)
            changed['unexpected.txt'] = b'extra'
            with self.assertRaises(ValueError):
                evidence.validate_family(spec, members, changed, identity())
            with self.assertRaises(ValueError):
                evidence.validate_family(spec, members + [members[0]], files, identity())

    def test_invalid_images_json_pdf_and_empty_reports_fail(self):
        for name in ('example.png', 'example-bounds.json', 'example.pdf', 'runtime-proof.json'):
            for data in (b'', b'not valid'):
                with self.assertRaises(ValueError):
                    evidence.validate_content(name, data)
        evidence.validate_content('audit.stderr.txt', b'')

    def test_all_executed_audit_attempts_are_contiguous_complete_triples(self):
        spec = configuration()['artifacts']['scoped-dependency-audit']
        paths = [p for p in spec['paths'] if '-attempt-2.' not in p and '-attempt-3.' not in p]
        evidence.archive_members(spec, paths)
        for mode in ('full', 'production'):
            triple = [f'.dependency-audit/{mode}-attempt-2' + suffix for suffix in ('.json', '.stderr.txt', '.process.json')]
            evidence.archive_members(spec, paths + triple)
            for partial in (triple[:1], triple[:2]):
                with self.assertRaises(ValueError):
                    evidence.archive_members(spec, paths + partial)
            with self.assertRaises(ValueError):
                evidence.archive_members(spec, paths + [p.replace('-2.', '-3.') for p in triple])
        for required in paths:
            with self.assertRaises(ValueError):
                evidence.archive_members(spec, [p for p in paths if p != required])

    def test_zip_digest_path_traversal_symlink_duplicate_are_rejected(self):
        def archive(items):
            output = io.BytesIO()
            with zipfile.ZipFile(output, 'w') as z:
                for name, data in items:
                    z.writestr(name, data)
            return output.getvalue()
        data = archive([('receipt.json', b'{}')])
        self.assertEqual(evidence.zip_members(data, evidence.digest(data)), {'receipt.json': b'{}'})
        with self.assertRaises(ValueError):
            evidence.zip_members(data, '0' * 64)
        for path in ('../bad', '/absolute', 'a/../bad', 'a\\bad', 'C:/bad'):
            data = archive([(path, b'bad')])
            with self.assertRaises(ValueError):
                evidence.zip_members(data, evidence.digest(data))
        data = archive([('same.json', b'1'), ('SAME.json', b'2')])
        with self.assertRaises(ValueError):
            evidence.zip_members(data, evidence.digest(data))
        link = zipfile.ZipInfo('link')
        link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        data = archive([(link, b'outside')])
        with self.assertRaises(ValueError):
            evidence.zip_members(data, evidence.digest(data))

    def test_upload_metadata_cannot_cross_run_head_id_digest_or_expiry(self):
        ident = identity()
        good = {'id': 1234, 'name': evidence.physical_name('sample', ident), 'expired': False,
                'digest': 'sha256:' + 'a' * 64, 'size_in_bytes': 100,
                'workflow_run': {'id': 123, 'head_sha': 'b' * 40}}
        evidence.validate_metadata(good, '1234', good['name'], 'a' * 64, ident)
        for key, value in [('id', 5), ('name', 'old-name'), ('digest', 'sha256:' + 'b' * 64),
                           ('expired', True), ('size_in_bytes', 0), ('workflow_run', {'id': 122, 'head_sha': 'b' * 40}),
                           ('workflow_run', {'id': 123, 'head_sha': 'a' * 40})]:
            bad = copy.deepcopy(good)
            bad[key] = value
            with self.assertRaises(ValueError):
                evidence.validate_metadata(bad, '1234', good['name'], 'a' * 64, ident)

    def test_no_network_fallback_or_disabled_validation(self):
        with patch.dict(evidence.os.environ, {'GH_TOKEN': ''}):
            with self.assertRaises(ValueError):
                evidence.fetch_artifact('123', 'sample', 'a' * 64, identity())
        with patch.dict(evidence.os.environ, {'GH_TOKEN': 'synthetic-token'}), patch.object(
                evidence, 'http_bytes', side_effect=ValueError('network unavailable')):
            with self.assertRaises(ValueError):
                evidence.fetch_artifact('123', 'sample', 'a' * 64, identity())


class EventIdentityFaults(unittest.TestCase):
    def test_pr_merge_push_and_dispatch_identity(self):
        evidence.context(identity())
        for event, ref in [('push', 'refs/heads/main'), ('push', 'refs/heads/hardening/stacked'),
                           ('push', 'refs/heads/feat/work'), ('workflow_dispatch', 'refs/heads/main')]:
            ident = identity()
            ident.update(CI_EVENT_NAME=event, CI_REF=ref, CI_SOURCE_HEAD_SHA=ident['CI_EVENT_SHA'])
            evidence.context(ident)
        head_only = identity()
        head_only['CI_REF'] = 'refs/heads/fix/work'
        with self.assertRaises(ValueError):
            evidence.context(head_only)
        unsupported = identity()
        unsupported['CI_EVENT_NAME'] = 'pull_request_target'
        with self.assertRaises(ValueError):
            evidence.context(unsupported)

    def test_duplicate_json_keys_are_not_silently_overwritten(self):
        for data in ('{"lane":1,"lane":2}', '{"x":NaN}'):
            with self.assertRaises(ValueError):
                evidence.decode_json(data)


class GateEndToEndFaults(unittest.TestCase):
    """Execute the real gate with bounded in-memory downloads, never network."""
    def setup_gate(self):
        config = configuration()
        ident = identity()
        all_needs = needs()
        downloads = {}
        for lane in evidence.LANES:
            rec = receipt(lane)
            downloads[all_needs[lane]['outputs']['receipt_id']] = {'receipt.json': json.dumps(rec).encode()}
            for name, item in rec['artifacts'].items():
                _, files = family(config['artifacts'][name], ident)
                downloads[item['id']] = files
        return all_needs, downloads

    def run_gate(self, all_needs, downloads):
        import workflow
        with patch.dict(evidence.os.environ, {
            'CI_NEEDS_JSON': json.dumps(all_needs),
            'CI_GATE_STEPS_JSON': json.dumps({'checkout': {'outcome': 'success', 'conclusion': 'success'}}),
        }), patch.object(evidence, 'source_identity', return_value=identity()), patch.object(
            workflow, 'check_repository', return_value={}), patch.object(evidence, 'fetch_artifact',
            side_effect=lambda artifact_id, *_: downloads[artifact_id]), patch('builtins.print'):
            evidence.gate()

    def test_complete_four_lane_gate_passes(self):
        self.run_gate(*self.setup_gate())

    def test_every_missing_artifact_download_fails_gate(self):
        all_needs, complete = self.setup_gate()
        for missing in complete:
            downloads = dict(complete)
            del downloads[missing]
            with self.subTest(missing=missing):
                with self.assertRaises((ValueError, KeyError)):
                    self.run_gate(all_needs, downloads)

    def test_cancel_skip_failure_and_tampered_receipt_cannot_pass(self):
        for lane in evidence.LANES:
            for state in ('cancelled', 'skipped', 'failure'):
                all_needs, downloads = self.setup_gate()
                all_needs[lane]['result'] = state
                with self.assertRaises(ValueError):
                    self.run_gate(all_needs, downloads)
            all_needs, downloads = self.setup_gate()
            target = all_needs[lane]['outputs']['receipt_id']
            downloads[target] = {'receipt.json': b'{"allRequired":true}'}
            with self.assertRaises(ValueError):
                self.run_gate(all_needs, downloads)

    def test_shared_database_container_or_runner_fails(self):
        for field in ('postgresContainer', 'hostname'):
            all_needs, downloads = self.setup_gate()
            pg = json.loads(downloads[all_needs['postgres_schema_journeys']['outputs']['receipt_id']]['receipt.json'])
            target = all_needs['build_http']['outputs']['receipt_id']
            http = json.loads(downloads[target]['receipt.json'])
            http[field] = pg[field]
            downloads[target]['receipt.json'] = json.dumps(http).encode()
            with self.assertRaises(ValueError):
                self.run_gate(all_needs, downloads)
