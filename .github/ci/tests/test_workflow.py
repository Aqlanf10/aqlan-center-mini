import copy
import unittest
from fixtures import configuration, graph, workflow


class WorkflowDagFaults(unittest.TestCase):
    def reject(self, mutation):
        value = graph()
        mutation(value)
        with self.assertRaises(ValueError):
            workflow.validate_graph(value, configuration())

    def test_complete_source_graph_and_inventory(self):
        workflow.validate_graph(graph(), configuration())
        config = configuration()
        self.assertEqual(len(config['preservedSteps']), 88)  # 73 + 3 repeated bootstrap sets.
        self.assertEqual(len(config['artifacts']), 54)  # Baseline 50 + 3 clinical + independent build audit.
        self.assertEqual(sum(a['releaseRequired'] for a in config['artifacts'].values()), 53)

    def test_every_lane_failure_skip_condition_dependency_and_coe_are_forbidden(self):
        for lane in workflow.LANES:
            self.reject(lambda g: g['jobs'][lane].update({'if': 'false'}))
            self.reject(lambda g: g['jobs'][lane].pop('permissions'))
            self.reject(lambda g: g['jobs'][lane]['permissions'].update({'contents': 'write'}))
            self.reject(lambda g: g['jobs'][lane].update({'continue-on-error': True}))
            self.reject(lambda g: g['jobs'][lane].update({'needs': ['security_early']}))
            self.reject(lambda g: g['jobs'][lane]['steps'][4].update({'if': 'false'}))
            self.reject(lambda g: g['jobs'][lane]['steps'][4].update({'continue-on-error': True}))
            self.reject(lambda g: g['jobs'][lane]['steps'][0]['with'].update({'ref': '${{ github.event.pull_request.head.sha }}'}))
            self.reject(lambda g: g['jobs']['quality']['needs'].remove(lane))
            self.reject(lambda g: g['jobs'].__delitem__(lane))

    def test_final_always_legacy_context_and_gate_cannot_be_weakened(self):
        self.reject(lambda g: g['jobs']['quality'].update({'if': 'success()'}))
        self.reject(lambda g: g['jobs']['quality'].update({'name': 'New passing label'}))
        self.reject(lambda g: g['jobs']['quality']['steps'][1].update({'if': 'success()'}))
        self.reject(lambda g: g['jobs']['quality']['steps'][1].update({'run': 'echo success'}))
        self.reject(lambda g: g['jobs']['quality']['steps'][1].update({'continue-on-error': True}))
        self.reject(lambda g: g['jobs']['quality']['permissions'].update({'actions': 'write'}))

    def test_every_original_command_and_artifact_remains(self):
        config = configuration()
        for item in config['preservedSteps']:
            def remove(g):
                target = g['jobs'][item['lane']]['steps']
                target[:] = [s for s in target if s['id'] != item['id']]
            self.reject(remove)
        for name, spec in config['artifacts'].items():
            def mutate(g):
                step = next(s for s in g['jobs'][spec['lane']]['steps'] if s['id'] == spec['uploadStep'])
                step['with']['path'] = spec['paths'][0] if len(spec['paths']) > 1 else 'missing.json'
            self.reject(mutate)

    def test_runtime_audit_and_database_dependence(self):
        self.reject(lambda g: g['jobs']['build_http']['steps'].__delitem__(6))
        self.reject(lambda g: g['jobs']['build_http']['services']['postgres'].update({'image': 'postgres:17-alpine'}))
        self.reject(lambda g: g['jobs']['postgres_schema_journeys'].pop('services'))
        self.reject(lambda g: g['jobs']['build_http']['env'].update({'NODE_ENV': 'production'}))
        self.reject(lambda g: g['jobs']['postgres_schema_journeys']['env'].update({'CATEGORY_HISTORY_CI_DISPOSABLE_FIXTURE': '1'}))
        self.reject(lambda g: g['jobs']['build_http']['env'].update({'DATABASE_URL': 'postgresql://remote/production'}))

    def test_all_original_trigger_and_ref_cancellation_cases(self):
        value = graph()
        self.assertEqual(value['on'], {'pull_request': {'branches': ['main']},
                                      'push': {'branches': ['main', 'feat/**', 'hardening/**']},
                                      'workflow_dispatch': None})
        self.assertEqual(value['concurrency'], {'group': 'ci-${{ github.ref }}', 'cancel-in-progress': True})
        for event in value['on']:
            self.reject(lambda g: g['on'].pop(event))
        self.reject(lambda g: g['on']['push'].update({'branches': ['main']}))
        self.reject(lambda g: g['on']['pull_request'].update({'paths': ['app/**']}))
        self.reject(lambda g: g['on'].update({'pull_request_target': {'branches': ['main']}}))
        self.reject(lambda g: g['concurrency'].update({'group': 'ci-${{ github.head_ref || github.ref }}'}))

    def test_legacy_hidden_directory_remains_non_evidence(self):
        def broaden(g):
            step = next(s for s in g['jobs']['build_http']['steps'] if s.get('with', {}).get('name', '').startswith('settings-ui-screenshots--'))
            step['with']['include-hidden-files'] = True
        self.reject(broaden)

    def test_yaml_is_deterministically_bound_to_parsed_graph(self):
        value = graph()
        rendered = workflow.render(value)
        self.assertIn('node-version: 22', rendered)
        self.assertIn('if: always()', rendered)
        self.assertIn('ref: ${{ github.sha }}', rendered)
        self.assertNotEqual(rendered, rendered.replace('if: always()', 'if: success()', 1))
