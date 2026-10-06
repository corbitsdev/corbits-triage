import { INFERENCE_CREDENTIAL_NAME, type HubCredential } from "./hub-api.ts";

export type DecisionModelPreset = {
  id: "typesafe" | "vercel" | "custom";
  label: string;
  endpoint: string;
  model: string;
  keyLabel: string;
};

export const DECISION_MODEL_PRESETS = [
  { id: "typesafe", label: "TypeSafe (Jev)", endpoint: "https://api.typesafe.ai/v1", model: "jev-latest", keyLabel: "TypeSafe API key" },
  { id: "vercel", label: "Vercel AI Gateway (Jev)", endpoint: "https://ai-gateway.vercel.sh/typesafe/v1", model: "typesafe-ai/jev", keyLabel: "AI Gateway API key" },
  { id: "custom", label: "Add my own provider", endpoint: "", model: "", keyLabel: "API key" },
] as const satisfies readonly DecisionModelPreset[];

/** A workspace with no saved model starts on TypeSafe; a saved model that matches no preset is custom. */
export function presetFor(saved: { endpoint: string; model: string } | undefined): DecisionModelPreset {
  if (!saved) return DECISION_MODEL_PRESETS[0];
  const match = DECISION_MODEL_PRESETS.find((preset) => preset.endpoint === saved.endpoint && preset.model === saved.model);
  return match ?? DECISION_MODEL_PRESETS[2];
}

export function hasDecisionModelCredential(credentials: ReadonlyArray<HubCredential>): boolean {
  return credentials.some((credential) =>
    credential.status === "active"
    && (credential.name === INFERENCE_CREDENTIAL_NAME || credential.name.startsWith(`${INFERENCE_CREDENTIAL_NAME}:`)));
}

export const DECISION_MODEL_INTRO = "Corbits Triage uses decision models to make triage fast and cost-effective. Add your preferred System One–compatible model and provider.";
