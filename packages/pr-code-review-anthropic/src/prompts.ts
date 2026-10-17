import check from "../prompts/check.system.txt" with { type: "text" };
import consolidate from "../prompts/consolidate.system.txt" with { type: "text" };
import finderDiff from "../prompts/finder-diff.system.txt" with { type: "text" };
import finderRepo from "../prompts/finder-repo.system.txt" with { type: "text" };
import finderRepoTools from "../prompts/finder-repo.tools.txt" with { type: "text" };
import plan from "../prompts/plan.system.txt" with { type: "text" };
import write from "../prompts/write.system.txt" with { type: "text" };

/** Imported as text, so the published workflow carries them. */
export const SYSTEM_PROMPTS = { check, consolidate, "finder-diff": finderDiff, "finder-repo": finderRepo, plan, write };

export const TOOL_PROMPTS = { "finder-repo": finderRepoTools };
