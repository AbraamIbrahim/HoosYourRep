import assert from "node:assert/strict";
import test from "node:test";
import { cleanPromises } from "../lib/scrapePromises.js";

test("normalizes and keeps up to ten valid promises", () => {
  const scrapedPromises = Array.from({ length: 12 }, (_, index) => ({
    topic: ` Topic ${index + 1} `,
    text: ` Commitment ${index + 1}. `,
    keywords: [` KEYWORD-${index + 1} `],
  }));

  const promises = cleanPromises(scrapedPromises, "https://example.com/issues");

  assert.equal(promises.length, 10);
  assert.deepEqual(promises[0], {
    topic: "Topic 1",
    text: "Commitment 1.",
    keywords: ["keyword-1"],
    sourceUrl: "https://example.com/issues",
  });
  assert.equal(promises[9].topic, "Topic 10");
});

test("ignores malformed promises before applying the ten-promise cap", () => {
  const scrapedPromises = [
    { topic: "", text: "Missing topic" },
    { topic: "Missing text" },
    ...Array.from({ length: 10 }, (_, index) => ({
      topic: `Topic ${index + 1}`,
      text: `Commitment ${index + 1}`,
      keywords: [],
    })),
  ];

  const promises = cleanPromises(scrapedPromises, "https://example.com");

  assert.equal(promises.length, 10);
  assert.equal(promises[0].topic, "Topic 1");
  assert.equal(promises.at(-1).topic, "Topic 10");
});
