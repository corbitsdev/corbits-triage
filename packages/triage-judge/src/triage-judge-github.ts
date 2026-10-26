import { triageJudge } from "./triage-judge.js";

export const TRIAGE_JUDGE_GITHUB_ADDRESS = "triage-judge-github";

export const workflow = triageJudge({ id: TRIAGE_JUDGE_GITHUB_ADDRESS });
