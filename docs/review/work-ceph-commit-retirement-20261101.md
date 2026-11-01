# Ceph create ownership at the commit boundary

The review's suspected race is reproduced with real React StrictMode in Chromium. A POST has already delivered its headers and awaits a deferred JSON body. A transition closes the section, replaces its owner or unmounts the component. The parent layout effect releases the body at commit; a microtask witness proves the new passive effect has not run yet. Abort is deliberately ignored.

All **three scenarios failed before correction**: the obsolete continuation invoked `onCreated` and erased the old owner's pending marker while the witness still recorded `passiveEpoch: 0`. Moving the existing owner cleanup and view-generation effect to layout effects retires ownership synchronously. All **three scenarios then pass**, preserving the pending marker, rejecting the stale callback and issuing exactly one POST. No request-body, storage-key, server-contract or replay behavior changed; durable idempotency is not added.

The fixture bundles the actual component and React runtime, not a model of its hooks. It is an isolated commit-window test, not a claim that the current production bundle was rebuilt. Final built-app Ceph regressions and corrected-head hosted CI remain separate gates. Initial fixture lint rejected global registration during render; registration now occurs in a layout effect and final targeted lint passes without disabling a rule.

[Before/after logs and exact source hashes](evidence/work-ceph-commit-retirement-20261101/manifest.json).
