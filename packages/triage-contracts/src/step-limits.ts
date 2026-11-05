/** The longest one attempt of a judge's step may take. */
export const JUDGE_STEP_TIMEOUT_MS = 15 * 60_000;
/** The longest a judge can run: its rules, then its model checks, then their parts, one attempt of each. */
export const JUDGE_RUN_MS = 3 * JUDGE_STEP_TIMEOUT_MS;

/** The longest one attempt of a code review's step may take. */
export const CODE_REVIEW_STEP_TIMEOUT_MS = 10 * 60_000;
/** The longest a code review can run: its checkout, then its finders, then its checks, one attempt of each. */
export const CODE_REVIEW_RUN_MS = 3 * CODE_REVIEW_STEP_TIMEOUT_MS;
