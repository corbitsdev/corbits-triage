import { TRIAGE_LISTENERS } from "@corbits/triage-contracts";
import { triageListener } from "./triage-listener.js";

export const workflow = triageListener({ id: TRIAGE_LISTENERS["bitbucket-datacenter"] });
