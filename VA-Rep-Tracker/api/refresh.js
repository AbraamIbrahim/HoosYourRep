// Member data refresh endpoint
// Authenticates the scheduled/manual request, selects members within configured
// time and concurrency budgets, scrapes promises, refreshes sponsored and
// cosponsored bill lists independently, and regenerates promise analysis.
// Dry-run mode reports intended writes without mutating Supabase.
import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import process from "node:process";
import { analyzePromises } from "../lib/analyzePromises.js";
import {
  buildReplaceBillsRpcArgs,
  getCosponsoredBills,
  getCurrentCongress,
  getSponsoredBills,
} from "../lib/congress.js";
import {
  getPositiveIntegerSetting,
  getPromiseReplacementThreshold,
  shouldReplacePromises,
} from "../lib/refreshPolicy.js";
import { scrapePromises } from "../lib/scrapePromises.js";
import { getSupabaseAdmin } from "../lib/supabaseAdmin.js";
import { withTimeout } from "../lib/withTimeout.js";

const DEFAULT_TIME_BUDGET_MS = 50_000;
const MAX_TIME_BUDGET_MS = 295_000;
const DEFAULT_MEMBER_TIMEOUT_MS = 90_000;
const MAX_MEMBER_TIMEOUT_MS = 280_000;
const MEMBER_START_RESERVE_MS = 15_000;
const MAX_REFRESH_CONCURRENCY = 4;
const MAX_MEMBER_LIMIT = 13;

// Validates the authorization header against the configured cron secret using
// a constant-time comparison after checking equal byte lengths.
function isAuthorized(authorizationHeader, cronSecret) {
  if (typeof authorizationHeader !== "string" || !cronSecret) {
    return false;
  }

  const receivedValue = Buffer.from(authorizationHeader);
  const expectedValue = Buffer.from(`Bearer ${cronSecret}`);
  return (
    receivedValue.length === expectedValue.length &&
    timingSafeEqual(receivedValue, expectedValue)
  );
}

// Reads a query parameter from Vercel's parsed request when available, falling
// back to parsing the request URL for local or alternate handler environments.
function getQueryParameter(request, parameterName) {
  const requestValue = request.query?.[parameterName];
  if (requestValue !== undefined) {
    return Array.isArray(requestValue) ? requestValue[0] : requestValue;
  }

  const requestUrl = new URL(request.url ?? "/", "http://localhost");
  return requestUrl.searchParams.get(parameterName);
}

// Converts unknown thrown values to a concise string and caps its length so
// individual failures cannot overwhelm logs or the response payload.
function getErrorMessage(error) {
  const message = error instanceof Error ? error.message : "Unknown error";
  return message.slice(0, 500);
}

// Classifies a scrape as successful, thin, empty, or failed. A thin/empty
// result keeps the existing promise list; operational errors are distinguished
// from a source page that simply contains no promises.
function getScrapeStatus(scrapeResult, promiseCount, replacementThreshold) {
  if (promiseCount >= replacementThreshold) {
    return {
      status: "ok",
      error: null,
    };
  }

  if (promiseCount > 0) {
    return {
      status: "thin",
      error: `scraped ${promiseCount} promises, below minimum of ${replacementThreshold}; kept existing`,
    };
  }

  const operationalErrors = (scrapeResult?.errors ?? []).filter(
    (errorMessage) => !errorMessage.includes(": no promises found at "),
  );
  if (operationalErrors.length > 0) {
    return {
      status: "failed",
      error: operationalErrors.join("; ").slice(0, 500),
    };
  }

  return {
    status: "empty",
    error: "No promises found at configured sources",
  };
}

// Converts Supabase promise rows to the application shape needed by analysis,
// retaining keywords and the source URL while normalizing absent keywords.
function mapSavedPromises(savedPromiseRows) {
  return savedPromiseRows.map((promiseRow) => ({
    topic: promiseRow.topic,
    text: promiseRow.text,
    keywords: promiseRow.keywords ?? [],
    sourceUrl: promiseRow.source_url,
  }));
}

// Converts Supabase bill columns into normalized analyzer fields, including
// introduced date and relationship so prompts can label each kind of evidence.
function mapSavedBills(savedBillRows) {
  return savedBillRows.map((billRow) => ({
    congress: billRow.congress,
    type: billRow.type,
    number: String(billRow.number),
    title: billRow.title,
    introducedDate: billRow.introduced_date,
    relationship: billRow.relationship,
  }));
}

// Reads the member's existing promises and the unified bills table, then splits
// bill rows by relationship. These saved lists are retained independently if
// the corresponding external fetch or database replacement fails.
async function readExistingMemberData(supabase, bioguideId) {
  const [promisesResult, billsResult] = await Promise.all([
    supabase
      .from("promises")
      .select("topic, text, keywords, source_url")
      .eq("bioguide_id", bioguideId)
      .order("position", { ascending: true }),
    supabase
      .from("bills")
      .select("congress, type, number, title, introduced_date, relationship")
      .eq("bioguide_id", bioguideId),
  ]);

  if (promisesResult.error || billsResult.error) {
    throw new Error("Could not load existing promises and legislation");
  }

  const savedBills = mapSavedBills(billsResult.data ?? []);
  return {
    promises: mapSavedPromises(promisesResult.data ?? []),
    bills: savedBills.filter((bill) => bill.relationship !== "cosponsor"),
    cosponsoredBills: savedBills.filter(
      (bill) => bill.relationship === "cosponsor",
    ),
  };
}

// Updates the member's last-scrape status in persistent runs and returns the
// same row in all modes so dry-run output describes the write that would occur.
async function writeScrapeStatus(
  supabase,
  member,
  scrapeStatus,
  scrapeError,
  attemptedAt,
  dryRun,
) {
  const memberStatusRow = {
    last_scraped_at: attemptedAt,
    last_scrape_status: scrapeStatus,
    last_scrape_error: scrapeError,
  };

  if (!dryRun) {
    const { error } = await supabase
      .from("members")
      .update(memberStatusRow)
      .eq("bioguide_id", member.bioguide_id);
    if (error) {
      throw new Error("Could not update member scrape status");
    }
  }

  return memberStatusRow;
}

// Refreshes all data for one member. Promise replacement follows the minimum
// count policy; sponsor and cosponsor bills are fetched, written, and counted
// separately; analysis receives whichever saved-or-new lists are available.
// Every failed list update leaves that relationship's previous records intact,
// and dry-run mode returns proposed writes without saving them.
async function refreshMember(member, context) {
  const memberStartedAt = Date.now();
  const memberResult = {
    bioguide_id: member.bioguide_id,
    name: member.name,
    scrape: {
      status: "failed",
      found: 0,
      replaced: false,
      method: null,
      source: null,
    },
    bills: { status: "kept", count: 0 },
    cosponsoredBills: { status: "kept", count: 0 },
    analysis: { status: "skipped_no_data", score: null },
    error: null,
  };
  const memberErrors = [];
  const attemptedAt = new Date().toISOString();

  let existingPromises = [];
  let existingBills = [];
  let existingCosponsoredBills = [];
  try {
    const existingData = await readExistingMemberData(
      context.supabase,
      member.bioguide_id,
    );
    existingPromises = existingData.promises;
    existingBills = existingData.bills;
    existingCosponsoredBills = existingData.cosponsoredBills;
  } catch (error) {
    const message = getErrorMessage(error);
    memberErrors.push(message);
    memberResult.scrape.status = "failed";
    memberResult.error = message;
    let memberStatusRow;
    try {
      memberStatusRow = await writeScrapeStatus(
        context.supabase,
        member,
        "failed",
        message,
        attemptedAt,
        context.dryRun,
      );
    } catch (statusError) {
      memberErrors.push(getErrorMessage(statusError));
    }
    if (context.dryRun) {
      memberResult.would_write = {
        promises: null,
        bills: null,
        cosponsoredBills: null,
        billCounts: {
          sponsored: existingBills.length,
          cosponsored: existingCosponsoredBills.length,
        },
        analysis: null,
        member: memberStatusRow ?? {
          last_scraped_at: attemptedAt,
          last_scrape_status: "failed",
          last_scrape_error: message,
        },
      };
    }
    memberResult.bills.count = existingBills.length;
    memberResult.cosponsoredBills.count = existingCosponsoredBills.length;
    memberResult.elapsedMs = Date.now() - memberStartedAt;
    console.log(
      `[refresh] ${member.bioguide_id} failed; ${memberResult.elapsedMs}ms`,
    );
    return memberResult;
  }

  let scrapeResult = { promises: [], source: null, method: null, errors: [] };
  let scrapeException = null;
  try {
    scrapeResult = await withTimeout(
      scrapePromises(member),
      context.memberTimeoutMs,
      `Scraping ${member.name}`,
    );
  } catch (error) {
    // A timeout does not cancel the Browserbase session; Browserbase ends it on its own session timeout.
    scrapeException = getErrorMessage(error);
    memberErrors.push(scrapeException);
  }

  const scrapedPromises = scrapeResult.promises ?? [];
  memberResult.scrape.found = scrapedPromises.length;
  memberResult.scrape.method = scrapeResult.method ?? null;
  memberResult.scrape.source = scrapeResult.source ?? null;

  let promiseReplacementData = existingPromises;
  let promiseWriteError = null;
  const shouldReplace =
    !scrapeException &&
    shouldReplacePromises(
      scrapedPromises.length,
      context.promiseReplacementThreshold,
    );
  if (shouldReplace) {
    if (context.dryRun) {
      promiseReplacementData = scrapedPromises;
      memberResult.scrape.replaced = true;
    } else {
      const { error } = await context.supabase.rpc("replace_promises", {
        p_bioguide_id: member.bioguide_id,
        p_promises: scrapedPromises,
      });
      if (error) {
        promiseWriteError = "Could not replace saved promises";
        memberErrors.push(promiseWriteError);
      } else {
        promiseReplacementData = scrapedPromises;
        memberResult.scrape.replaced = true;
      }
    }
  }

  const scrapeStatusResult = scrapeException
    ? { status: "failed", error: scrapeException }
    : promiseWriteError
      ? { status: "failed", error: promiseWriteError }
      : getScrapeStatus(
        scrapeResult,
        scrapedPromises.length,
        context.promiseReplacementThreshold,
      );
  if (
    scrapeStatusResult.status === "failed" &&
    !memberErrors.includes(scrapeStatusResult.error)
  ) {
    memberErrors.push(scrapeStatusResult.error);
  }
  memberResult.scrape.status = scrapeStatusResult.status;

  let memberStatusRow;
  try {
    memberStatusRow = await writeScrapeStatus(
      context.supabase,
      member,
      memberResult.scrape.status,
      scrapeStatusResult.error,
      attemptedAt,
      context.dryRun,
    );
  } catch (error) {
    memberErrors.push(getErrorMessage(error));
  }

  let billsForAnalysis = existingBills;
  let billsToWrite = null;
  if (!context.congressError) {
    try {
      const scrapedBills = (await getSponsoredBills(
        member.bioguide_id,
        context.congress,
      )).map((bill) => ({ ...bill, relationship: "sponsor" }));
      if (scrapedBills.length > 0) {
        billsToWrite = scrapedBills;
        if (context.dryRun) {
          billsForAnalysis = scrapedBills;
          memberResult.bills.status = "would_replace";
        } else {
          const { error } = await context.supabase.rpc(
            "replace_bills",
            buildReplaceBillsRpcArgs(
              member.bioguide_id,
              "sponsor",
              scrapedBills,
            ),
          );
          if (error) {
            memberErrors.push("Could not replace saved sponsored bills");
            memberResult.bills.status = "kept_write_failed";
          } else {
            billsForAnalysis = scrapedBills;
            memberResult.bills.status = "replaced";
          }
        }
      } else {
        memberResult.bills.status = "kept_empty_response";
      }
    } catch (error) {
      memberErrors.push(getErrorMessage(error));
      memberResult.bills.status = "kept_fetch_failed";
    }
  } else {
    memberErrors.push(context.congressError);
    memberResult.bills.status = "kept_congress_unavailable";
  }
  memberResult.bills.count = billsForAnalysis.length;

  let cosponsoredBills = existingCosponsoredBills;
  let cosponsoredBillsToWrite = null;
  if (!context.congressError) {
    try {
      const scrapedCosponsoredBills = (await getCosponsoredBills(
        member.bioguide_id,
        context.congress,
      )).map((bill) => ({ ...bill, relationship: "cosponsor" }));
      if (scrapedCosponsoredBills.length > 0) {
        cosponsoredBillsToWrite = scrapedCosponsoredBills;
        if (context.dryRun) {
          cosponsoredBills = scrapedCosponsoredBills;
          memberResult.cosponsoredBills.status = "would_replace";
        } else {
          const { error } = await context.supabase.rpc(
            "replace_bills",
            buildReplaceBillsRpcArgs(
              member.bioguide_id,
              "cosponsor",
              scrapedCosponsoredBills,
            ),
          );
          if (error) {
            memberErrors.push("Could not replace saved co-sponsored bills");
            memberResult.cosponsoredBills.status = "kept_write_failed";
          } else {
            cosponsoredBills = scrapedCosponsoredBills;
            memberResult.cosponsoredBills.status = "replaced";
          }
        }
      } else {
        memberResult.cosponsoredBills.status = "kept_empty_response";
      }
    } catch (error) {
      memberErrors.push(getErrorMessage(error));
      memberResult.cosponsoredBills.status = "kept_fetch_failed";
    }
  } else {
    memberResult.cosponsoredBills.status = "kept_congress_unavailable";
  }
  memberResult.cosponsoredBills.count = cosponsoredBills.length;

  let analysisToWrite = null;
  const allBillsForAnalysis = [...billsForAnalysis, ...cosponsoredBills];
  if (promiseReplacementData.length === 0 || allBillsForAnalysis.length === 0) {
    memberResult.analysis.status = "skipped_no_data";
  } else {
    try {
      analysisToWrite = await analyzePromises(
        member,
        promiseReplacementData,
        allBillsForAnalysis,
      );
      memberResult.analysis.score = analysisToWrite.score;
      if (context.dryRun) {
        memberResult.analysis.status = "would_write";
      } else {
        const { error } = await context.supabase.from("analysis").upsert({
          bioguide_id: member.bioguide_id,
          score: analysisToWrite.score,
          breakdown: analysisToWrite.breakdown,
          thinking: analysisToWrite.thinking,
          analyzed_at: new Date().toISOString(),
        });
        if (error) {
          memberErrors.push("Could not save member analysis");
          memberResult.analysis.status = "failed";
        } else {
          memberResult.analysis.status = "saved";
        }
      }
    } catch (error) {
      memberErrors.push(getErrorMessage(error));
      memberResult.analysis.status = "failed";
      memberResult.analysis.score = null;
    }
  }

  if (context.dryRun) {
    memberResult.would_write = {
      promises: shouldReplace ? scrapedPromises : null,
      bills: billsToWrite,
      cosponsoredBills: cosponsoredBillsToWrite,
      billCounts: {
        sponsored: billsForAnalysis.length,
        cosponsored: cosponsoredBills.length,
      },
      analysis: analysisToWrite,
      member: memberStatusRow ?? {
        last_scraped_at: attemptedAt,
        last_scrape_status: memberResult.scrape.status,
        last_scrape_error: scrapeStatusResult.error,
      },
    };
  }

  memberResult.error = memberErrors.length
    ? memberErrors.join("; ").slice(0, 500)
    : null;
  memberResult.elapsedMs = Date.now() - memberStartedAt;
  console.log(
    `[refresh] ${member.bioguide_id} ${memberResult.scrape.status}, ` +
      `${memberResult.scrape.found} promises, ${memberResult.bills.count} bills, ` +
      `${memberResult.cosponsoredBills.count} co-sponsored bills, ` +
      `${memberResult.analysis.status}, ${memberResult.elapsedMs}ms`,
  );
  return memberResult;
}

// Handles authorization and method checks, validates refresh settings, loads
// the target roster, determines the active Congress, and runs member workers
// within the time budget. Returns per-member outcomes, relationship-specific
// totals, and any members skipped because the budget was exhausted.
export default async function handler(request, response) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return response.status(500).json({
      ok: false,
      error: "Server configuration error",
    });
  }
  if (!isAuthorized(request.headers?.authorization, cronSecret)) {
    return response.status(401).json({ ok: false, error: "Unauthorized" });
  }
  if (request.method !== "GET" && request.method !== "POST") {
    response.setHeader("Allow", "GET, POST");
    return response.status(405).json({ ok: false, error: "Method not allowed" });
  }

  let timeBudgetMs;
  let memberTimeoutMs;
  let refreshConcurrency;
  let promiseReplacementThreshold;
  let memberLimit;
  try {
    timeBudgetMs = getPositiveIntegerSetting(
      process.env.REFRESH_TIME_BUDGET_MS,
      DEFAULT_TIME_BUDGET_MS,
      "REFRESH_TIME_BUDGET_MS",
      MAX_TIME_BUDGET_MS,
    );
    memberTimeoutMs = getPositiveIntegerSetting(
      process.env.REFRESH_MEMBER_TIMEOUT_MS,
      DEFAULT_MEMBER_TIMEOUT_MS,
      "REFRESH_MEMBER_TIMEOUT_MS",
      MAX_MEMBER_TIMEOUT_MS,
    );
    refreshConcurrency = getPositiveIntegerSetting(
      process.env.REFRESH_CONCURRENCY,
      2,
      "REFRESH_CONCURRENCY",
      MAX_REFRESH_CONCURRENCY,
    );
    promiseReplacementThreshold = getPromiseReplacementThreshold(
      process.env.MIN_PROMISES_TO_REPLACE,
    );
    const limitParameter = getQueryParameter(request, "limit");
    memberLimit =
      limitParameter === null
        ? MAX_MEMBER_LIMIT
        : getPositiveIntegerSetting(
            limitParameter,
            MAX_MEMBER_LIMIT,
            "limit",
            MAX_MEMBER_LIMIT,
          );
  } catch (error) {
    return response.status(400).json({
      ok: false,
      error: getErrorMessage(error),
    });
  }

  const memberParameter = getQueryParameter(request, "member");
  const dryRun = getQueryParameter(request, "dryRun") === "1";
  const startedAt = Date.now();

  let supabase;
  try {
    supabase = getSupabaseAdmin();
  } catch {
    return response.status(500).json({
      ok: false,
      error: "Server configuration error",
    });
  }

  let memberQuery = supabase
    .from("members")
    .select(
      "bioguide_id, name, party, chamber, district, campaign_url, ballotpedia_url, last_scraped_at",
    )
    .order("last_scraped_at", { ascending: true, nullsFirst: true });
  if (memberParameter) {
    memberQuery = memberQuery.eq("bioguide_id", memberParameter);
  }
  memberQuery = memberQuery.limit(memberLimit);

  let members = [];
  let membersError;
  try {
    const membersResult = await memberQuery;
    members = membersResult.data ?? [];
    membersError = membersResult.error;
  } catch {
    return response.status(500).json({
      ok: false,
      error: "Could not select members for refresh",
    });
  }
  if (membersError) {
    return response.status(500).json({
      ok: false,
      error: "Could not select members for refresh",
    });
  }
  if (memberParameter && members.length === 0) {
    return response.status(404).json({
      ok: false,
      error: "Member not found",
    });
  }

  let congress = null;
  let congressError = null;
  try {
    congress = await getCurrentCongress({ supabase, dryRun });
  } catch (error) {
    congressError = getErrorMessage(error);
    console.warn("[refresh] Current Congress unavailable");
  }

  const context = {
    supabase,
    dryRun,
    congress,
    congressError,
    promiseReplacementThreshold,
    memberTimeoutMs,
  };
  const memberResults = new Array(members.length);
  let nextMemberIndex = 0;

  // Claims and refreshes members one at a time for this worker. Stops starting
  // work when the configured reserve is reached and converts unexpected member
  // failures into explicit results while attempting to record scrape status.
  async function runMemberWorker() {
    while (nextMemberIndex < members.length) {
      const elapsedMs = Date.now() - startedAt;
      if (timeBudgetMs - elapsedMs < MEMBER_START_RESERVE_MS) {
        return;
      }

      const memberIndex = nextMemberIndex;
      nextMemberIndex += 1;
      try {
        memberResults[memberIndex] = await refreshMember(
          members[memberIndex],
          context,
        );
      } catch (error) {
        const member = members[memberIndex];
        const failureMessage = getErrorMessage(error);
        try {
          await writeScrapeStatus(
            context.supabase,
            member,
            "failed",
            failureMessage,
            new Date().toISOString(),
            context.dryRun,
          );
        } catch (statusError) {
          console.warn(
            `[refresh] ${member.bioguide_id} status update failed: ` +
              getErrorMessage(statusError),
          );
        }
        memberResults[memberIndex] = {
          bioguide_id: member.bioguide_id,
          name: member.name,
          scrape: {
            status: "failed",
            found: 0,
            replaced: false,
            method: null,
            source: null,
          },
          bills: { status: "kept", count: 0 },
          cosponsoredBills: { status: "kept", count: 0 },
          analysis: { status: "failed", score: null },
          error: failureMessage,
        };
        console.log(
          `[refresh] ${member.bioguide_id} failed; ` +
            `${Date.now() - startedAt}ms elapsed`,
        );
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(refreshConcurrency, members.length) },
      () => runMemberWorker(),
    ),
  );

  const skippedBudget = members.slice(nextMemberIndex).map((member) => ({
    bioguide_id: member.bioguide_id,
    name: member.name,
  }));
  const completedMemberResults = memberResults.filter(Boolean);
  return response.status(200).json({
    ok: completedMemberResults.every((memberResult) => !memberResult.error),
    dryRun,
    elapsedMs: Date.now() - startedAt,
    congress,
    billCounts: {
      sponsored: completedMemberResults.reduce(
        (total, memberResult) => total + memberResult.bills.count,
        0,
      ),
      cosponsored: completedMemberResults.reduce(
        (total, memberResult) => total + memberResult.cosponsoredBills.count,
        0,
      ),
    },
    members: completedMemberResults,
    skipped_budget: skippedBudget,
  });
}