import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { createClient } from "@supabase/supabase-js"
import { loadPayrollTestModule, payrollReadOptions } from "./helpers/payroll-test-module.mjs"

// Explicit opt-in live READ-ONLY regression. Never prints employee records,
// credentials, or monetary values. Supply credentials through environment only.
// node scripts/payroll-loading-backtest.mjs <baseline-git-ref> <YYYY-MM-DD>
const [baselineRef, date] = process.argv.slice(2)
assert.match(baselineRef || "", /^[a-f0-9]{7,40}$/i, "Supply the baseline commit hash")
assert.match(date || "", /^\d{4}-\d{2}-\d{2}$/, "Supply the audit date")
assert.ok(process.env.DMS_AUDIT_URL && process.env.DMS_AUDIT_KEY, "Set DMS_AUDIT_URL and DMS_AUDIT_KEY")
let requests = 0
const responses = new Map()
const client = createClient(process.env.DMS_AUDIT_URL, process.env.DMS_AUDIT_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: {
    fetch: async (input, init = {}) => {
      const method = String(init.method || "GET").toUpperCase()
      assert.ok(["GET", "HEAD"].includes(method), "Backtest cannot mutate production")
      assert.ok(!String(input).includes("/rpc/"), "Backtest cannot invoke production RPCs")
      const key = JSON.stringify([String(input), init.headers])
      if (responses.has(key)) return responses.get(key).clone()
      requests++
      const response = await fetch(input, { ...init, signal: AbortSignal.timeout(45000) })
      if (response.ok) responses.set(key, response.clone())
      return response
    },
  },
})
const baselineSource = execFileSync("git", ["show", baselineRef + ":src/App.tsx"], { encoding: "utf8", maxBuffer: 10_000_000 })
const original = await loadPayrollTestModule(client, baselineSource)
const originalResult = await original.fetchOvertimeRequestRows(date, date, false)
assert.ok(originalResult.error, "Original production failure should reproduce")
assert.match(originalResult.error.message, /Data rekap terlalu besar/)
console.log("PASS: original 10,000-row failure reproduced")

// Lift the old ceiling and give offset pages an ID tie-breaker to produce a
// complete all-history reference. Dates/created_at alone are not unique.
// Financial mapping/calculation and filtering remain the old implementation.
const start = baselineSource.indexOf("async function fetchOvertimeRequestRows(")
const end = baselineSource.indexOf("\nasync function ", start + 1)
const oldFunction = baselineSource.slice(start, end)
assert.ok(oldFunction.includes("}, 500, 10000)"), "Unexpected baseline; inspect before backtesting")
const stableFunction = oldFunction.replace("}, 500, 10000)", "}, 500, 100000)")
  .replace('.order("created_at", { ascending: false })', '.order("created_at", { ascending: false }).order("id", { ascending: true })')
const referenceSource = baselineSource.slice(0, start) + stableFunction + baselineSource.slice(end)
const reference = await loadPayrollTestModule(client, referenceSource)
const current = await loadPayrollTestModule(client)
// Freeze the display clock so running-shift labels do not advance between reads.
const RealDate = Date
const auditNow = RealDate.now()
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [auditNow])) }
  static now() { return auditNow }
}
const before = await reference.loadOperationsFoundationData(date, payrollReadOptions)
const started = performance.now()
const after = await current.loadOperationsFoundationData(date, payrollReadOptions)
globalThis.Date = RealDate
const loadMs = Math.round(performance.now() - started)
assert.deepEqual(after.payrollLoadErrors, {})

// Digest comparison avoids dumping private payroll records in assertion output.
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
for (const field of ["rows", "allRows", "payrollPayments", "overtimePayments", "weeklyBonuses", "weeklyBonusPayments", "weeklyBonusPolicies", "leaveRequests"]) {
  if (digest(after[field]) !== digest(before[field])) {
    const changed = new Set()
    after[field].forEach((row, i) => Object.keys(row).forEach((key) => {
      if (digest(row[key]) !== digest(before[field][i]?.[key])) changed.add(key)
    }))
    console.log("Changed fields in " + field + ": " + [...changed].join(", "))
  }
  assert.equal(digest(after[field]), digest(before[field]), field + " changed")
  console.log("PASS: unchanged " + field + " (" + after[field].length + " rows)")
}
const byId = (rows) => [...rows].sort((a, b) => a.id.localeCompare(b.id))
for (const status of ["approved", "pending", "draft"]) {
  const oldRows = byId(before.overtime.filter((r) => r.status === status))
  const newRows = byId(after.overtime.filter((r) => r.status === status))
  if (digest(oldRows) !== digest(newRows)) {
    const oldMap = new Map(oldRows.map((r) => [r.id, r]))
    const newMap = new Map(newRows.map((r) => [r.id, r]))
    const fields = new Set()
    newRows.forEach((row) => {
      const old = oldMap.get(row.id)
      if (old) Object.keys(row).forEach((key) => { if (digest(row[key]) !== digest(old[key])) fields.add(key) })
    })
    console.log(JSON.stringify({ status, before: oldRows.length, beforeUnique: oldMap.size, after: newRows.length, afterUnique: newMap.size,
      onlyBefore: [...oldMap.keys()].filter((id) => !newMap.has(id)).length,
      onlyAfter: [...newMap.keys()].filter((id) => !oldMap.has(id)).length, changedFields: [...fields] }))
  }
  assert.equal(digest(byId(after.overtime.filter((r) => r.status === status))), digest(byId(before.overtime.filter((r) => r.status === status))), status + " overtime changed")
}
const retained = before.overtime.filter((r) => r.status !== "rejected" || ["planned", "manual"].includes(r.requestSource) || r.overtimeDate === date)
assert.equal(digest(byId(after.overtime)), digest(byId(retained)), "Relevant overtime omitted or altered")
const payable = (rows) => byId(rows.filter((r) => r.overtimePaymentPolicy === "separate" && r.status === "approved" && !["paid", "void"].includes(r.overtimePaymentStatus) && r.approvedMinutes > 0 && r.totalAmount > 0))
assert.equal(digest(payable(after.overtime)), digest(payable(before.overtime)), "Payable overtime changed")
const scopedBefore = await reference.fetchOvertimeRequestRows("2026-09-24", "2026-09-24", true)
const scopedAfter = await current.fetchOvertimeRequestRows("2026-09-24", "2026-09-24", true)
assert.equal(scopedBefore.error, null)
assert.equal(scopedAfter.error, null)
assert.equal(digest(byId(scopedAfter.data)), digest(byId(scopedBefore.data)), "Approval history changed")
console.log(JSON.stringify({
  result: "PASS",
  beforeOvertimeRows: before.overtime.length,
  afterOvertimeRows: after.overtime.length,
  currentLoadMs: loadMs,
  readRequests: requests,
  productionWrites: 0,
  salaryCyclesBonusesPaymentsAndApprovalHistoryUnchanged: true,
}))
