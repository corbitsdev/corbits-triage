import { TRIAGE_LISTENERS } from "@corbits/triage-contracts";
import { publishedFor } from "./release.js";
import { triageListener } from "./triage-listener.js";

export const workflow = triageListener({ id: TRIAGE_LISTENERS["github"], manager: publishedFor("github", "manager") });
