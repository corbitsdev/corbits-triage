/** The models code review runs on: Opus for the diff finder, which found most of the bugs in the eval, and Haiku for every other step. */
export const CODE_REVIEW_MODELS = { diffFinder: "claude-opus-5-5", other: "claude-haiku-5-5" } as const;
