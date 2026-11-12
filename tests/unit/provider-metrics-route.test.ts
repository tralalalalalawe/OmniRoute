import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-provider-metrics-route-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const providerMetricsRoute = await import("../../src/app/api/provider-metrics/route.ts");

type ProviderMetricsResponse = {
  metrics: Record<
    string,
    {
      totalRequests: number;
      totalSuccesses: number;
      successRate: number;
      lastRequestAt: string | null;
      lastErrorAt: string | null;
      lastStatus: number | null;
      lastErrorStatus: number | null;
    }
  >;
  topology: {
    providers: string[];
    lastProvider: string;
    errorProvider: string;
  };
};

function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(() => {
  resetStorage();
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

  if (ORIGINAL_DATA_DIR === undefined) {
    delete process.env.DATA_DIR;
  } else {
    process.env.DATA_DIR = ORIGINAL_DATA_DIR;
  }
});

function seedProviderConnection(provider: string) {
  const db = core.getDbInstance();
  db.prepare(
    `INSERT INTO provider_connections (id, provider, created_at, updated_at) VALUES (?, ?, ?, ?)`
  ).run(`conn-${provider}`, provider, new Date().toISOString(), new Date().toISOString());
}

test("GET /api/provider-metrics includes provider recency and error topology", async () => {
  const db = core.getDbInstance();
  const earlier = new Date(Date.now() - 3 * 60 * 1000).toISOString();
  const middle = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  const latest = new Date(Date.now() - 60 * 1000).toISOString();
  seedProviderConnection("openai");
  seedProviderConnection("anthropic");
  db.prepare(
    `INSERT INTO call_logs (id, timestamp, provider, status, duration, error_summary)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run("openai-success", earlier, "openai", 200, 120, null);
  db.prepare(
    `INSERT INTO call_logs (id, timestamp, provider, status, duration, error_summary)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run("anthropic-success", middle, "anthropic", 200, 240, null);
  db.prepare(
    `INSERT INTO call_logs (id, timestamp, provider, status, duration, error_summary)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run("openai-error", latest, "openai", 500, 80, "upstream error");

  const response = await providerMetricsRoute.GET();
  const body = (await response.json()) as ProviderMetricsResponse;

  assert.equal(response.status, 200);
  assert.equal(body.metrics.openai.totalRequests, 2);
  assert.equal(body.metrics.openai.totalSuccesses, 1);
  assert.equal(body.metrics.openai.successRate, 50);
  assert.equal(body.metrics.openai.lastRequestAt, latest);
  assert.equal(body.metrics.openai.lastErrorAt, latest);
  assert.equal(body.metrics.openai.lastStatus, 500);
  assert.equal(body.metrics.openai.lastErrorStatus, 500);
  assert.equal(body.metrics.anthropic.lastRequestAt, middle);
  assert.equal(body.metrics.anthropic.lastErrorAt, null);
  assert.deepEqual(body.topology.providers.sort(), ["anthropic", "openai"]);
  assert.equal(body.topology.lastProvider, "openai");
  assert.equal(body.topology.errorProvider, "openai");
});

test("GET /api/provider-metrics errorProvider must NOT flag a provider whose most recent request succeeded", async () => {
  // Arrange: providerA had an error long ago but recovered (last request = 200).
  //          providerB never errored.
  // Bug (pre-fix): errorProvider = "providerA" because lastErrorAt > 0.
  // Fix (post-fix): errorProvider = "" because lastStatus for providerA is 200.
  const db = core.getDbInstance();
  seedProviderConnection("providerA");
  seedProviderConnection("providerB");
  db.prepare(
    `INSERT INTO call_logs (id, timestamp, provider, status, duration, error_summary)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run("a-old-error", "2026-01-01T00:00:00.000Z", "providerA", 500, 100, "old error");
  db.prepare(
    `INSERT INTO call_logs (id, timestamp, provider, status, duration, error_summary)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run("a-recent-ok", "2026-06-01T00:00:00.000Z", "providerA", 200, 80, null);
  db.prepare(
    `INSERT INTO call_logs (id, timestamp, provider, status, duration, error_summary)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run("b-ok", "2026-05-01T00:00:00.000Z", "providerB", 200, 60, null);

  const response = await providerMetricsRoute.GET();
  const body = (await response.json()) as ProviderMetricsResponse;

  assert.equal(response.status, 200);
  // providerA's last request succeeded — must NOT appear as errorProvider
  assert.notEqual(
    body.topology.errorProvider,
    "providerA",
    "providerA recovered (lastStatus=200) and must not be marked as errorProvider"
  );
  // No provider is currently in error — errorProvider should be empty
  assert.equal(
    body.topology.errorProvider,
    "",
    "errorProvider must be empty when no provider's most recent request was a failure"
  );
});

function insertCall(
  id: string,
  provider: string,
  timestamp: string,
  status: number,
  connectionId: string | null
) {
  core
    .getDbInstance()
    .prepare(
      `INSERT INTO call_logs (id, timestamp, provider, connection_id, status, duration, error_summary)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, timestamp, provider, connectionId, status, 40, status >= 400 ? "failed" : null);
}

test("errorProvider ignores a disabled connection, a no-auth provider, and a stale failure", async () => {
  const db = core.getDbInstance();
  const recent = new Date(Date.now() - 60 * 1000).toISOString();
  const stale = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  db.prepare(
    `INSERT INTO provider_connections (id, provider, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run("audit-only", "audit-provider", 0, recent, recent);
  db.prepare(
    `INSERT INTO provider_connections (id, provider, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run("openai-live", "openai", 1, recent, recent);
  insertCall("audit-502", "audit-provider", recent, 502, "audit-only");
  insertCall("unclose-401", "uncloseai", recent, 401, "noauth");
  insertCall("cfp-503", "cloudflare-playground", recent, 503, "noauth");
  insertCall("openai-stale", "openai", stale, 500, "openai-live");

  const response = await providerMetricsRoute.GET();
  const body = (await response.json()) as ProviderMetricsResponse;

  assert.equal(response.status, 200);
  assert.equal(body.topology.errorProvider, "");
});

test("errorProvider still flags a recent failure on a connection that is active", async () => {
  const db = core.getDbInstance();
  const older = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  const recent = new Date(Date.now() - 30 * 1000).toISOString();
  db.prepare(
    `INSERT INTO provider_connections (id, provider, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run("openai-live", "openai", 1, recent, recent);
  db.prepare(
    `INSERT INTO provider_connections (id, provider, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run("anthropic-disabled", "anthropic", 0, recent, recent);
  insertCall("openai-ok", "openai", older, 200, "openai-live");
  insertCall("openai-500", "openai", recent, 500, "openai-live");
  insertCall("anthropic-502", "anthropic", recent, 502, "anthropic-disabled");

  const response = await providerMetricsRoute.GET();
  const body = (await response.json()) as ProviderMetricsResponse;

  assert.equal(body.topology.errorProvider, "openai");
});

test("errorProvider honors OMNIROUTE_TOPOLOGY_ERROR_WINDOW_HOURS", async () => {
  const previous = process.env.OMNIROUTE_TOPOLOGY_ERROR_WINDOW_HOURS;
  process.env.OMNIROUTE_TOPOLOGY_ERROR_WINDOW_HOURS = "1";
  try {
    const db = core.getDbInstance();
    const outside = new Date(Date.now() - 90 * 60 * 1000).toISOString();
    const inside = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    db.prepare(
      `INSERT INTO provider_connections (id, provider, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run("old-live", "openai", 1, inside, inside);
    db.prepare(
      `INSERT INTO provider_connections (id, provider, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run("new-live", "anthropic", 1, inside, inside);
    insertCall("openai-outside", "openai", outside, 500, "old-live");
    insertCall("anthropic-inside", "anthropic", inside, 429, "new-live");

    const response = await providerMetricsRoute.GET();
    const body = (await response.json()) as ProviderMetricsResponse;
    assert.equal(body.topology.errorProvider, "anthropic");
  } finally {
    if (previous === undefined) delete process.env.OMNIROUTE_TOPOLOGY_ERROR_WINDOW_HOURS;
    else process.env.OMNIROUTE_TOPOLOGY_ERROR_WINDOW_HOURS = previous;
  }
});

test("GET /api/provider-metrics returns sanitized 500 when metrics cannot be loaded", async () => {
  const db = core.getDbInstance();
  db.close();

  const response = await providerMetricsRoute.GET();
  const body = await response.json();

  assert.equal(response.status, 500);
  assert.equal(body.error?.message, "Failed to load provider metrics");
  assert.equal(body.error?.message.includes("at /"), false);
  assert.equal(JSON.stringify(body).includes("SqliteError"), false);
});
