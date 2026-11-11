/**
 * db/settings/pricing.ts — Pricing data CRUD (user overrides, LiteLLM sync, models.dev sync).
 */

import { getDbInstance } from "../core";
import { backupDbFile } from "../backup";
import { invalidateDbCache } from "../readCache";
import { PROVIDER_ID_TO_ALIAS } from "@omniroute/open-sse/config/providerModels.ts";
import { invalidateUserPricingMemo } from "@/lib/catalogUserPricing";
import { remapHistoricalLitellmRows } from "@/lib/litellmProviderMap";
import { type JsonRecord, toRecord } from "./shared";

type PricingModels = Record<string, JsonRecord>;
type PricingByProvider = Record<string, PricingModels>;
export type PricingSource = "default" | "litellm" | "modelsDev" | "user";
export type PricingSourceMap = Record<string, Record<string, PricingSource>>;

async function touchPricing(): Promise<void> {
  invalidateDbCache("pricing");
  invalidateUserPricingMemo();
  try {
    const { clearTierCache } = await import("@omniroute/open-sse/services/tierResolver");
    clearTierCache();
  } catch {
    // fail-open: a missed tier invalidation must never break a price write
  }
}

function readPricingNamespace(
  db: ReturnType<typeof getDbInstance>,
  namespace: string
): PricingByProvider {
  const rows = db.prepare("SELECT key, value FROM key_value WHERE namespace = ?").all(namespace);
  const pricing: PricingByProvider = {};

  for (const row of rows) {
    const record = toRecord(row);
    const key = typeof record.key === "string" ? record.key : null;
    const rawValue = typeof record.value === "string" ? record.value : null;
    if (!key || rawValue === null) continue;

    try {
      pricing[key] = toRecord(JSON.parse(rawValue)) as PricingModels;
    } catch {
      // Corrupted data — skip silently, fallback to lower layers
    }
  }

  return pricing;
}

function mergePricingLayers(layers: PricingByProvider[]): PricingByProvider {
  const mergedPricing: PricingByProvider = {};

  for (const layer of layers) {
    for (const [provider, models] of Object.entries(layer)) {
      if (!mergedPricing[provider]) {
        mergedPricing[provider] = { ...models };
        continue;
      }

      for (const [model, pricing] of Object.entries(models)) {
        mergedPricing[provider][model] = mergedPricing[provider][model]
          ? { ...(mergedPricing[provider][model] || {}), ...toRecord(pricing) }
          : pricing;
      }
    }
  }

  return mergedPricing;
}

function buildPricingSourceMap(layers: {
  defaults: PricingByProvider;
  litellm: PricingByProvider;
  modelsDev: PricingByProvider;
  user: PricingByProvider;
}): PricingSourceMap {
  const sourceMap: PricingSourceMap = {};
  const mergedPricing = mergePricingLayers([
    layers.defaults,
    layers.litellm,
    layers.modelsDev,
    layers.user,
  ]);

  for (const [provider, models] of Object.entries(mergedPricing)) {
    sourceMap[provider] = {};

    for (const model of Object.keys(models)) {
      if (layers.user[provider]?.[model]) {
        sourceMap[provider][model] = "user";
      } else if (layers.modelsDev[provider]?.[model]) {
        sourceMap[provider][model] = "modelsDev";
      } else if (layers.litellm[provider]?.[model]) {
        sourceMap[provider][model] = "litellm";
      } else {
        sourceMap[provider][model] = "default";
      }
    }
  }

  return sourceMap;
}

export async function getPricingLayers() {
  const db = getDbInstance();

  // Layer 1: Hardcoded defaults (lowest priority)
  const { getDefaultPricing } = await import("@/shared/constants/pricing");
  const litellm = readPricingNamespace(db, "pricing_synced");
  remapHistoricalLitellmRows(litellm);
  return {
    defaults: getDefaultPricing(),
    litellm,
    modelsDev: readPricingNamespace(db, "models_dev_pricing"),
    user: readPricingNamespace(db, "pricing"),
  };
}

export async function getPricing() {
  const layers = await getPricingLayers();
  // Merge: defaults → LiteLLM → models.dev → user (each layer overrides the previous)
  return mergePricingLayers([layers.defaults, layers.litellm, layers.modelsDev, layers.user]);
}

export async function getPricingWithSources(): Promise<{
  pricing: PricingByProvider;
  sourceMap: PricingSourceMap;
}> {
  const layers = await getPricingLayers();
  return {
    pricing: mergePricingLayers([layers.defaults, layers.litellm, layers.modelsDev, layers.user]),
    sourceMap: buildPricingSourceMap(layers),
  };
}

/** Case-insensitive key lookup; returns the first matching key in insertion order. */
type PricingKeyFinder = <T>(
  obj: Record<string, T> | undefined | null,
  key: string
) => T | undefined;

function findKeyInsensitive<T>(obj: Record<string, T> | undefined | null, key: string) {
  if (!obj || !key) return undefined;
  const lowerKey = key.toLowerCase();
  for (const [k, v] of Object.entries(obj)) {
    if (k.toLowerCase() === lowerKey) return v;
  }
  return undefined;
}

/**
 * Provider half of {@link getPricingForModel}: the provider's model table in a merged
 * pricing table, matched by id, alias, reverse alias, then without a `-cn` suffix.
 * Pure, so the `/v1/models` catalog can resolve prices with the same rules from one
 * in-memory table (`find` lets it pass an indexed finder with identical semantics).
 */
export function findProviderPricing(
  pricing: PricingByProvider,
  provider: string,
  find: PricingKeyFinder = findKeyInsensitive
): PricingModels | null {
  const pLower = (provider || "").toLowerCase();
  let providerPricing = find<PricingModels>(pricing, pLower);

  if (!providerPricing) {
    const alias = find<string>(PROVIDER_ID_TO_ALIAS, pLower);
    if (alias) providerPricing = find(pricing, alias);
  }

  if (!providerPricing) {
    for (const [id, mappedAlias] of Object.entries(PROVIDER_ID_TO_ALIAS)) {
      if (typeof mappedAlias === "string" && mappedAlias.toLowerCase() === pLower) {
        providerPricing = find(pricing, id);
        if (providerPricing) break;
      }
    }
  }

  if (!providerPricing) {
    const np = pLower.replace(/-cn$/, "");
    if (np && np !== pLower) {
      providerPricing = find(pricing, np);
    }
  }

  return providerPricing || null;
}

/** Model half of {@link getPricingForModel}: exact id, then dots replaced by hyphens. */
export function findModelPricing(
  providerPricing: PricingModels,
  model: string,
  find: PricingKeyFinder = findKeyInsensitive
): JsonRecord | null {
  const mLower = (model || "").toLowerCase();
  return (
    find<JsonRecord>(providerPricing, mLower) ||
    find<JsonRecord>(providerPricing, mLower.replace(/\./g, "-")) ||
    null
  );
}

function providerAlias(provider: string): string | undefined {
  const direct = PROVIDER_ID_TO_ALIAS[provider];
  if (typeof direct === "string") return direct.toLowerCase();
  const found = Object.entries(PROVIDER_ID_TO_ALIAS).find(([id]) => id.toLowerCase() === provider);
  return typeof found?.[1] === "string" ? found[1].toLowerCase() : undefined;
}

function canonicalIdsForAlias(alias: string): string[] {
  return Object.entries(PROVIDER_ID_TO_ALIAS)
    .filter(([, mapped]) => typeof mapped === "string" && mapped.toLowerCase() === alias)
    .map(([id]) => id.toLowerCase());
}

export interface PricingLayerSet {
  user: PricingByProvider;
  modelsDev: PricingByProvider;
  litellm: PricingByProvider;
  defaults: PricingByProvider;
}

/**
 * Keys that may hold this provider's price. The requested id is first so two
 * explicit user rows resolve to the id the caller named. The alias and the
 * canonical id follow, for a row that was saved on the other key.
 */
export function pricingProviderCandidates(provider: string): string[] {
  const key = (provider || "").trim().toLowerCase();
  if (!key) return [];
  const seeds = [key];
  const stripped = key.replace(/-cn$/, "");
  if (stripped && stripped !== key) seeds.push(stripped);
  const ordered: string[] = [];
  for (const seed of seeds) {
    ordered.push(seed);
    const alias = providerAlias(seed);
    if (alias) ordered.push(alias);
    ordered.push(...canonicalIdsForAlias(seed));
  }
  return [...new Set(ordered)];
}

const PRICING_LAYER_PRECEDENCE = ["user", "modelsDev", "litellm", "defaults"] as const;

function layerHasProviderTable(
  layer: PricingByProvider,
  providerKey: string,
  find: PricingKeyFinder
): boolean {
  const table = find<PricingModels>(layer, providerKey);
  return !!table && Object.keys(table).length > 0;
}

/**
 * Price one model across the provider id and its alias.
 *
 * A user-layer row on any candidate key beats a synced or shipped row on every
 * key. Within one layer, the requested key wins, then the alias, then the
 * canonical id. That is the collision rule: two explicit overrides of the same
 * model stay distinct, and the lookup uses the one stored on the id it was
 * given.
 *
 * Shipped rows on a sibling key are not used once the requested key has any
 * user row. Otherwise a catalog tier on the alias (Codex prices live on `cx`)
 * would satisfy a more specific model key before the caller's base-id override
 * on `codex`. When the requested key has no user row, a missing model still
 * falls through to the alias or the canonical catalog.
 */
export function findLayeredModelPricing(
  layers: PricingLayerSet,
  provider: string,
  model: string,
  find: PricingKeyFinder = findKeyInsensitive
): JsonRecord | null {
  const keys = pricingProviderCandidates(provider);
  if (keys.length === 0) return null;
  const requestedKey = keys[0];
  const requestedHasUserTable = layerHasProviderTable(layers.user, requestedKey, find);

  for (const layerName of PRICING_LAYER_PRECEDENCE) {
    const siblingCatalog = layerName !== "user" && requestedHasUserTable;
    const candidateKeys = siblingCatalog ? [requestedKey] : keys;
    for (const providerKey of candidateKeys) {
      const table = find<PricingModels>(layers[layerName], providerKey);
      if (!table) continue;
      const row = findModelPricing(table, model, find);
      if (row) return row;
    }
  }
  return null;
}

export async function getPricingForModel(provider: string, model: string) {
  const { getCachedPricingLayers } = await import("../readCache");
  const layers = (await getCachedPricingLayers()) as unknown as PricingLayerSet;
  return findLayeredModelPricing(layers, provider, model);
}

export async function updatePricing(pricingData: PricingByProvider) {
  const db = getDbInstance();
  const insert = db.prepare(
    "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('pricing', ?, ?)"
  );

  const rows = db.prepare("SELECT key, value FROM key_value WHERE namespace = 'pricing'").all();
  const existing: PricingByProvider = {};
  for (const row of rows) {
    const record = toRecord(row);
    const key = typeof record.key === "string" ? record.key : null;
    const rawValue = typeof record.value === "string" ? record.value : null;
    if (!key || rawValue === null) continue;
    existing[key] = toRecord(JSON.parse(rawValue)) as PricingModels;
  }

  const tx = db.transaction(() => {
    for (const [provider, models] of Object.entries(pricingData)) {
      insert.run(provider, JSON.stringify({ ...(existing[provider] || {}), ...models }));
    }
  });
  tx();
  backupDbFile("pre-write");
  await touchPricing();
  const updated: PricingByProvider = {};
  const allRows = db.prepare("SELECT key, value FROM key_value WHERE namespace = 'pricing'").all();
  for (const row of allRows) {
    const record = toRecord(row);
    const key = typeof record.key === "string" ? record.key : null;
    const rawValue = typeof record.value === "string" ? record.value : null;
    if (!key || rawValue === null) continue;
    updated[key] = toRecord(JSON.parse(rawValue)) as PricingModels;
  }
  return updated;
}

export async function resetPricing(provider: string, model?: string) {
  const db = getDbInstance();

  if (model) {
    const row = db
      .prepare("SELECT value FROM key_value WHERE namespace = 'pricing' AND key = ?")
      .get(provider);
    if (row) {
      const rowRecord = toRecord(row);
      const value = typeof rowRecord.value === "string" ? rowRecord.value : "{}";
      const models = toRecord(JSON.parse(value));
      delete models[model];
      if (Object.keys(models).length === 0) {
        db.prepare("DELETE FROM key_value WHERE namespace = 'pricing' AND key = ?").run(provider);
      } else {
        db.prepare("UPDATE key_value SET value = ? WHERE namespace = 'pricing' AND key = ?").run(
          JSON.stringify(models),
          provider
        );
      }
    }
  } else {
    db.prepare("DELETE FROM key_value WHERE namespace = 'pricing' AND key = ?").run(provider);
  }

  backupDbFile("pre-write");
  await touchPricing();
  const allRows = db.prepare("SELECT key, value FROM key_value WHERE namespace = 'pricing'").all();
  const result: Record<string, unknown> = {};
  for (const row of allRows) {
    const record = toRecord(row);
    const key = typeof record.key === "string" ? record.key : null;
    const rawValue = typeof record.value === "string" ? record.value : null;
    if (!key || rawValue === null) continue;
    result[key] = JSON.parse(rawValue);
  }
  return result;
}

export async function resetAllPricing() {
  const db = getDbInstance();
  db.prepare("DELETE FROM key_value WHERE namespace = 'pricing'").run();
  backupDbFile("pre-write");
  await touchPricing();
  return {};
}
