import assert from "node:assert/strict";
import test from "node:test";

import {
  isCurrentActiveFailure,
  resolveTopologyErrorWindowMs,
  TOPOLOGY_ERROR_WINDOW_MS,
} from "../../src/lib/usage/topologyErrorProvider.ts";

const NOW = Date.parse("2026-11-12T12:00:00.000Z");
const active = new Map([["conn-live", "openai"]]);
const providers = new Set(["openai"]);

test("the topology error window defaults to 24 hours", () => {
  assert.equal(resolveTopologyErrorWindowMs(undefined), TOPOLOGY_ERROR_WINDOW_MS);
  assert.equal(resolveTopologyErrorWindowMs(""), TOPOLOGY_ERROR_WINDOW_MS);
  assert.equal(resolveTopologyErrorWindowMs("nope"), TOPOLOGY_ERROR_WINDOW_MS);
  assert.equal(resolveTopologyErrorWindowMs("0"), TOPOLOGY_ERROR_WINDOW_MS);
  assert.equal(resolveTopologyErrorWindowMs("2"), 2 * 60 * 60 * 1000);
});

test("a recent failure on the active connection counts", () => {
  assert.equal(
    isCurrentActiveFailure({
      connectionId: "conn-live",
      provider: "openai",
      failedAtMs: NOW - 60 * 1000,
      nowMs: NOW,
      windowMs: TOPOLOGY_ERROR_WINDOW_MS,
      activeConnectionProviders: active,
      providersWithActiveConnection: providers,
    }),
    true
  );
});

test("a disabled connection, a no-auth id, and a stale failure do not count", () => {
  const base = {
    provider: "openai",
    nowMs: NOW,
    windowMs: TOPOLOGY_ERROR_WINDOW_MS,
    activeConnectionProviders: active,
    providersWithActiveConnection: providers,
  };
  assert.equal(
    isCurrentActiveFailure({
      ...base,
      connectionId: "audit-only",
      failedAtMs: NOW - 60 * 1000,
    }),
    false
  );
  assert.equal(
    isCurrentActiveFailure({
      ...base,
      provider: "uncloseai",
      connectionId: "noauth",
      failedAtMs: NOW - 60 * 1000,
    }),
    false
  );
  assert.equal(
    isCurrentActiveFailure({
      ...base,
      connectionId: "conn-live",
      failedAtMs: NOW - 25 * 60 * 60 * 1000,
    }),
    false
  );
});
