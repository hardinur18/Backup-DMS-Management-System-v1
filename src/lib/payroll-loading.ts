export type PayrollSectionErrors = Partial<Record<"overtime" | "bonus" | "history" | "bonusPolicy", string>>

export type IdPageQuery<T> = PromiseLike<{ data: T[] | null; error: unknown }> & {
  order: (column: string, options: { ascending: boolean }) => IdPageQuery<T>
  limit: (count: number) => IdPageQuery<T>
  gt: (column: string, value: string) => IdPageQuery<T>
}

// A stable cursor avoids both the old row ceiling and shifting offset pages.
// Stop on an empty page, not a short page: PostgREST may cap responses below pageSize.
export async function fetchRowsById<T extends { id: unknown }>(
  buildQuery: () => IdPageQuery<T>,
  pageSize = 500,
): Promise<T[]> {
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new Error("Ukuran halaman harus bilangan bulat positif.")
  const rows: T[] = []
  let cursor = ""
  while (true) {
    let query = buildQuery().order("id", { ascending: true }).limit(pageSize)
    if (cursor) query = query.gt("id", cursor)
    const { data, error } = await query
    if (error) throw error
    if (!data?.length) return rows
    for (const row of data) {
      const id = String(row.id || "")
      if (!id || id <= cursor) throw new Error("Urutan data berubah saat dimuat. Klik Refresh Data untuk mencoba lagi.")
      cursor = id
      rows.push(row)
    }
  }
}

// Keep all open/approved requests and planned/manual requests (including rejection
// history for the request dialog). Rejected automatic history outside the displayed
// attendance dates is irrelevant to payroll totals and remains in Approval.
export function payrollOvertimeFilter(startDate: string, endDate: string) {
  return `status.neq.rejected,request_source.in.(planned,manual),and(overtime_date.gte.${startDate},overtime_date.lte.${endDate})`
}

export function sortLoadedOvertimeRows<T extends Record<string, unknown>>(rows: T[]): T[] {
  return rows.sort((a, b) => String(b.overtime_date || "").localeCompare(String(a.overtime_date || ""))
    || String(b.created_at || "").localeCompare(String(a.created_at || ""))
    || String(a.id).localeCompare(String(b.id)))
}
