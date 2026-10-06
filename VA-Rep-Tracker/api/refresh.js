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
  getMemberStartCutoffMs,
  getPositiveIntegerSetting,
  getPromiseReplacementThreshold,
  shouldReplacePromises,
} from "../lib/refreshPolicy.js";
import { scrapePromises } from "../lib/scrapePromises.js";
import { getSupabaseAdmin } from "../lib/supabaseAdmin.js";
import { withTimeout } from "../lib/withTimeout.js";

const DEFAULT_TIME_BUDGET_MS = 270_000;
const MAX_TIME_BUDGET_MS = 295_000;
const DEFAULT_MEMBER_TIMEOUT_MS = 60_000;
const MAX_MEMBER_TIMEOUT_MS = 280_000;
const MAX_REFRESH_CONCURRENCY = 4;
const MAX_MEMBER_LIMIT = 13;

// Validates the authorization header against the configured cron secret using
// a constant-time comparison after checking equal byte lengths.
function isAuthorized(authorizationHeader, cronSecret) {
  if (typeof authorizationHeader !== "string" || !cronSecret) {
    return false;
  }

  // Reject unequal lengths before timingSafeEqual, which requires equal-sized
  // buffers and would otherwise throw for malformed authorization headers.
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
    // Vercel may parse repeated query keys into arrays; use the first value
    // consistently with URLSearchParams.get below.
    return Array.isArray(requestValue) ? requestValue[0] : requestValue;
  }

  // Local invocations and test requests may provide only the raw URL.
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
  // Enough promises are safe to replace the stored set; a smaller positive
  // result is useful to report, but should not erase a fuller prior scrape.
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

  // An empty page is a valid result; transport/extraction errors are failures.
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
  // Fetch both persisted collections together so their previous versions can
  // independently survive a failed scrape or failed replacement.
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

  // The Congress-scoped filter is applied by the caller once its current
  // Congress value is known; this function preserves relationship grouping.
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
    // Dry runs return the exact proposed status without touching the members
    // table, keeping their only persistent side effect at zero.
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
      tiers: [],
      notes: [],
      errors: [],
    },
    bills: { status: "kept", count: 0 },
    cosponsoredBills: { status: "kept", count: 0 },
    analysis: { status: "skipped_no_data", score: null },
    error: null,
    failed: false,
  };
  const memberErrors = [];
  const attemptedAt = new Date().toISOString();

  let existingPromises = [];
  let existingBills = [];
  let existingCosponsoredBills = [];
  try {
    // Load current saved data before external work so each failed collection
    // can fall back to the matching saved collection.
    const existingData = await readExistingMemberData(
      context.supabase,
      member.bioguide_id,
    );
    existingPromises = existingData.promises;
    // Analysis uses current-Congress identifiers only; older rows remain in
    // storage but cannot be confused with this session's bills.
    existingBills = context.congress === null
      ? existingData.bills
      : existingData.bills.filter((bill) => bill.congress === context.congress);
    existingCosponsoredBills = context.congress === null
      ? existingData.cosponsoredBills
      : existingData.cosponsoredBills.filter(
          (bill) => bill.congress === context.congress,
        );
  } catch (error) {
    // Without the saved baseline, this member cannot safely perform selective
    // replacements, so record failure and skip its remaining external calls.
    const message = getErrorMessage(error);
    memberErrors.push(message);
    memberResult.scrape.status = "failed";
    memberResult.error = message;
    memberResult.failed = true;
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

  let scrapeResult = {
    promises: [],
    source: null,
    method: null,
    errors: [],
    notes: [],
    tiers: [],
  };
  let scrapeException = null;
  try {
    // The same configured threshold controls both multi-source scraping and
    // the later decision to replace existing promises.
    scrapeResult = await withTimeout(
      scrapePromises(member, {
        minPromises: context.promiseReplacementThreshold,
      }),
      context.memberTimeoutMs,
      `Scraping ${member.name}`,
    );
  } catch (error) {
    // A timeout does not cancel the Browserbase session; Browserbase ends it on its own session timeout.
    scrapeException = getErrorMessage(error);
    memberErrors.push(scrapeException);
  }

  const scrapedPromises = scrapeResult.promises ?? [];
  // Preserve each source's tier report in the response so dry runs explain
  // where promises were found, even when the first tier met the threshold.
  memberResult.scrape.found = scrapedPromises.length;
  memberResult.scrape.method = scrapeResult.method ?? null;
  memberResult.scrape.source = scrapeResult.source ?? null;
  memberResult.scrape.tiers = scrapeResult.tiers ?? [];
  memberResult.scrape.notes = scrapeResult.notes ?? [];
  memberResult.scrape.errors = scrapeResult.errors ?? [];

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
      // Use scraped data in the proposed analysis, but do not call the write
      // RPC; a real run follows the same data path after a successful RPC.
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
  // A scrape exception may already have been recorded above; retain one
  // canonical status error rather than duplicating it in the member summary.
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

  // Start the independent Congress.gov requests together; one endpoint's
  // failure must not prevent refreshing the other relationship.
  const billFetchResults = context.congressError
    ? [null, null]
    : await Promise.allSettled([
        getSponsoredBills(member.bioguide_id, context.congress),
        getCosponsoredBills(member.bioguide_id, context.congress),
      ]);

  async function applyBillFetchResult(fetchResult, relationship, existing) {
    const isCosponsor = relationship === "cosponsor";
    const result = isCosponsor ? memberResult.cosponsoredBills : memberResult.bills;
    if (context.congressError) {
      result.status = "kept_congress_unavailable";
      memberErrors.push(context.congressError);
      return { bills: existing, toWrite: null };
    }
    if (fetchResult.status === "rejected") {
      // Keep only this relationship's saved bills; the other list can still
      // proceed through its own fetch and replacement.
      memberErrors.push(getErrorMessage(fetchResult.reason));
      result.status = "kept_fetch_failed";
      return { bills: existing, toWrite: null };
    }

    const scrapedBills = fetchResult.value.map((bill) => ({
      ...bill,
      relationship,
    }));
    if (scrapedBills.length === 0) {
      // Empty API results are not proof that saved legislation should be
      // deleted, so retain the existing list.
      result.status = "kept_empty_response";
      return { bills: existing, toWrite: null };
    }

    if (context.dryRun) {
      // Report the proposed replacement and feed it to analysis without
      // mutating the database.
      result.status = "would_replace";
      return { bills: scrapedBills, toWrite: scrapedBills };
    }

    try {
      const { error } = await context.supabase.rpc(
        "replace_bills",
        buildReplaceBillsRpcArgs(
          member.bioguide_id,
          relationship,
          scrapedBills,
        ),
      );
      if (error) {
        throw new Error("RPC returned an error");
      }
    } catch {
      // Treat thrown requests and Supabase's returned error shape equally:
      // neither may turn a failed replacement into an empty successful list.
      const errorMessage = isCosponsor
        ? "Could not replace saved co-sponsored bills"
        : "Could not replace saved sponsored bills";
      memberErrors.push(errorMessage);
      result.status = "kept_write_failed";
      return { bills: existing, toWrite: scrapedBills };
    }
    result.status = "replaced";
    return { bills: scrapedBills, toWrite: scrapedBills };
  }

  const [sponsoredState, cosponsoredState] = await Promise.all([
    applyBillFetchResult(
      context.congressError ? null : billFetchResults[0],
      "sponsor",
      existingBills,
    ),
    applyBillFetchResult(
      context.congressError ? null : billFetchResults[1],
      "cosponsor",
      existingCosponsoredBills,
    ),
  ]);
  const billsForAnalysis = sponsoredState.bills;
  const cosponsoredBills = cosponsoredState.bills;
  const billsToWrite = sponsoredState.toWrite;
  const cosponsoredBillsToWrite = cosponsoredState.toWrite;
  memberResult.bills.count = billsForAnalysis.length;
  memberResult.cosponsoredBills.count = cosponsoredBills.length;

  let analysisToWrite = null;
  // Analysis uses the saved-or-successfully-refreshed lists, not a proposed
  // list whose database replacement failed.
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

  const failedBillStatuses = new Set([
    "kept_fetch_failed",
    "kept_write_failed",
    "kept_congress_unavailable",
  ]);
  // A member is fully failed only when scraping and both bill paths failed
  // and no analysis was saved/proposed; partial successes remain nonfatal.
  memberResult.failed =
    memberResult.scrape.status === "failed" &&
    failedBillStatuses.has(memberResult.bills.status) &&
    failedBillStatuses.has(memberResult.cosponsoredBills.status) &&
    !["saved", "would_write"].includes(memberResult.analysis.status);

  if (context.dryRun) {
    // These are intent-only values; callers can inspect them without any
    // promises, bills, analysis, or member status having been written.
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
    // Validate environment and query values before constructing a Supabase
    // client, so malformed requests fail without making database calls.
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
    if (getMemberStartCutoffMs(timeBudgetMs, memberTimeoutMs) <= 0) {
      throw new Error(
        "REFRESH_TIME_BUDGET_MS must exceed REFRESH_MEMBER_TIMEOUT_MS by more than 45000 milliseconds",
      );
    }
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
      "bioguide_id, name, party, chamber, district, issues_url, campaign_url, ballotpedia_url, last_scraped_at",
    )
    .order("last_scraped_at", { ascending: true, nullsFirst: true });
  if (memberParameter) {
    // Explicit member runs are useful for diagnosis; scheduled runs take the
    // stalest members first and use the same bounded maximum.
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
  if (congressError) {
    // Do not refresh legislation against an unknown Congress: cached bills
    // may be stale and bill identifiers could then be ambiguous.
    return response.status(500).json({
      ok: false,
      error: `Congress.gov unavailable and no cached Congress is available: ${congressError}`,
    });
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
  const memberStartCutoffMs = getMemberStartCutoffMs(
    timeBudgetMs,
    memberTimeoutMs,
  );

  // Claims and refreshes members one at a time for this worker. Stops starting
  // work when the configured reserve is reached and converts unexpected member
  // failures into explicit results while attempting to record scrape status.
  async function runMemberWorker() {
    while (nextMemberIndex < members.length) {
      const elapsedMs = Date.now() - startedAt;
      // Check immediately before claiming work so queued workers cannot begin
      // another member after the reserved completion window starts.
      if (elapsedMs > memberStartCutoffMs) {
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
        // A worker-level exception should still produce a result and best-
        // effort status write rather than hiding that member from the report.
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
            tiers: [],
            notes: [],
            errors: [],
          },
          bills: { status: "kept", count: 0 },
          cosponsoredBills: { status: "kept", count: 0 },
          analysis: { status: "failed", score: null },
          error: failureMessage,
          failed: true,
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
  // Return an HTTP failure only when every member that actually started failed;
  // partial failures and budget-skipped members remain visible in a 200 report.
  const everyProcessedMemberFailed =
    completedMemberResults.length > 0 &&
    completedMemberResults.every((memberResult) => memberResult.failed);
  const responseStatus = everyProcessedMemberFailed ? 500 : 200;
  return response.status(responseStatus).json({
    ok: responseStatus === 200 &&
      completedMemberResults.every((memberResult) => !memberResult.error),
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