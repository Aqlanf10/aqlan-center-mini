import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize, reportPassed, expected, expectedSuites } from './restore-history-report.mjs';

test('emits only fixed classifications, without raw diagnostics or values', () => {
  const raw = { testResults: [{ name: expectedSuites.hr_rollback, assertionResults: [{ title: expected.hr_rollback, status: 'failed', failureMessages: ['SYNTHETIC_PRIVATE_DETAIL'] }] }], databaseUrl: 'SYNTHETIC_URL' };
  const report = summarize(raw, 'failure');
  assert.equal(report.cases.hr_rollback, 'failed');
  assert.equal(report.cases.hr_restore, 'not_reported');
  assert.equal(report.witness_step, 'failure');
  assert.doesNotMatch(JSON.stringify(report), /SYNTHETIC_PRIVATE_DETAIL|SYNTHETIC_URL/);
});
test('does not treat duplicate or unknown status as a passed witness', () => {
  const assertion = { title: expected.hr_rollback, status: 'passed' };
  const report = summarize({ testResults: [{ name: expectedSuites.hr_rollback, assertionResults: [assertion, assertion] }] }, 'success');
  assert.equal(report.cases.hr_rollback, 'unclassified');
  assert.equal(summarize({ testResults: [{ name: expectedSuites.hr_rollback, assertionResults: [{ ...assertion, status: 'other' }] }] }, 'success').cases.hr_rollback, 'unclassified');
});
test('missing report and unknown outcome remain unclassified or not reported', () => {
  const report = summarize(null, 'unexpected');
  assert.equal(report.witness_step, 'unclassified');
  assert.equal(report.cases.inventory_hold, 'not_reported');
});
test('gate accepts only all five passed cases and a successful witness step', () => {
  const items = Object.entries(expected).map(([key, title]) => ({ key, title, status: 'passed' }));
  const make = (records, outcome = 'success') => summarize({ testResults: records.map(item => ({ name: expectedSuites[item.key], assertionResults: [item] })) }, outcome);
  assert.equal(reportPassed(make(items)), true);
  for (let i = 0; i < items.length; i++) {
    assert.equal(reportPassed(make(items.filter((_, index) => index !== i))), false);
    for (const status of ['failed', 'pending', 'skipped', 'todo', 'unknown']) {
      assert.equal(reportPassed(make(items.map((item, index) => index === i ? { ...item, status } : item))), false);
    }
    assert.equal(reportPassed(make([...items, items[i]])), false);
  }
  assert.equal(reportPassed(make(items, 'failure')), false);
  assert.equal(reportPassed(make(items, 'cancelled')), false);
  assert.equal(reportPassed(summarize(null, 'success')), false);
  assert.equal(reportPassed({ ...make(items), cases: { ...make(items).cases, extra: 'passed' } }), false);
});
test('a known title from the wrong file makes the report unclassified', () => {
  const report = summarize({ testResults: [{ name: expectedSuites.inventory_hold, assertionResults: [{ title: expected.hr_rollback, status: 'passed' }] }] }, 'success');
  assert.equal(report.cases.hr_rollback, 'unclassified');
  assert.equal(reportPassed(report), false);
  assert.equal(JSON.stringify(report).includes(expectedSuites.inventory_hold), false);
});
