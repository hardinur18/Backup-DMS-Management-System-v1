import assert from "node:assert/strict"
import { test } from "node:test"
import { readFile } from "node:fs/promises"
import ts from "typescript"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { loadPayrollTestModule, payrollReadOptions } from "./helpers/payroll-test-module.mjs"

const source = await readFile(new URL("../src/lib/payroll-loading.ts", import.meta.url), "utf8")
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText
const { fetchRowsById, sortLoadedOvertimeRows } = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"))
const records = (count) => Array.from({ length: count }, (_, i) => ({ id: String(i + 1).padStart(8, "0") }))

function cursorQuery(rows, { cap = Infinity, failAt = Infinity, unordered = false } = {}) {
  let calls = 0
  return () => {
    let limit = 500, cursor = ""
    const query = {
      order: () => query,
      limit: (value) => { limit = value; return query },
      gt: (_, value) => { cursor = value; return query },
      then: (resolve, reject) => {
        calls++
        const data = unordered ? rows : rows.filter((r) => r.id > cursor).slice(0, Math.min(limit, cap))
        return Promise.resolve(calls === failAt ? { error: new Error("query failed"), data: null } : { data, error: null }).then(resolve, reject)
      },
    }
    return query
  }
}

for (const count of [0, 1, 500, 10000, 10051, 25000]) {
  test(`cursor loads all ${count} rows, including exact page boundaries`, async () => {
    const expected = records(count)
    assert.deepEqual(await fetchRowsById(cursorQuery(expected)), expected)
  })
}
test("backend response cap below requested page size does not truncate data", async () => {
  const expected = records(1251)
  assert.deepEqual(await fetchRowsById(cursorQuery(expected, { cap: 100 })), expected)
})
test("mid-load failure rejects instead of publishing incomplete totals", async () => {
  await assert.rejects(fetchRowsById(cursorQuery(records(1001), { failAt: 2 })), /query failed/)
})
test("bad cursor and page size cannot silently loop or return partial data", async () => {
  await assert.rejects(fetchRowsById(cursorQuery([{ id: "2" }, { id: "1" }], { unordered: true })), /Urutan data/)
  await assert.rejects(fetchRowsById(cursorQuery([{ id: "" }], { unordered: true })), /Urutan data/)
  await assert.rejects(fetchRowsById(cursorQuery([]), 0), /Ukuran halaman/)
})
test("loaded overtime retains newest date and creation ordering", () => {
  const rows = [{ id: "b", overtime_date: "2026-11-24", created_at: "02" }, { id: "a", overtime_date: "2026-11-25", created_at: "01" }, { id: "c", overtime_date: "2026-11-24", created_at: "03" }]
  assert.deepEqual(sortLoadedOvertimeRows(rows).map((r) => r.id), ["a", "c", "b"])
})

// Fluent mock supplies minimal business fixtures. Every mutation is forbidden.
function fixtureClient(failedTable = "", failedRpc = false) {
  const db = {
    employees: [{ id: "employee-1", employee_code: "TEST-001", full_name: "Payroll Test", status: "active", salary_type: "monthly", payroll_eligible: true }],
    payroll_cycles: [{ id: "cycle-1", employee_id: "employee-1", cycle_number: 1, work_days_count: 26, target_work_days: 26, gross_amount: 1800000, overtime_amount: 10000, net_amount: 1810000, status: "ready", period_started_at: "2026-10-25", period_closed_at: "2026-11-24" }],
  }
  return {
    rpc: () => {
      if (failedRpc) return Promise.resolve({ data: null, error: { code: "57014", message: "bonus timeout" } })
      throw new Error("Mutations forbidden in tests")
    },
    from(table) {
      let start = 0, end = Infinity
      const query = new Proxy({}, {
        get(_, key) {
          if (key === "then") return (resolve, reject) => Promise.resolve(table === failedTable
            ? { data: null, error: { code: "57014", message: "fixture timeout" } }
            : { data: (db[table] || []).slice(start, end), error: null }).then(resolve, reject)
          if (["insert", "update", "delete", "upsert"].includes(key)) throw new Error("Mutations forbidden")
          return (...args) => {
            if (key === "range") { start = args[0]; end = args[1] + 1 }
            return query
          }
        },
      })
      return query
    },
  }
}

function previewProps(data, errorMessage = "") {
  return {
    rows: data.rows, payments: data.payrollPayments, overtimeRows: data.overtime,
    overtimePayments: data.overtimePayments, weeklyBonuses: data.weeklyBonuses,
    weeklyBonusPayments: data.weeklyBonusPayments, weeklyBonusPolicies: data.weeklyBonusPolicies,
    shifts: data.shifts, sectionErrors: data.payrollLoadErrors, loading: false,
    errorMessage, overtimeTotal: 0, focusTab: null,
    onFocusTabConsumed() {}, onProcess() {}, onPayOvertime() {}, onVoidOvertimePayment() {},
    onPayWeeklyBonus() {}, onVoidWeeklyBonusPayment() {}, onOpenWeeklyBonusSettings() {},
  }
}

test("real loader isolates supplementary failures, preserves salary and shows an honest error", async () => {
  for (const [table, section] of [
    ["overtime_requests", "overtime"],
    ["weekly_shift_bonus_cycles", "bonus"],
    ["weekly_bonus_policies", "bonusPolicy"],
    ["payroll_payments", "history"],
    ["overtime_payments", "history"],
    ["weekly_shift_bonus_payments", "history"],
  ]) {
    const app = await loadPayrollTestModule(fixtureClient(table))
    const data = await app.loadOperationsFoundationData("2026-11-25", payrollReadOptions)
    assert.match(data.payrollLoadErrors[section], /timeout/)
    assert.equal(data.rows[0].payrollAmount, 1810000)
    assert.equal(data.rows[0].cycleDays, 26)
    assert.equal(data.rows[0].payrollStatus, "ready")
    const html = renderToStaticMarkup(React.createElement(app.PayrollPreviewTable, previewProps(data)))
    assert.match(html, /Payroll Test/)
    assert.match(html, /1\.810\.000/)
    assert.match(html, /bukan saldo nol/)
    assert.match(html, /role="alert"/)
  }
})
test("core salary failure still blocks payroll; approval does not accept incomplete overtime", async () => {
  const payroll = await loadPayrollTestModule(fixtureClient("payroll_cycles"))
  await assert.rejects(payroll.loadOperationsFoundationData("2026-11-25", payrollReadOptions), { message: "fixture timeout" })
  const approval = await loadPayrollTestModule(fixtureClient("overtime_requests"))
  await assert.rejects(approval.loadOperationsFoundationData("2026-11-25"), { message: "fixture timeout" })
})
test("bonus refresh failure is flagged even when its older saved data loads", async () => {
  const app = await loadPayrollTestModule(fixtureClient("", true))
  const data = await app.loadOperationsFoundationData("2026-11-25", { ...payrollReadOptions, refreshWeeklyBonus: true })
  assert.match(data.payrollLoadErrors.bonus, /timeout/)
  assert.equal(data.rows[0].payrollAmount, 1810000)
})
test("successful retry clears section errors; global error never renders zero-balance summaries", async () => {
  const app = await loadPayrollTestModule(fixtureClient())
  const data = await app.loadOperationsFoundationData("2026-11-25", payrollReadOptions)
  assert.deepEqual(data.payrollLoadErrors, {})
  const success = renderToStaticMarkup(React.createElement(app.PayrollPreviewTable, previewProps(data)))
  assert.doesNotMatch(success, /bukan saldo nol/)
  const failed = renderToStaticMarkup(React.createElement(app.PayrollPreviewTable, previewProps(data, "Network failed")))
  assert.match(failed, /Gaji belum berhasil dimuat/)
  assert.doesNotMatch(failed, /Rp\s*0/)
})
