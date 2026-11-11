import assert from "node:assert/strict";
import test from "node:test";
import { findMergedModelPricing } from "../../src/lib/db/settings/pricing.ts";

const override = { input: 9.75, output: 78, cached: 0, reasoning: 78, cache_creation: 0 };
const builtIn = { input: 1, output: 2, cached: 0.1, reasoning: 2, cache_creation: 1 };

test("a user override stored on the alias prices usage recorded under the provider id", () => {
  const pricing = {
    cheaperinference: {
      "claude-opus-4.8": builtIn,
    },
    cinf: {
      "gpt-5-pro": override,
    },
  };

  assert.deepEqual(findMergedModelPricing(pricing, "cheaperinference", "gpt-5-pro"), override);
  assert.deepEqual(pricing.cinf["gpt-5-pro"], override);
  assert.equal(pricing.cheaperinference["gpt-5-pro"], undefined);
});

test("a built-in id row still prices when the alias table does not have that model", () => {
  const pricing = {
    cheaperinference: { "claude-opus-4.8": builtIn },
    cinf: { "gpt-5-pro": override },
  };
  assert.deepEqual(findMergedModelPricing(pricing, "cheaperinference", "claude-opus-4.8"), builtIn);
});

test("an alias override wins when the id table also has that model", () => {
  const pricing = {
    cheaperinference: { "gpt-5-pro": { input: 1, output: 2 } },
    cinf: { "gpt-5-pro": override },
  };
  assert.deepEqual(findMergedModelPricing(pricing, "cheaperinference", "gpt-5-pro"), override);
  assert.deepEqual(findMergedModelPricing(pricing, "cinf", "gpt-5-pro"), override);
});

test("a model with no row on either key stays unpriced", () => {
  const pricing = {
    cheaperinference: { "claude-opus-4.8": builtIn },
    cinf: { "gpt-5-pro": override },
  };
  assert.equal(findMergedModelPricing(pricing, "cheaperinference", "not-a-model"), null);
  assert.equal(findMergedModelPricing(pricing, "missing-provider", "gpt-5-pro"), null);
});
