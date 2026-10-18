import { ApiError, type Transport } from "@intx/hub-client";
import { CODE_REVIEW_PROVIDERS } from "@corbits/triage-contracts";
import {
  ANTHROPIC_API,
  ANTHROPIC_CREDENTIAL_NAME,
  ANTHROPIC_PROVIDER,
  DECISION_MODEL_ALIAS,
  INFERENCE_CREDENTIAL_NAME,
  INFERENCE_PROVIDER,
  listAll,
  revokeCredential,
  saveInferenceKey,
  type HubCredential,
  type Inference,
} from "./hub-api.ts";

/** The models Triage's workflows name, each with the catalog provider that serves it. */
export const DECLARED_MODELS = [
  { model: DECISION_MODEL_ALIAS, provider: INFERENCE_PROVIDER },
  { model: CODE_REVIEW_PROVIDERS.anthropic.models.diffFinder, provider: ANTHROPIC_PROVIDER },
  { model: CODE_REVIEW_PROVIDERS.anthropic.models.other, provider: ANTHROPIC_PROVIDER },
] as const;

export type DeclaredModel = (typeof DECLARED_MODELS)[number]["model"];

/** A catalog provider's row, keyed to the vault credential it uses; `quirks` maps a catalog model onto the provider's own model name. */
type ProviderSpec = { name: string; plugin: string; baseURL: string; credential: string; quirks?: Record<string, unknown> };

/** The decision model's provider and offering are written when it is saved (`saveInference`), so a reconcile declares only fixed providers. */
const PROVIDER_SPECS: ProviderSpec[] = [{ name: ANTHROPIC_PROVIDER, plugin: ANTHROPIC_PROVIDER, baseURL: ANTHROPIC_API, credential: ANTHROPIC_CREDENTIAL_NAME }];

type CatalogRow = { id: string; name?: string; canonicalName?: string; baseURL?: string; modelId?: string; providerId?: string; quirks?: Record<string, unknown> | null };

type CatalogRows = "providers" | "models" | "offerings";

function catalogPath(tenantId: string, rows: CatalogRows): string {
  return `/api/tenants/${encodeURIComponent(tenantId)}/catalog/${rows}`;
}

/** Creates a catalog row, or takes the one a concurrent reconcile created first. */
async function createRow(transport: Transport, tenantId: string, rows: CatalogRows, body: Record<string, unknown>, matches: (row: CatalogRow) => boolean): Promise<CatalogRow> {
  try {
    return await transport.fetch<CatalogRow>("POST", catalogPath(tenantId, rows), body);
  } catch (cause) {
    if (!(cause instanceof ApiError && cause.status === 409)) throw cause;
    const raced = (await listAll<CatalogRow>(transport, catalogPath(tenantId, rows))).find(matches);
    if (!raced) throw cause;
    return raced;
  }
}

async function ensureProvider(transport: Transport, tenantId: string, spec: ProviderSpec, credentialId: string, rows: CatalogRow[]): Promise<string> {
  function named(row: CatalogRow): boolean {
    return row.name === spec.name;
  }
  const existing = rows.find(named);
  if (!existing) {
    const body = { name: spec.name, plugin: spec.plugin, baseURL: spec.baseURL, credentialId };
    return (await createRow(transport, tenantId, "providers", body, named)).id;
  }
  if (existing.baseURL !== spec.baseURL) {
    await transport.fetch("PATCH", `${catalogPath(tenantId, "providers")}/${encodeURIComponent(existing.id)}`, { baseURL: spec.baseURL });
  }
  return existing.id;
}

async function ensureModel(transport: Transport, tenantId: string, canonicalName: string, rows: CatalogRow[]): Promise<string> {
  function named(row: CatalogRow): boolean {
    return row.canonicalName === canonicalName;
  }
  const existing = rows.find(named);
  if (existing) return existing.id;
  return (await createRow(transport, tenantId, "models", { canonicalName }, named)).id;
}

async function ensureOffering(transport: Transport, tenantId: string, modelId: string, providerId: string, spec: ProviderSpec, rows: CatalogRow[]): Promise<void> {
  function offered(row: CatalogRow): boolean {
    return row.modelId === modelId && row.providerId === providerId;
  }
  const existing = rows.find(offered);
  if (!existing) {
    await createRow(transport, tenantId, "offerings", { modelId, providerId, priority: 0, ...(spec.quirks && { quirks: spec.quirks }) }, offered);
    return;
  }
  if (spec.quirks && JSON.stringify(existing.quirks) !== JSON.stringify(spec.quirks)) {
    await transport.fetch("PATCH", `${catalogPath(tenantId, "offerings")}/${encodeURIComponent(existing.id)}`, { quirks: spec.quirks });
  }
}

async function listCatalog(transport: Transport, tenantId: string) {
  const [providers, models, offerings] = await Promise.all([
    listAll<CatalogRow>(transport, catalogPath(tenantId, "providers")),
    listAll<CatalogRow>(transport, catalogPath(tenantId, "models")),
    listAll<CatalogRow>(transport, catalogPath(tenantId, "offerings")),
  ]);
  return { providers, models, offerings };
}

/**
 * Adds to the workspace catalog whatever the declared models lack: each model,
 * and its offering through each provider whose key is stored. A catalog
 * provider needs its key, so a model whose key is missing gets its offering
 * on the reconcile after the key is saved.
 */
export async function reconcileModelCatalog(transport: Transport, tenantId: string): Promise<void> {
  const [credentials, { providers, models, offerings }] = await Promise.all([
    listAll<HubCredential>(transport, `/api/tenants/${encodeURIComponent(tenantId)}/credentials`),
    listCatalog(transport, tenantId),
  ]);
  const providerIds = new Map<string, { id: string; spec: ProviderSpec }>();
  for (const spec of PROVIDER_SPECS) {
    const credential = credentials.find((row) => row.name === spec.credential && row.status.toLowerCase() === "active");
    if (credential) providerIds.set(spec.name, { id: await ensureProvider(transport, tenantId, spec, credential.id, providers), spec });
  }
  for (const declared of DECLARED_MODELS) {
    const modelId = await ensureModel(transport, tenantId, declared.model, models);
    const provider = providerIds.get(declared.provider);
    if (provider) await ensureOffering(transport, tenantId, modelId, provider.id, provider.spec, offerings);
  }
}

/** Stores the decision model's key in the vault, then points the catalog's decision offering at its endpoint and model. */
export async function saveInference(transport: Transport, tenantId: string, input: { endpoint: string; model: string; secret: string }): Promise<void> {
  const { endpoint, model, credentialId } = await saveInferenceKey(transport, tenantId, input);
  const { providers, models, offerings } = await listCatalog(transport, tenantId);
  const spec = { name: INFERENCE_PROVIDER, plugin: INFERENCE_PROVIDER, baseURL: endpoint, credential: INFERENCE_CREDENTIAL_NAME, quirks: { model } };
  const providerId = await ensureProvider(transport, tenantId, spec, credentialId, providers);
  const modelId = await ensureModel(transport, tenantId, DECISION_MODEL_ALIAS, models);
  await ensureOffering(transport, tenantId, modelId, providerId, spec, offerings);
}

/** The saved decision model: its catalog provider's endpoint and the model its decision offering names. */
export async function readDecisionModel(transport: Transport, tenantId: string): Promise<Inference | undefined> {
  const { providers, models, offerings } = await listCatalog(transport, tenantId);
  const provider = providers.find((row) => row.name === INFERENCE_PROVIDER);
  const decision = models.find((row) => row.canonicalName === DECISION_MODEL_ALIAS);
  if (!provider?.baseURL || !decision) return undefined;
  const model = offerings.find((row) => row.providerId === provider.id && row.modelId === decision.id)?.quirks?.["model"];
  return typeof model === "string" ? { endpoint: provider.baseURL, model } : undefined;
}

/** The vault refuses to delete a key a catalog provider still uses, so the provider and its offerings go first. */
export async function removeAnthropicKey(transport: Transport, tenantId: string, credentialId: string): Promise<void> {
  const provider = (await listAll<CatalogRow>(transport, catalogPath(tenantId, "providers"))).find((row) => row.name === ANTHROPIC_PROVIDER);
  if (provider) await transport.fetch("DELETE", `${catalogPath(tenantId, "providers")}/${encodeURIComponent(provider.id)}`);
  await revokeCredential(transport, tenantId, credentialId);
}

type ModelInfo = { canonicalName: string; offerings: Array<{ offeringId: string; providerName: string }> };

export type Offerings = { ids: string[]; defaultId: string };

/** The offering of each model a workflow names, its first model's the default; a missing one is an error, so no step falls back to another model. */
export async function offeringsFor(transport: Transport, tenantId: string, names: readonly [DeclaredModel, ...DeclaredModel[]]): Promise<Offerings> {
  const models = await transport.fetch<ModelInfo[]>("GET", `/api/tenants/${encodeURIComponent(tenantId)}/models`);
  function offeringOf(name: DeclaredModel): string {
    const declared = DECLARED_MODELS.find((row) => row.model === name);
    const offering = models.find((model) => model.canonicalName === name)?.offerings.find((o) => o.providerName === declared?.provider);
    if (!offering) throw new Error(`The workspace has no ${name} model. Save its key in Settings.`);
    return offering.offeringId;
  }
  return { ids: names.map(offeringOf), defaultId: offeringOf(names[0]) };
}
