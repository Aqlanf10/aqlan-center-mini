import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { summarize, classify } from './summarize.mjs';
const [name] = JSON.parse(readFileSync(new URL('./test-names.json', import.meta.url), 'utf8'));
const sentinel = 'SECRET_cookie_patient_email_password_token';
const output = summarize({ environment: sentinel, testResults: [
  { name: '/repo/__tests__/security-http/ceph-tracer-real-react.test.ts', message: `browserType.launch: EPERM ${sentinel}`, assertionResults: [{ title: name, status: 'failed', failureMessages: [`AssertionError: expected coordinates\nExpected: 300\nReceived: 570\n${sentinel}\nhttps://private.example/${sentinel}`], actual: sentinel }, { title: sentinel, status: 'failed', failureMessages: [sentinel] }] },
  { name: '/repo/private.test.ts', message: sentinel, assertionResults: [{ title: name, status: 'failed', failureMessages: [sentinel] }] }
] });
assert.equal(output.tests.length, 1);
assert.equal(output.tests[0].status, 'failed');
assert.deepEqual(output.tests[0].errors[0].numeric, ['Expected: 300', 'Received: 570']);
assert(!JSON.stringify(output).includes(sentinel));
assert(!JSON.stringify(output).includes('private.example'));
assert.deepEqual(output.suiteErrors[0].categories, ['browser-launch', 'runtime-permission']);
assert.equal(summarize({}).report, 'no-allowlisted-results');
assert.deepEqual(classify('strict mode violation: locators SECRET').categories, ['ambiguous-selector']);
assert(JSON.stringify(output).length < 12000);
assert.deepEqual(classify('AssertionError: expected 570 to be 300\n    at runWithTimeout (/private/file)').categories, ['assertion']);
assert.deepEqual(classify('expected 570 to be 300').numeric, ['Expected: 300', 'Received: 570']);
console.log('Synthetic diagnostic sanitizer: all offline assertions passed.');
