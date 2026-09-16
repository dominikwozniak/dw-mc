import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "tools/oxlint/**/*.test.ts"],
    setupFiles: ["tools/oxlint/rule-tester.setup.ts"]
  }
})
