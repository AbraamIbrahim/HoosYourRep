// Campaign promise scraper
// Extracts explicit policy commitments from a representative's campaign site
// and Ballotpedia page, assigning the source URL in code rather than trusting
// model output. It tries the lightweight Browserbase Fetch API first and uses a
// rendered Stagehand session for JavaScript-heavy campaign pages when needed.
// This module stays outside `api/` so Vercel does not expose it as a route.
// Requires server-side BROWSERBASE_API_KEY and GEMINI_API_KEY environment values.

import { createBrowserbaseClient } from "./browserBaseClient.js";
import process from "node:process";
import { z } from "zod/v3";

const MODEL = "google/gemini-2.5-flash";
const MAX_PROMISES = 6; // matches the 6-per-member shape in reps.json

const IssuesLinkSchema = z.object({
  issuesUrl: z
    .string()
    .url()
    .optional()
    .describe("Link to the page about the member's issues, priorities, or policy positions"),
});

const PromisesSchema = z.object({
  promises: z.array(
    z.object({
      topic: z.string().describe("Short topic label, 2-5 words, e.g. 'Veterans'"),
      text: z.string().describe("One sentence (under 40 words) summarizing the stated commitment"),
      keywords: z
        .array(z.string())
        .describe("5-10 lowercase terms useful for matching this promise to bill titles"),
    })
  ),
});

// Builds a member- and source-specific model instruction that permits only
// commitments explicitly stated on the page and caps the requested list size.
function promiseInstruction(name, kind) {
  const what =
    kind === "ballotpedia"
      ? "policy positions or campaign themes"
      : "policy commitments, promises, or priorities";
  return (
    `This page is about ${name}, a Virginia member of Congress. ` +
    `Extract up to ${MAX_PROMISES} distinct ${what} that this page explicitly states for ${name}. ` +
    `Use ONLY what the page actually says. Do not infer, guess, or add anything from outside knowledge. ` +
    `If the page states no policy commitments, return an empty list.`
  );
}


// Creates Browserbase Fetch's JSON schema for the selected member and source,
// constraining model output to a list of topic, text, and keyword fields.
function fetchSchema(name, kind) {
  const what = kind === "ballotpedia" ? "policy positions or campaign themes" : "policy commitments or priorities";
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      promises: {
        type: "array",
        description:
          `Distinct ${what} explicitly stated on the page for ${name}, a Virginia member of Congress ` +
          `(up to ${MAX_PROMISES}). Do not infer from biography or outside knowledge. Empty if none are stated.`,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            topic: { type: "string", description: "Short topic label, 2-5 words" },
            text: { type: "string", description: "One sentence (under 40 words) summarizing the stated commitment" },
            keywords: {
              type: "array",
              items: { type: "string" },
              description: "5-10 lowercase terms useful for matching to bill titles",
            },
          },
          required: ["topic", "text", "keywords"],
        },
      },
    },
    required: ["promises"],
  };
}

// Drops malformed entries, trims and normalizes their fields, enforces the
// maximum count, and attaches the trusted page URL as each promise's source.
function cleanPromises(list, sourceUrl) {
  return (list ?? [])
    .filter((promiseEntry) => promiseEntry && typeof promiseEntry.topic === "string" && typeof promiseEntry.text === "string" && promiseEntry.topic.trim() && promiseEntry.text.trim())
    .slice(0, MAX_PROMISES)
    .map((promiseEntry) => ({
      topic: promiseEntry.topic.trim(),
      text: promiseEntry.text.trim(),
      keywords: (Array.isArray(promiseEntry.keywords) ? promiseEntry.keywords : [])
        .filter((keyword) => typeof keyword === "string")
        .map((keyword) => keyword.trim().toLowerCase())
        .filter(Boolean),
      sourceUrl, // set by code, not the model, so it can't be invented
    }));
}

// Requests structured extraction from the non-rendering Fetch API, retrying a
// single rate-limit response and surfacing other HTTP or transport failures.
async function scrapeWithFetch(url, name, kind) {
  const browserbaseClient = createBrowserbaseClient(
    process.env.BROWSERBASE_API_KEY,
  );
  let browserbaseResponse;
  for (let attemptNumber = 0; attemptNumber < 2; attemptNumber += 1) {
    try {
      browserbaseResponse = await browserbaseClient.fetchAPI.create({
        url,
        format: "json",
        schema: fetchSchema(name, kind),
      });
    } catch (error) {
      const responseStatus = error.status ?? error.response?.status;
      if (responseStatus !== 429 || attemptNumber === 1) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      continue;
    }

    if (browserbaseResponse.statusCode !== 429 || attemptNumber === 1) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  if (
    !browserbaseResponse ||
    browserbaseResponse.statusCode < 200 ||
    browserbaseResponse.statusCode >= 300
  ) {
    throw new Error(
      `Browserbase fetch failed with HTTP ${browserbaseResponse?.statusCode ?? "unknown"}`,
    );
  }
  return cleanPromises(browserbaseResponse.content?.promises, url);
}

// Opens a rendered Stagehand browser for JavaScript-driven campaign pages,
// optionally follows the page's issues link, then extracts and normalizes
// promises. The remote browser session is closed even when extraction fails.
async function scrapeWithBrowser(url, name, kind) {
  const { Stagehand } = await import("@browserbasehq/stagehand");
  const stagehand = new Stagehand({
    env: "BROWSERBASE",
    model: { modelName: MODEL, apiKey: process.env.GEMINI_API_KEY },
    verbose: 0,
  });

  try {
    await stagehand.init();
    const page = stagehand.context.pages()[0];
    await page.goto(url);
    let sourceUrl = url;

    // Campaign homepages rarely list promises; hop to the issues page if there is one.
    if (kind === "campaign") {
      try {
        const link = await stagehand.extract(
          "Find the link to the page describing this candidate's issues, priorities, or policy positions. " +
            "Leave it out if there is no such link.",
          IssuesLinkSchema
        );
        if (link?.issuesUrl && link.issuesUrl !== url) {
          await page.goto(link.issuesUrl);
          sourceUrl = link.issuesUrl;
        }
      } catch {
        // No issues link or extraction failed: just extract from the page we're on
      }
    }

    const result = await stagehand.extract(promiseInstruction(name, kind), PromisesSchema);

    const promises = cleanPromises(result?.promises, sourceUrl);

    return promises;
  } finally {
    await stagehand.close();
  }
}

/**
 * Scrapes available campaign and Ballotpedia URLs in priority order.
 *
 * Each source is first tried with the lightweight fetch API; the campaign
 * source additionally gets a rendered-browser attempt if fetch finds no
 * promises. Returns the first non-empty result plus its source/method, or an
 * empty result and collected errors when every configured attempt fails.
 * @param {{name:string, campaign_url?:string|null, ballotpedia_url?:string|null}} member
 * @returns {Promise<{promises:Array, source:string|null, method:string|null, errors:string[]}>}
 */
export async function scrapePromises(member) {
  const attempts = [
    ["campaign", member.campaign_url],
    ["ballotpedia", member.ballotpedia_url],
  ].filter(([, memberUrl]) => memberUrl);

  const errors = [];
  for (const [kind, memberUrl] of attempts) {
    // 1) cheap: plain fetch
    try {
      const promises = await scrapeWithFetch(memberUrl, member.name, kind);
      if (promises.length > 0) return { promises, source: kind, method: "fetch", errors };
      errors.push(`${kind}/fetch: no promises found at ${memberUrl}`);
    } catch (error) {
      errors.push(`${kind}/fetch: ${error.message}`);
    }

    // 2) real browser, for JS-rendered sites (skip for Ballotpedia: it's server-rendered)
    if (kind === "campaign") {
      try {
        const promises = await scrapeWithBrowser(memberUrl, member.name, kind);
        if (promises.length > 0) return { promises, source: kind, method: "browser", errors };
        errors.push(`${kind}/browser: no promises found at ${memberUrl}`);
      } catch (error) {
        errors.push(`${kind}/browser: ${error.message}`);
      }
    }
  }
  return { promises: [], source: null, method: null, errors };
}