import { eslintCompatPlugin } from "@oxlint/plugins";

import { noChainedTypeAssertionsRule } from "./rules/no-chained-type-assertions.ts";
import { noModuleMockingRule } from "./rules/no-module-mocking.ts";
import { requireSafetyCommentForTypeAssertionRule } from "./rules/require-safety-comment-for-type-assertion.ts";

/** Generic Oxlint rules that reject low-evidence and low-signal implementation patterns. */
const antiSlopPlugin = eslintCompatPlugin({
	meta: { name: "anti-slop" },
	rules: {
		"no-chained-type-assertions": noChainedTypeAssertionsRule,
		"no-module-mocking": noModuleMockingRule,
		"require-safety-comment-for-type-assertion": requireSafetyCommentForTypeAssertionRule,
	},
});

export default antiSlopPlugin;
