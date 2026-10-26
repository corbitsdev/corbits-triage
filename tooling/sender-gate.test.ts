import { expect, test } from "bun:test";

import { workflow as listenerBitbucket } from "../packages/triage-manager/src/triage-listener-bitbucket-datacenter";
import { workflow as listenerGithub } from "../packages/triage-manager/src/triage-listener-github";
import { evaluateMailAdmission, type MailAcceptCoordinate } from "../vendor/interchange/packages/authz/src/index";
// Stock's first-fire derivation is not exported; the hub's materializer runs exactly this before a run starts.
import { deriveMailAcceptGrantRows } from "../vendor/interchange/packages/hub-api/src/run-grant-materialization";
import { collectMailAcceptGrants } from "../vendor/interchange/packages/workflow-deploy/src/index";

const TENANT = "tnt_acme";
const HUB: MailAcceptCoordinate[] = [{ coordType: "principal", id: "prn_github" }, { coordType: "tenant", id: TENANT }];
const OTHER_TENANT: MailAcceptCoordinate[] = [{ coordType: "principal", id: "prn_stranger" }, { coordType: "tenant", id: "tnt_other" }];

const DEPLOYED = { listenerGithub, listenerBitbucket };

/** Whether stock's sender gate lets `sender` fire a fresh deployment of `definition` in the hub's tenant. */
async function admits(definition: (typeof DEPLOYED)[keyof typeof DEPLOYED], sender: MailAcceptCoordinate[] | null) {
  const snapshot = { perStep: [{ stepId: "events", grants: collectMailAcceptGrants(definition), grantEffects: {} }], grantRequirements: [] };
  const rows = deriveMailAcceptGrantRows(snapshot, { invokerPrincipalId: null, assetId: "ast_workflow", tenantId: TENANT, runPrincipalId: "prn_run", legacyMailAccept: null }, new Date());
  const { admit } = await evaluateMailAdmission({ senderCoordinates: sender, recipientGrants: rows.map((row) => ({ ...row, roleId: null })) });
  return admit;
}

test("every deployed workflow admits the hub's mail and refuses another tenant's or an unknown sender's", async () => {
  for (const [name, definition] of Object.entries(DEPLOYED)) {
    expect([name, await admits(definition, HUB)]).toEqual([name, true]);
    expect([name, await admits(definition, OTHER_TENANT)]).toEqual([name, false]);
    expect([name, await admits(definition, null)]).toEqual([name, false]);
  }
});
