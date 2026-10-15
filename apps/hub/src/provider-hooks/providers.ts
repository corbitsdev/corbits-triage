import { BITBUCKET_DATACENTER_HOOK_HEADERS } from "@corbits/common/hook-metadata";
import { normalizeBitbucket } from "../bitbucket-datacenter/normalize.js";
import { bitbucketConnection, HOOK_CREDENTIAL } from "../bitbucket-datacenter/records.js";
import type { ProviderHook } from "./intake.js";

export const PROVIDER_HOOKS: ReadonlyMap<string, ProviderHook> = new Map([
  [
    "bitbucket-datacenter",
    {
      source: "bitbucket-datacenter",
      credential: HOOK_CREDENTIAL,
      headers: BITBUCKET_DATACENTER_HOOK_HEADERS,
      normalize: normalizeBitbucket,
      ownUser: function tokenUser(ns) {
        return bitbucketConnection(ns)?.user;
      },
    },
  ],
]);
