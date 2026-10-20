import type { AdapterManifest } from "@intx/types";

export const SIDECAR_ADAPTER_MANIFEST: AdapterManifest = [
  {
    provider: "corbits-system-one",
    specifier: "@corbits/system-one",
    export: "createSystemOneAdapterFactory",
  },
];
