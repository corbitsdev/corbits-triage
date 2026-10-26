import { ApiError, type Transport } from "@intx/hub-client";
import { CODE_REVIEW_PROVIDERS } from "@corbits/triage-contracts";
import {
  ANTHROPIC_API,
  ANTHROPIC_CREDENTIAL_NAME,
  ANTHROPIC_PROVIDER,
  DECISION_MODEL_ALIAS,
  INFERENCE_PROVIDER,
  catalogPath,
  isActiveCredential,
  listAll,
  listCatalog,
  revokeCredential,
  saveInferenceKey,
  type Catalog,
  type CatalogRow,
  type HubCredential,
} from "./hub-api.ts";

/** The models Triage's workflows name, each with the catalog provider that serves it. */
const DECLARED_MODELS = [
  { model: DECISION_MODEL_ALIAS, provider: INFERENCE_PROVIDER },
  { model: CODE_REVIEW_PROVIDERS.anthropic.models.diffFinder, provider: ANTHROPIC_PROVIDER },
  { model: CODE_REVIEW_PROVIDERS.anthropic.models.other, provider: ANTHROPIC_PROVIDER },
] as const;

export type DeclaredModel = (typeof DECLARED_MODELS)[number]["model"];

/** A catalog provider's row; `quirks` maps a catalog model onto the provider's own model name. */
type ProviderSpec = { name: string; plugin: string; baseURL: string; quirks?: Record<string, unknown> };

/** The decision model's provider and offering are written when it is saved, so a reconcile declares only fixed providers, each with the vault credential it uses. */
const PROVIDER_SPECS: Array<ProviderSpec & { credential: string }> = [{ name: ANTHROPIC_PROVIDER, plugin: ANTHROPIC_PROVIDER, baseURL: ANTHROPIC_API, credential: ANTHROPIC_CREDENTIAL_NAME }];

/** Creates a catalog row, or takes the one a concurrent reconcile created first. */
async function createRow(transport: Transport, tenantId: string, rows: keyof Catalog, body: Record<string, unknown>, matches: (row: CatalogRow) => boolean): Promise<CatalogRow> {
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
    const credential = credentials.find((row) => row.name === spec.credential && isActiveCredential(row));
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
  const spec = { name: INFERENCE_PROVIDER, plugin: INFERENCE_PROVIDER, baseURL: endpoint, quirks: { model } };
  const providerId = await ensureProvider(transport, tenantId, spec, credentialId, providers);
  const modelId = await ensureModel(transport, tenantId, DECISION_MODEL_ALIAS, models);
  await ensureOffering(transport, tenantId, modelId, providerId, spec, offerings);
}

/** The vault refuses to delete a key a catalog provider still uses, so the provider and its offerings go first. */
export async function removeModelKey(transport: Transport, tenantId: string, providerName: string, credentialId: string): Promise<void> {
  const provider = (await listAll<CatalogRow>(transport, catalogPath(tenantId, "providers"))).find((row) => row.name === providerName);
  if (provider) await transport.fetch("DELETE", `${catalogPath(tenantId, "providers")}/${encodeURIComponent(provider.id)}`);
  await revokeCredential(transport, tenantId, credentialId);
}

type ModelInfo = { canonicalName: string; offerings: Array<{ offeringId: string; providerName: string }> };

export type Offerings = { ids: string[]; defaultId: string };

export async function listModels(transport: Transport, tenantId: string): Promise<ModelInfo[]> {
  return transport.fetch<ModelInfo[]>("GET", `/api/tenants/${encodeURIComponent(tenantId)}/models`);
}

function offeringOf(models: readonly ModelInfo[], name: DeclaredModel): string | undefined {
  const declared = DECLARED_MODELS.find((row) => row.model === name);
  return models.find((model) => model.canonicalName === name)?.offerings.find((o) => o.providerName === declared?.provider)?.offeringId;
}

/** The offering of each model a workflow names, its first model's the default; undefined while the workspace lacks any of them. */
export function offeringsIn(models: readonly ModelInfo[], names: readonly [DeclaredModel, ...DeclaredModel[]]): Offerings | undefined {
  const ids: string[] = [];
  for (const name of names) {
    const id = offeringOf(models, name);
    if (!id) return undefined;
    ids.push(id);
  }
  return { ids, defaultId: ids[0]! };
}

/** As `offeringsIn`, but a missing model is an error, so no step falls back to another model. */
export async function offeringsFor(transport: Transport, tenantId: string, names: readonly [DeclaredModel, ...DeclaredModel[]]): Promise<Offerings> {
  const models = await listModels(transport, tenantId);
  const offerings = offeringsIn(models, names);
  if (offerings) return offerings;
  const missing = names.find((name) => offeringOf(models, name) === undefined);
  throw new Error(`The workspace has no ${missing} model. Save its key in Settings.`);
}
