import check from "../prompts/check.system.txt" with { type: "text" };
import checkTools from "../prompts/check.tools.txt" with { type: "text" };
import diffTools from "../prompts/diff.tools.txt" with { type: "text" };
import finderDiff from "../prompts/finder-diff.system.txt" with { type: "text" };

/** Imported as text, so the published workflow carries them. */
export const SYSTEM_PROMPTS = { check, "finder-diff": finderDiff };
export const TOOL_PROMPTS = { check: checkTools, diff: diffTools };
