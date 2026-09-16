import { RuleTester } from "oxlint/plugins-dev"
import { describe, it } from "vitest"

// `RuleTester` reads `describe` and `it` off `globalThis` as it loads, and vitest puts
// neither there. Handed them, it registers one test per case; without them it runs every
// case inline as the test file is imported, and vitest reports a file with no tests.
RuleTester.describe = describe
RuleTester.it = it
