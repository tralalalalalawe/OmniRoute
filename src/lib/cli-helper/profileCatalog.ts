import {
  fetchModelSyncInternal,
  getModelSyncInternalBaseUrl,
  isModelSyncInternalRequest,
} from "../../shared/services/modelSyncScheduler";

function forwardAuthHeaders(request: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  const cookie = request.headers.get("cookie");
  const authorization = request.headers.get("authorization");
  if (cookie) headers.cookie = cookie;
  if (authorization) headers.authorization = authorization;
  return headers;
}

function hasForwardableClientAuth(request: Request): boolean {
  return Boolean(request.headers.get("cookie") || request.headers.get("authorization"));
}

export type TrustedOperatorCatalogLoader = () => Promise<Response>;

/**
 * Operator catalog for a scheduler request that already passed
 * `isModelSyncInternalRequest`. The catalog request carries no client credential
 * and no model-sync secret. `trustedOperatorRead` is a function argument, so an
 * HTTP caller cannot present it.
 */
export async function loadTrustedOperatorCatalog(baseUrl: string): Promise<Response> {
  const { getUnifiedModelsResponse } = await import("../../app/api/v1/models/catalog");
  return getUnifiedModelsResponse(
    new Request(`${baseUrl}/v1/models`),
    {},
    {
      trustedOperatorRead: true,
    }
  );
}

export async function loadProfileCatalog(
  request: Request,
  fetchCatalog: typeof fetch = fetchModelSyncInternal,
  getBaseUrl = getModelSyncInternalBaseUrl,
  loadTrustedCatalog?: TrustedOperatorCatalogLoader
): Promise<{ ok: true; models: unknown[]; baseUrl: string } | { ok: false; reason: string }> {
  const baseUrl = getBaseUrl().replace(/\/$/, "");
  const useOperatorCatalog =
    !hasForwardableClientAuth(request) && isModelSyncInternalRequest(request);
  const res = useOperatorCatalog
    ? await (loadTrustedCatalog ?? (() => loadTrustedOperatorCatalog(baseUrl)))()
    : await fetchCatalog(`${baseUrl}/v1/models`, {
        headers: forwardAuthHeaders(request),
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });

  if (!res.ok) {
    return { ok: false, reason: `catalog_http_${res.status}` };
  }

  const body = await res.json();
  const candidateModels = Array.isArray(body) ? body : body.data || body.models || [];
  const models = Array.isArray(candidateModels) ? candidateModels : [];
  return { ok: true, models, baseUrl };
}
