import { describeProvisionerConformance } from "@corbits/provisioner-conformance";
import { createMemoryBackend, createTemplateSidecarProvisioner } from "./index.js";

describeProvisionerConformance("template", async () => {
  const backend = createMemoryBackend();
  return {
    provisioner: createTemplateSidecarProvisioner({ backend }),
    async live(allocationId) {
      return (await backend.list(allocationId)).map(({ generation, sidecarId }) => ({ generation, sidecarId }));
    },
    capabilityChecks: {},
    async dispose() {},
  };
});
