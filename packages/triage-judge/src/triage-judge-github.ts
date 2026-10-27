import { TRIAGE_JUDGES } from "@corbits/triage-contracts";
import { triageJudge } from "./triage-judge.js";

export const workflow = triageJudge({ id: TRIAGE_JUDGES.github });
