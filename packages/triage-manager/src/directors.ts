import { mailDirectorOf } from "./mail.js";

/** Set by the workflow build to the published package name; source runs use the workspace package. */
declare const WORKFLOW_PACKAGE_NAME: string | undefined;

export const mailDirector = mailDirectorOf(typeof WORKFLOW_PACKAGE_NAME === "undefined" ? "@corbits/triage-manager" : WORKFLOW_PACKAGE_NAME);

export const mailDirectorFactory = mailDirector.factory;
