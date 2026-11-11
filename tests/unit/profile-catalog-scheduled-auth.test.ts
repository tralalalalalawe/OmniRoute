/**
 * Scheduled provider sync authenticates to /api/providers/:id/sync-models with the
 * process-local model-sync header. Codex/Claude profile auto-sync then re-reads the
 * live catalog. That self-fetch used to forward only a cookie or Authorization bearer,
 * so a scheduler request (neither credential) received catalog_http_401 whenever the
 * catalog actually changed.
 *
 * The internal header must not become a /v1/models credential, and it must not be
 * copied onto the catalog request. A dashboard session or bearer still uses the
 * existing HTTP catalog fetch.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-profile-catalog-auth-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
const ORIGINAL_INITIAL_PASSWORD = process.env.INITIAL_PASSWORD;
const ORIGINAL_JWT_SECRET = process.env.JWT_SECRET;
const ORIGINAL_REQUIRE_API_KEY = process.env.REQUIRE_API_KEY;

process.env.DATA_DIR = TEST_DATA_DIR;
delete process.env.JWT_SECRET;

const { loadProfileCatalog } = await import("../../src/lib/cli-helper/profileCatalog.ts");
const { buildModelSyncInternalHeaders, getModelSyncInternalAuthHeaderName } =
  await import("../../src/shared/services/modelSyncScheduler.ts");
const catalog = await import("../../src/app/api/v1/models/catalog.ts");
const catalogRequest = await import("../../src/app/api/v1/models/catalogRequest.ts");
const { clientApiPolicy } = await import("../../src/server/authz/policies/clientApi.ts");
const core = await import("../../src/lib/db/core.ts");

const INTERNAL_AUTH_HEADER = getModelSyncInternalAuthHeaderName();
const BASE_URL = "http://127.0.0.1:20128";

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function schedulerRequest(extra: Record<string, string> = {}): Request {
  return new Request(`${BASE_URL}/api/providers/conn/sync-models`, {
    method: "POST",
    headers: { ...buildModelSyncInternalHeaders(), ...extra },
  });
}

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  restoreEnv("DATA_DIR", ORIGINAL_DATA_DIR);
  restoreEnv("INITIAL_PASSWORD", ORIGINAL_INITIAL_PASSWORD);
  restoreEnv("JWT_SECRET", ORIGINAL_JWT_SECRET);
  restoreEnv("REQUIRE_API_KEY", ORIGINAL_REQUIRE_API_KEY);
});

test("scheduled internal sync reads the operator catalog without a client credential", async () => {
  let fetched = false;
  let trustedLoads = 0;
  const result = await loadProfileCatalog(
    schedulerRequest(),
    async () => {
      fetched = true;
      return Response.json({ error: "unauthenticated" }, { status: 401 });
    },
    () => BASE_URL,
    async () => {
      trustedLoads += 1;
      return Response.json({ data: [{ id: "openai/gpt-test" }], models: [] });
    }
  );

  assert.equal(fetched, false);
  assert.equal(trustedLoads, 1);
  assert.deepEqual(result, {
    ok: true,
    models: [{ id: "openai/gpt-test" }],
    baseUrl: BASE_URL,
  });
});

test("a session or bearer still uses the HTTP catalog and is not upgraded to the operator read", async () => {
  const cases = [
    { cookie: "auth_token=session" },
    { authorization: "Bearer sk-interactive" },
    { cookie: "auth_token=session", authorization: "Bearer sk-interactive" },
  ];

  for (const clientAuth of cases) {
    let trustedLoads = 0;
    const result = await loadProfileCatalog(
      schedulerRequest(clientAuth),
      async (_url, init) => {
        assert.deepEqual(init?.headers, clientAuth);
        const headers = new Headers(init?.headers);
        assert.equal(headers.get(INTERNAL_AUTH_HEADER), null);
        assert.equal(init?.redirect, "error");
        return Response.json([{ id: "session-model" }]);
      },
      () => `${BASE_URL}/`,
      async () => {
        trustedLoads += 1;
        return Response.json([{ id: "operator-model" }]);
      }
    );
    assert.equal(trustedLoads, 0);
    assert.deepEqual(result, {
      ok: true,
      models: [{ id: "session-model" }],
      baseUrl: BASE_URL,
    });
  }
});

test("a forged model-sync header is not a catalog credential and is not forwarded", async () => {
  let trustedLoads = 0;
  const result = await loadProfileCatalog(
    new Request(`${BASE_URL}/api/providers/conn/sync-models`, {
      method: "POST",
      headers: { [INTERNAL_AUTH_HEADER]: "forged-token" },
    }),
    async (_url, init) => {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get(INTERNAL_AUTH_HEADER), null);
      assert.equal(headers.get("cookie"), null);
      assert.equal(headers.get("authorization"), null);
      return new Response("denied", { status: 401 });
    },
    () => BASE_URL,
    async () => {
      trustedLoads += 1;
      return Response.json([{ id: "should-not-load" }]);
    }
  );

  assert.equal(trustedLoads, 0);
  assert.deepEqual(result, { ok: false, reason: "catalog_http_401" });
});

test("the model-sync header does not authorize HTTP /v1/models", async () => {
  process.env.INITIAL_PASSWORD = "catalog-auth-required";
  process.env.REQUIRE_API_KEY = "true";
  delete process.env.JWT_SECRET;

  const headerOnly = new Request("http://203.0.113.10/v1/models", {
    headers: buildModelSyncInternalHeaders(),
  });
  const rejection = await catalogRequest.getModelCatalogAuthRejection(headerOnly, {}, {});
  assert.ok(rejection);
  assert.equal(rejection.status, 401);

  const proxy = await clientApiPolicy.evaluate({
    request: {
      method: "GET",
      headers: new Headers(buildModelSyncInternalHeaders()),
      url: "http://203.0.113.10/v1/models",
    },
    classification: {
      routeClass: "CLIENT_API",
      reason: "client_api_v1",
      normalizedPath: "/api/v1/models",
    },
    requestId: "req_profile_catalog_auth",
  });
  assert.equal(proxy.allow, false);
  if (!proxy.allow) {
    assert.equal(proxy.status, 401);
    assert.equal(proxy.code, "AUTH_002");
  }

  const warmed = await catalog.getUnifiedModelsResponse(
    new Request(`${BASE_URL}/v1/models`),
    {},
    { trustedOperatorRead: true }
  );
  assert.equal(warmed.status, 200);

  const external = await catalog.getUnifiedModelsResponse(headerOnly);
  assert.equal(external.status, 401);
  const loopback = await catalog.getUnifiedModelsResponse(
    new Request(`${BASE_URL}/v1/models`, { headers: buildModelSyncInternalHeaders() })
  );
  assert.equal(loopback.status, 401);
});

test("scheduled sync uses the in-process operator catalog when auth is required", async () => {
  process.env.INITIAL_PASSWORD = "catalog-auth-required";
  let fetched = false;
  const result = await loadProfileCatalog(
    schedulerRequest(),
    async () => {
      fetched = true;
      return new Response("denied", { status: 401 });
    },
    () => BASE_URL
  );

  assert.equal(fetched, false);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.ok(Array.isArray(result.models));
    assert.equal(result.baseUrl, BASE_URL);
  }
});

test("operator catalog read is not an HTTP route option or a forwarded secret", () => {
  const profileCatalogSrc = fs.readFileSync(
    path.join(import.meta.dirname, "../../src/lib/cli-helper/profileCatalog.ts"),
    "utf8"
  );
  const catalogSrc = fs.readFileSync(
    path.join(import.meta.dirname, "../../src/app/api/v1/models/catalog.ts"),
    "utf8"
  );
  assert.match(profileCatalogSrc, /trustedOperatorRead:\s*true/);
  assert.doesNotMatch(profileCatalogSrc, /x-model-sync-internal-auth/);
  assert.doesNotMatch(profileCatalogSrc, /buildModelSyncInternalHeaders/);
  assert.match(catalogSrc, /trustedOperatorRead/);
  assert.doesNotMatch(catalogSrc, /isModelSyncInternalRequest/);
  assert.doesNotMatch(catalogSrc, /x-model-sync-internal-auth/);

  const httpEntrypoints = [
    "../../src/app/api/v1/models/route.ts",
    "../../src/app/api/v1/route.ts",
    "../../src/app/api/v1/models/query/route.ts",
    "../../src/app/api/v1/models/health/route.ts",
    "../../src/app/api/v1/models/[...model]/route.ts",
    "../../src/app/api/models/catalog/route.ts",
    "../../src/server/authz/policies/clientApi.ts",
    "../../src/app/api/v1/models/catalogRequest.ts",
  ];
  for (const relativePath of httpEntrypoints) {
    const source = fs.readFileSync(path.join(import.meta.dirname, relativePath), "utf8");
    assert.doesNotMatch(source, /trustedOperatorRead/, relativePath);
    assert.doesNotMatch(source, /isModelSyncInternalRequest/, relativePath);
  }
});
