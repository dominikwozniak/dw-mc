import { eslintCompatPlugin } from "@oxlint/plugins"

import { noGhWritesRule } from "./rules/no-gh-writes.ts"

/** This repository's own lint rules. Nothing vendored lives here, so a refresh never touches it. */
const dwMcPlugin = eslintCompatPlugin({
  meta: { name: "dw-mc" },
  rules: {
    "no-gh-writes": noGhWritesRule
  }
})

export default dwMcPlugin
