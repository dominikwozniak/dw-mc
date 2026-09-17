import { defineConfig } from "tsdown"

import packageJson from "./package.json" with { type: "json" }

export default defineConfig({
  // The CLI is the whole package: one entry, no declaration files, nothing to import.
  // Dependencies stay external on tsdown's own default, which is the decision ADR 0008
  // records - Effect is on a release candidate, and an install has to be able to move it.
  entry: "src/cli/bin.ts",
  target: "node24",
  dts: false,
  // `bin` names one file, and a package that is already `"type": "module"` gains nothing
  // from spelling the extension a second way.
  outExtensions: () => ({ js: ".js" }),
  // The only reader of a stack trace from this bundle is me.
  sourcemap: true,
  // What `dw-mc --version` reports, stamped in so it cannot drift from the registry.
  define: { __VERSION__: JSON.stringify(packageJson.version) }
})
