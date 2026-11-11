import assert from "node:assert/strict";
import test from "node:test";
import {
  findLayeredModelPricing,
  type PricingLayerSet,
} from "../../src/lib/db/settings/pricing.ts";

const userOnCanonical = { input: 9.75, output: 78 };
const defaultOnAlias = { input: 1, output: 2 };
const userOnAlias = { input: 3, output: 4 };
const defaultOnCanonical = { input: 8, output: 9 };

function layers(partial: Partial<PricingLayerSet>): PricingLayerSet {
  return {
    user: {},
    modelsDev: {},
    litellm: {},
    defaults: {},
    ...partial,
  };
}

test("a user override on the canonical id beats a shipped row on the alias", () => {
  const pricing = layers({
    user: { codex: { "gpt-6-sol": userOnCanonical } },
    defaults: { cx: { "gpt-6-sol": defaultOnAlias, "gpt-6-sol-max": { input: 6, output: 6 } } },
  });

  assert.deepEqual(findLayeredModelPricing(pricing, "codex", "gpt-6-sol"), userOnCanonical);
  // The shipped tier must not satisfy this lookup: the caller still has to
  // try the base id on the user table.
  assert.equal(findLayeredModelPricing(pricing, "codex", "gpt-6-sol-max"), null);
  assert.equal(pricing.user.codex["gpt-6-sol"], userOnCanonical);
  assert.equal(pricing.defaults.cx["gpt-6-sol-max"].input, 6);
});

test("a user override on the alias beats a shipped row on the canonical id", () => {
  const pricing = layers({
    user: { cinf: { "gpt-5-pro": userOnAlias } },
    defaults: { cheaperinference: { "claude-opus-4.8": defaultOnCanonical } },
  });

  assert.deepEqual(findLayeredModelPricing(pricing, "cheaperinference", "gpt-5-pro"), userOnAlias);
  assert.deepEqual(
    findLayeredModelPricing(pricing, "cheaperinference", "claude-opus-4.8"),
    defaultOnCanonical
  );
  assert.equal(pricing.defaults.cheaperinference["gpt-5-pro"], undefined);
});

test("two user overrides collide on the requested key, not by alias order", () => {
  const pricing = layers({
    user: {
      codex: { "gpt-6-sol": userOnCanonical },
      cx: { "gpt-6-sol": userOnAlias },
    },
  });

  assert.deepEqual(findLayeredModelPricing(pricing, "codex", "gpt-6-sol"), userOnCanonical);
  assert.deepEqual(findLayeredModelPricing(pricing, "cx", "gpt-6-sol"), userOnAlias);
});

test("with no user row, a missing model still uses the alias or canonical catalog", () => {
  const pricing = layers({
    defaults: {
      cx: { "gpt-6-sol": defaultOnAlias },
      cheaperinference: { "claude-opus-4.8": defaultOnCanonical },
    },
  });

  assert.deepEqual(findLayeredModelPricing(pricing, "codex", "gpt-6-sol"), defaultOnAlias);
  assert.deepEqual(findLayeredModelPricing(pricing, "cinf", "claude-opus-4.8"), defaultOnCanonical);
});

test("a partial user row keeps unset fields from the same key and ignores the sibling catalog", () => {
  const pricing = layers({
    user: { codex: { "gpt-6-sol": { input: 3 } } },
    defaults: {
      codex: { "gpt-6-sol": { input: 1, output: 2 } },
      cx: { "gpt-6-sol": { input: 6, output: 6 }, "gpt-6-sol-max": { input: 12, output: 12 } },
    },
  });

  assert.deepEqual(findLayeredModelPricing(pricing, "codex", "gpt-6-sol"), {
    input: 3,
    output: 2,
  });
  assert.equal(findLayeredModelPricing(pricing, "codex", "gpt-6-sol-max"), null);
  assert.equal(pricing.user.codex["gpt-6-sol"].input, 3);
  assert.equal(pricing.defaults.cx["gpt-6-sol"].output, 6);
});

test("a model with no row on either key stays unpriced", () => {
  const pricing = layers({
    user: { cinf: { "gpt-5-pro": userOnAlias } },
    defaults: { cheaperinference: { "claude-opus-4.8": defaultOnCanonical } },
  });

  assert.equal(findLayeredModelPricing(pricing, "cheaperinference", "not-a-model"), null);
  assert.equal(findLayeredModelPricing(pricing, "missing-provider", "gpt-5-pro"), null);
});
