import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanPromises,
  getScrapeSources,
  isAllowedIssuesUrl,
  mergeDistinctPromises,
  scrapePromises,
} from "../lib/scrapePromises.js";

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

test("bounds promise text fields and keywords and removes duplicates", () => {
  const longTopic = "T".repeat(100);
  const longText = "X".repeat(450);
  const scrapedPromises = [
    {
      topic: longTopic,
      text: longText,
      keywords: [
        "K".repeat(60),
        ...Array.from({ length: 11 }, (_, index) => `Key${index + 1}`),
      ],
    },
    {
      topic: longTopic.toLowerCase(),
      text: longText.toLowerCase(),
      keywords: ["duplicate"],
    },
    { topic: "   ", text: "No topic" },
    { topic: "No text", text: "  " },
  ];

  const promises = cleanPromises(scrapedPromises, "https://example.com");

  assert.equal(promises.length, 1);
  assert.equal(promises[0].topic.length, 80);
  assert.equal(promises[0].text.length, 400);
  assert.equal(promises[0].keywords.length, 10);
  assert.equal(promises[0].keywords[0].length, 40);
});

test("accepts HTTP(S) issue pages on the campaign host and related subdomains", () => {
  assert.equal(
    isAllowedIssuesUrl(
      "https://www.example.com/issues",
      "https://example.com",
    ),
    true,
  );
  assert.equal(
    isAllowedIssuesUrl(
      "https://issues.example.com/policy",
      "https://www.example.com",
    ),
    true,
  );
  assert.equal(
    isAllowedIssuesUrl("https://example.com/issues", "https://sub.example.com"),
    true,
  );
});

test("rejects javascript and off-site issue URLs", () => {
  assert.equal(
    isAllowedIssuesUrl("javascript:alert(1)", "https://example.com"),
    false,
  );
  assert.equal(
    isAllowedIssuesUrl("https://attacker.example/issues", "https://example.com"),
    false,
  );
  assert.equal(
    isAllowedIssuesUrl("https://example.com.attacker.test/issues", "https://example.com"),
    false,
  );
});

test("orders configured scraper tiers as issues, campaign, then Ballotpedia", () => {
  assert.deepEqual(
    getScrapeSources({
      name: "Example Member",
      issues_url: "https://example.com/issues",
      campaign_url: "https://example.com",
      ballotpedia_url: "https://ballotpedia.org/Example_Member",
    }),
    [
      ["issues", "https://example.com/issues"],
      ["campaign", "https://example.com"],
      ["ballotpedia", "https://ballotpedia.org/Example_Member"],
    ],
  );
  assert.deepEqual(
    getScrapeSources({
      name: "Example Member",
      issues_url: null,
      campaign_url: "https://example.com",
      ballotpedia_url: "https://ballotpedia.org/Example_Member",
    }).map(([tier]) => tier),
    ["campaign", "ballotpedia"],
  );
});

test("merges promises case-insensitively, preserves the first source, and caps at ten", () => {
  const firstPagePromise = {
    topic: "Health",
    text: "Expand coverage",
    sourceUrl: "https://example.com/issues",
  };
  const laterDuplicate = {
    topic: "health",
    text: "EXPAND COVERAGE",
    sourceUrl: "https://example.com",
  };
  const additionalPromises = Array.from({ length: 10 }, (_, index) => ({
    topic: `Topic ${index + 1}`,
    text: `Promise ${index + 1}`,
    sourceUrl: "https://ballotpedia.org/Example",
  }));

  const merged = mergeDistinctPromises(
    [firstPagePromise],
    [laterDuplicate, ...additionalPromises],
  );

  assert.equal(merged.length, 10);
  assert.equal(merged[0].sourceUrl, "https://example.com/issues");
  assert.deepEqual(merged.slice(1).map(({ topic }) => topic), [
    "Topic 1",
    "Topic 2",
    "Topic 3",
    "Topic 4",
    "Topic 5",
    "Topic 6",
    "Topic 7",
    "Topic 8",
    "Topic 9",
  ]);
});

test("returns an empty tier report when no source URLs are configured", async () => {
  assert.deepEqual(await scrapePromises({ name: "Example Member" }), {
    promises: [],
    source: null,
    method: null,
    errors: [],
    notes: [],
    tiers: [],
  });
});

test("rejects an invalid promise threshold before attempting any sources", async () => {
  await assert.rejects(
    scrapePromises({ name: "Example Member" }, { minPromises: 0 }),
    /minPromises must be a positive integer/,
  );
});
