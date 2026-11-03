import { rulesMailDirector } from "./rules-mail.js";

export { triageJudgeDirector, triageJudgeDirectorFactory } from "@corbits/triage-workflows/directors";
export { rulesMailDirector };
export const rulesMailDirectorFactory = rulesMailDirector.factory;
