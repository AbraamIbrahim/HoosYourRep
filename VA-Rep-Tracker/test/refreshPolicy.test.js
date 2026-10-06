import assert from "node:assert/strict";
import test from "node:test";
import {
  getMemberStartCutoffMs,
  shouldReplacePromises,
} from "../lib/refreshPolicy.js";

test("keeps existing promises when a scrape returns two promises", () => {
  assert.equal(shouldReplacePromises(2), false);
});

test("replaces existing promises when a scrape returns three promises", () => {
  assert.equal(shouldReplacePromises(3), true);
});

test("computes the member start cutoff after reserving scrape and follow-up time", () => {
  assert.equal(getMemberStartCutoffMs(270_000, 60_000), 165_000);
  assert.equal(getMemberStartCutoffMs(120_000, 90_000), -15_000);
});
