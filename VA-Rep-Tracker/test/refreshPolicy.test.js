import assert from "node:assert/strict";
import test from "node:test";
import { shouldReplacePromises } from "../lib/refreshPolicy.js";

test("keeps existing promises when a scrape returns two promises", () => {
  assert.equal(shouldReplacePromises(2), false);
});

test("replaces existing promises when a scrape returns three promises", () => {
  assert.equal(shouldReplacePromises(3), true);
});
