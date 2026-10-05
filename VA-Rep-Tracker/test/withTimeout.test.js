import assert from "node:assert/strict";
import test from "node:test";
import { withTimeout } from "../lib/withTimeout.js";

test("resolves when the operation finishes before the timeout", async () => {
  assert.equal(await withTimeout(Promise.resolve("done"), 100, "Operation"), "done");
});

test("rejects with a labeled error when the operation exceeds the timeout", async () => {
  await assert.rejects(
    withTimeout(new Promise(() => {}), 5, "Scraping Member"),
    new Error("Scraping Member timed out after 5ms"),
  );
});

test("clears its timer when the operation settles", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const clearedTimers = new Set();

  globalThis.setTimeout = (...args) => originalSetTimeout(...args);
  globalThis.clearTimeout = (timerId) => {
    clearedTimers.add(timerId);
    return originalClearTimeout(timerId);
  };

  try {
    assert.equal(await withTimeout(Promise.resolve("done"), 100, "Operation"), "done");
    assert.equal(clearedTimers.size, 1);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});
