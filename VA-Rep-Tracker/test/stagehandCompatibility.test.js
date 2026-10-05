import assert from "node:assert/strict";
import test from "node:test";
import { Stagehand } from "@browserbasehq/stagehand";
import { scrapePromises } from "../lib/scrapePromises.js";

test("the scraper's Stagehand v3 API can be constructed offline", () => {
  assert.equal(typeof scrapePromises, "function");

  const stagehand = new Stagehand({
    env: "BROWSERBASE",
    model: { modelName: "google/gemini-2.5-flash", apiKey: "x" },
    verbose: 0,
  });

  assert.equal(typeof stagehand.init, "function");
});
