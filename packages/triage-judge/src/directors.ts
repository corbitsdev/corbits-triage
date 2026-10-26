import { mailDirectorOf } from "@corbits/triage-manager/mail";
import { triageJudgeDirector, triageJudgeDirectorFactory } from "@corbits/triage-workflows/directors";

/** Set by the workflow build to the published package name; source runs use the workspace package. */
declare const WORKFLOW_PACKAGE_NAME: string | undefined;

const packageName = typeof WORKFLOW_PACKAGE_NAME === "undefined" ? "@corbits/triage-judge" : WORKFLOW_PACKAGE_NAME;

export const mailDirector = mailDirectorOf(packageName);

export const mailDirectorFactory = mailDirector.factory;

export { triageJudgeDirector, triageJudgeDirectorFactory };
