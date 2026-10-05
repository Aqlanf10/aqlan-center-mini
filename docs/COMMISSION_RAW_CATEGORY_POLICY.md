# Own raw category policies

The authorized service creation/update APIs accept raw category names. A legitimate
name such as `constructor`, `toString` or `__proto__` previously read a property
from `Object.prototype` when no own category policy existed. The category resolver
treated that inherited value as a rate and produced `NaN`, which also reached the
derived commission amounts. A stored JSON numeric `__proto__` policy was lost by
the parser's legacy prototype setter.

Only an own finite numeric category rate now matches. A missing or invalid own
rate inherits the actual configured general percentage, including zero. Numeric
own rates retain their exact raw key and zero/nonzero value; valid JSON `__proto__`
rates are defined as ordinary own enumerable data without changing the object's
prototype. Ordinary, unknown and legacy categories remain independent, and a
specific service rule retains priority. Existing dated history entries use the
same own-rate lookup.

This corrects invalid derived reads, including historical reads which previously
produced `NaN`. It does not edit any stored configuration, historical policy,
invoice, payment, procedure or signed visit; it does not create a configuration
cutover, change defaults or aliases, or change database/schema/history writers.
No Production settings are changed.

Evidence includes pure actual-parser/resolver/engine regressions, own zero/nonzero
prototype-key round trips, inherited and invalid rate rejection, special-service
precedence and dated history. The built-app HTTP test uses authorized admin
`POST /api/services`, then the actual commission detail report with synthetic
existing financial/history rows in the isolated security database. It checks
finite exact detail/totals under both invoiced and partially collected cash bases,
and complete invoice/items/payment/visit/procedure/history
rows plus byte-for-byte stored configuration text before and after the report.
Exact-head full CI remains the TypeScript, PostgreSQL and HTTP acceptance gate.
