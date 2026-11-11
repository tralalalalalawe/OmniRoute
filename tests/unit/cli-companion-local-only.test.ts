import assert from "node:assert/strict";
import test from "node:test";
import {
  companionStatus,
  isLocalOnlyCliStatusResponse,
} from "../../src/shared/utils/cliCompanion.ts";

const installed = {
  detection: { installed: true, runnable: true },
  config: { status: "configured" as const },
};

test("403 LOCAL_ONLY is the intentional host refusal", () => {
  const body = JSON.stringify({
    error: {
      code: "LOCAL_ONLY",
      message: "This endpoint requires localhost access",
      correlation_id: "req_test",
    },
  });
  assert.equal(isLocalOnlyCliStatusResponse(403, body), true);
});

test("other failures stay failures", () => {
  assert.equal(
    isLocalOnlyCliStatusResponse(
      403,
      JSON.stringify({ error: { code: "AUTH_002", message: "Authentication required" } })
    ),
    false
  );
  assert.equal(
    isLocalOnlyCliStatusResponse(500, JSON.stringify({ error: { code: "LOCAL_ONLY" } })),
    false
  );
  assert.equal(isLocalOnlyCliStatusResponse(403, "not json"), false);
  assert.equal(isLocalOnlyCliStatusResponse(403, JSON.stringify({ code: "LOCAL_ONLY" })), false);
  assert.equal(
    isLocalOnlyCliStatusResponse(200, JSON.stringify({ error: { code: "LOCAL_ONLY" } })),
    false
  );
});

test("local-only status is not the generic error and does not hide a real failure", () => {
  assert.deepEqual(companionStatus(undefined, false, false, true), {
    detection: "hostOnly",
    runtime: "hostOnly",
    configuration: "hostOnly",
  });
  assert.deepEqual(companionStatus(installed, false, true, true), {
    detection: "error",
    runtime: "error",
    configuration: "error",
  });
  assert.deepEqual(companionStatus(undefined, true, false, true), {
    detection: "loading",
    runtime: "loading",
    configuration: "loading",
  });
});

test("a detected missing binary stays not detected", () => {
  assert.equal(
    companionStatus(
      { detection: { installed: false, runnable: false }, config: { status: "not_installed" } },
      false,
      false,
      false
    ).detection,
    "notDetected"
  );
  assert.equal(companionStatus(installed, false, false).detection, "detected");
});
