import { build } from "esbuild"
import { readFile, mkdir, writeFile, rm } from "node:fs/promises"
import { resolve, dirname } from "node:path"
import { pathToFileURL, fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../../", import.meta.url))

// Exercise the actual application loader and renderer, without exposing test
// exports in the production application or allowing database writes.
export async function loadPayrollTestModule(client, source) {
  globalThis.__payrollTestClient = client
  const contents = source ?? await readFile(resolve(root, "src/App.tsx"), "utf8")
  const result = await build({
    stdin: {
      contents: contents + "\nexport { loadOperationsFoundationData, fetchOvertimeRequestRows, PayrollPreviewTable };",
      resolveDir: resolve(root, "src"),
      loader: "tsx",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    write: false,
    jsx: "automatic",
    define: { "import.meta.env": "{}" },
    loader: { ".jpeg": "dataurl", ".css": "empty" },
    plugins: [{
      name: "read-only-test-client",
      setup(build) {
        build.onResolve({ filter: /\/lib\/supabase$/ }, () => ({ path: "client", namespace: "payroll-test" }))
        build.onLoad({ filter: /.*/, namespace: "payroll-test" }, () => ({
          contents: "export const supabase = globalThis.__payrollTestClient; export const isSupabaseConfigured = true; export const supabaseConfigError = '';",
          loader: "js",
        }))
      },
    }],
  })
  const filename = resolve(root, "node_modules/.cache", `payroll-test-${process.pid}-${Math.random().toString(36).slice(2)}.mjs`)
  await mkdir(dirname(filename), { recursive: true })
  await writeFile(filename, result.outputFiles[0].text)
  try {
    return await import(pathToFileURL(filename).href)
  } finally {
    await rm(filename, { force: true })
    delete globalThis.__payrollTestClient
  }
}

export const payrollReadOptions = {
  overtimeDateScoped: false,
  includeAllPayrollCycles: true,
  includePayrollPayments: true,
  includeOvertimePayments: true,
  includeWeeklyBonuses: true,
  includeWeeklyBonusPayments: true,
  includeWeeklyBonusPolicies: true,
}
