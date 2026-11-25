# Payroll loading regression — 25 November 2026

## Problem

Payroll loaded the entire overtime history through offset pagination with a
10,000-row ceiling. Production reached 10,051 rows. The overtime fetch then
failed the shared foundation load, leaving the payroll page empty with misleading
zero-value summaries.

The old ordering used overtime date and creation time without a unique
tie-breaker. A read-only comparison also found duplicate pending rows across
offset pages (4,478 returned, only 4,438 unique).

## Change

- Load overtime in batches using an ascending unique ID cursor, then restore the
  existing newest-date/creation-time presentation order.
- Continue until an empty page; do not assume a short response is the final page,
  because the API can impose a lower page size.
- Payroll retains every non-rejected request, every planned/manual request, and
  every request in its attendance date range. Rejected automatic history outside
  that range remains available in Approval.
- Secondary payroll sections report their own load failures. Salary data remains
  usable when a separate section fails; core salary failures still block the
  salary table.
- Unavailable totals/counts display an em dash and an explanation, rather than a
  zero balance. Actions/exports depending on unavailable data are disabled.
- Business calculations, salary processing, cycle rules, bonus rules, database
  schema, and payment mutations are unchanged. No migration or function deployment
  is required for this change.

## Verification

Run:

```sh
npm run test:payroll-loading
npm run build
```

The 14 regression tests cover 0/1/500/10,000/10,051/25,000 rows, API page caps,
mid-load errors, invalid cursors, display ordering, section error isolation,
core salary failure, bonus refresh failure, and successful retries.

Optional read-only production backtest:

```sh
# Supply DMS_AUDIT_URL and DMS_AUDIT_KEY securely through the environment.
node scripts/payroll-loading-backtest.mjs 7ae6030fa0079432e1c3e4e533a8ed39dbdddf2e 2026-11-25
```

The backtest prohibits writes and RPCs. It reproduces the old failure, then uses
the previous calculation/mapping code with only its fetch ceiling lifted and an
ID tie-breaker added as a complete reference. It compares that reference to the
new application loader; private records are compared by digest, not printed.
The clock and repeated identical reads are held constant for comparison.

Observed results:

- 102 employee/current-cycle display rows match, including financial fields.
- 220 salary payments, 33 overtime payments, 54 bonus cycles, 49 bonus payments,
  one bonus policy, and two current leave requests match.
- Approved, pending, draft, planned/manual, and payable overtime records match
  the complete reference. The date-scoped Approval history also matches.
- Payroll overtime payload: 10,051 historical rows → 4,519 relevant rows.
- New loader: approximately 2.8 seconds in this run; not a latency guarantee.
- No production writes were performed by the backtest.

Browser verification must additionally confirm salary, overtime, bonus, and
payment-history tabs render under the existing authenticated admin session.
Do not create test salary payments in production.

## Remaining limits

This change removes the overtime ceiling responsible for this incident. Other
legacy loaders still have their own row limits and the overall app bundle still
has Vite's existing large-chunk warning. It is not a claim that every historical
query in the system is unbounded or that all future timeouts are eliminated.
