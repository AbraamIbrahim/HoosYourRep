// Campaign promise scraper
// Extracts explicit policy commitments from a representative's issues page,
// campaign homepage, and Ballotpedia page in priority order. It tries the
// lightweight Browserbase Fetch API first, falls back to a rendered browser
// when appropriate, and merges distinct promises without losing their source
// URLs or trusting source URLs supplied by the model.
// This module stays outside `api/` so Vercel does not expose it as a route.
// Requires server-side BROWSERBASE_API_KEY and GEMINI_API_KEY environment values.

import { createBrowserbaseClient } from "./browserBaseClient.js";
import process from "node:process";
import { z } from "zod/v3";

const MODEL = "google/gemini-2.5-flash";
const MAX_PROMISES = 10;

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
export function cleanPromises(list, sourceUrl) {
  if (!Array.isArray(list)) {
    return [];
  }

  const seenPromises = new Set();
  const cleanedPromises = [];
  for (const promiseEntry of list) {
    if (
      !promiseEntry ||
      typeof promiseEntry.topic !== "string" ||
      typeof promiseEntry.text !== "string"
    ) {
      continue;
    }

    const topic = promiseEntry.topic.trim().slice(0, 80).trim();
    const text = promiseEntry.text.trim().slice(0, 400).trim();
    if (!topic || !text) {
      continue;
    }

    // unique promise fingerprint to avoid repeat adds
    const duplicateKey = `${topic.toLowerCase()}\u0000${text.toLowerCase()}`;
    if (seenPromises.has(duplicateKey)) {
      continue;
    }
    seenPromises.add(duplicateKey);

    const keywords = (Array.isArray(promiseEntry.keywords)
      ? promiseEntry.keywords
      : [])
      .filter((keyword) => typeof keyword === "string")
      .map((keyword) => keyword.trim().slice(0, 40).trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 10);

    cleanedPromises.push({
      topic,
      text,
      keywords,
      sourceUrl, // set by code, not the model, so it can't be invented
    });
    if (cleanedPromises.length === MAX_PROMISES) {
      break;
    }
  }

  return cleanedPromises;
}

// Allows only HTTP(S) issues links whose host is the campaign host or a
// dot-delimited parent/subdomain of it, treating a leading www. as equivalent.
export function isAllowedIssuesUrl(issuesUrl, campaignUrl) {
  try {
    const issues = new URL(issuesUrl);
    const campaign = new URL(campaignUrl);
    if (
      !["http:", "https:"].includes(issues.protocol) ||
      !["http:", "https:"].includes(campaign.protocol)
    ) {
      return false;
    }

    const normalizeHostname = (hostname) =>
      hostname.toLowerCase().replace(/^www\./, "");
    const issuesHostname = normalizeHostname(issues.hostname);
    const campaignHostname = normalizeHostname(campaign.hostname);
    return (
      issuesHostname === campaignHostname ||
      issuesHostname.endsWith(`.${campaignHostname}`) ||
      campaignHostname.endsWith(`.${issuesHostname}`)
    );
  } catch {
    return false;
  }
}

// Returns configured sources in precedence order so explicit policy pages
// take priority over a homepage and the broader Ballotpedia profile.
export function getScrapeSources(member) {
  return [
    ["issues", member.issues_url],
    ["campaign", member.campaign_url],
    ["ballotpedia", member.ballotpedia_url],
  ].filter(([, memberUrl]) => typeof memberUrl === "string" && memberUrl.trim());
}

// Adds unique normalized promises to an existing collection, preserving the
// first source URL for each topic/text pair and stopping at the global cap.
export function mergeDistinctPromises(existingPromises, incomingPromises) {
  const mergedPromises = [...existingPromises];
  const seenPromises = new Set(
    mergedPromises.map(
      (promise) =>
        `${promise.topic.toLowerCase()}\u0000${promise.text.toLowerCase()}`,
    ),
  );

  for (const promise of incomingPromises) {
    const key = `${promise.topic.toLowerCase()}\u0000${promise.text.toLowerCase()}`;
    if (seenPromises.has(key)) continue;
    seenPromises.add(key);
    mergedPromises.push(promise);
    if (mergedPromises.length === MAX_PROMISES) break;
  }

  return mergedPromises;
}

// Requests structured extraction from the non-rendering Fetch API, retrying a
// single rate-limit response and surfacing other HTTP or transport failures.
async function scrapeWithFetch(url, name, kind) {
  const browserbaseClient = createBrowserbaseClient(process.env.BROWSERBASE_API_KEY);
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

// Opens a rendered Stagehand browser for JavaScript-driven issues or campaign
// pages, optionally follows a validated same-site issues link, then extracts
// normalized promises. The remote session closes even when extraction fails.
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
    if (kind === "campaign" || kind === "issues") {
      try {
        const link = await stagehand.extract(
          "Find the link to the page describing this candidate's issues, priorities, or policy positions. " +
            "Leave it out if there is no such link.",
          IssuesLinkSchema
        );
        if (
          link?.issuesUrl &&
          link.issuesUrl !== url &&
          isAllowedIssuesUrl(link.issuesUrl, url)
        ) {
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
    await stagehand.close().catch(() => {});
  }
}

/**
 * Scrapes all configured sources in priority order until enough distinct
 * promises have been collected or the global cap is reached.
 *
 * Issues and campaign pages are tried with Fetch first and a rendered-browser
 * fallback when Fetch fails or finds no promises; Ballotpedia uses Fetch.
 * @param {{name:string, issues_url?:string|null, campaign_url?:string|null, ballotpedia_url?:string|null}} member
 * @param {{minPromises?:number}} options
 * @returns {Promise<{promises:Array, source:string|null, method:string|null, errors:string[], notes:string[], tiers:Array}>}
 */
export async function scrapePromises(member, { minPromises = 3 } = {}) {
  if (!Number.isInteger(minPromises) || minPromises < 1) {
    throw new Error("minPromises must be a positive integer");
  }

  const attempts = getScrapeSources(member);

  const errors = [];
  const notes = [];
  const tiers = [];
  const promises = [];
  let firstSource = null;
  let firstMethod = null;

  for (const [kind, memberUrl] of attempts) {
    const tier = { name: kind, url: memberUrl, attempts: [] };
    tiers.push(tier);

    try {
      const fetchedPromises = await scrapeWithFetch(memberUrl, member.name, kind);
      const previousCount = promises.length;
      promises.splice(
        0,
        promises.length,
        ...mergeDistinctPromises(promises, fetchedPromises),
      );
      tier.attempts.push({
        method: "fetch",
        status: fetchedPromises.length > 0 ? "found" : "empty",
        found: fetchedPromises.length,
      });
      notes.push(`${kind}/fetch: ${fetchedPromises.length} promise(s) found`);
      if (promises.length > previousCount) {
        firstSource ??= kind;
        firstMethod ??= "fetch";
      }
    } catch (error) {
      errors.push(`${kind}/fetch: ${error.message}`);
      tier.attempts.push({
        method: "fetch",
        status: "failed",
        error: error.message,
      });
      notes.push(`${kind}/fetch: failed`);
    }

    const fetchFound = tier.attempts[0].status === "found";
    if (!fetchFound && kind !== "ballotpedia") {
      try {
        const browserPromises = await scrapeWithBrowser(memberUrl, member.name, kind);
        const previousCount = promises.length;
        promises.splice(
          0,
          promises.length,
          ...mergeDistinctPromises(promises, browserPromises),
        );
        tier.attempts.push({
          method: "browser",
          status: browserPromises.length > 0 ? "found" : "empty",
          found: browserPromises.length,
        });
        notes.push(`${kind}/browser: ${browserPromises.length} promise(s) found`);
        if (promises.length > previousCount) {
          firstSource ??= kind;
          firstMethod ??= "browser";
        }
      } catch (error) {
        errors.push(`${kind}/browser: ${error.message}`);
        tier.attempts.push({
          method: "browser",
          status: "failed",
          error: error.message,
        });
        notes.push(`${kind}/browser: failed`);
      }
    }

    if (promises.length >= minPromises || promises.length >= MAX_PROMISES) break;
  }

  return { promises, source: firstSource, method: firstMethod, errors, notes, tiers };
}