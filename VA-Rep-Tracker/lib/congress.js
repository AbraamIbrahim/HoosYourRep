import axios from "axios";
import process from "node:process";

const CONGRESS_API_BASE_URL = "https://api.congress.gov/v3";
// convert 24 hours to MS before needed to update current congress sesison number
const CURRENT_CONGRESS_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CONGRESS_API_TIMEOUT_MS = 10_000;

function parseCongressNumber(congressRecord) {
  if (Number.isInteger(congressRecord?.number) && congressRecord.number > 0) {
    return congressRecord.number;
  }

  const congressName =
    typeof congressRecord?.name === "string" ? congressRecord.name : "";
  const congressNameMatch = congressName.match(/^(\d+)(?:st|nd|rd|th) Congress$/i);
  return congressNameMatch ? Number(congressNameMatch[1]) : null;
}

function getCachedCongressNumber(metaValue) {
  const valueCandidate =
    typeof metaValue === "number" || typeof metaValue === "string"
      ? metaValue
      : metaValue?.congress ?? metaValue?.number;
  const congressNumber = Number(valueCandidate);
  return Number.isInteger(congressNumber) && congressNumber > 0
    ? congressNumber
    : null;
}

function getCongressRecords(responseData) {
  if (Array.isArray(responseData)) {
    return responseData;
  }
  if (Array.isArray(responseData?.congresses)) {
    return responseData.congresses;
  }
  return [];
}

function getSponsoredLegislationRecords(responseData) {
  if (Array.isArray(responseData)) {
    return responseData;
  }
  if (Array.isArray(responseData?.sponsoredLegislation)) {
    return responseData.sponsoredLegislation;
  }
  return [];
}

async function fetchCurrentCongressFromApi() {
  const congressApiKey = process.env.CONGRESS_API_KEY;
  if (!congressApiKey) {
    throw new Error("Congress.gov API key is not configured");
  }

  try {
    const response = await axios.get(`${CONGRESS_API_BASE_URL}/congress/current`, {
      params: { api_key: congressApiKey, format: "json" },
      timeout: CONGRESS_API_TIMEOUT_MS,
    });
    const congressRecords = getCongressRecords(response.data);
    const currentCongressNumber = congressRecords
      .map(parseCongressNumber)
      .find((congressNumber) => congressNumber !== null);

    if (!currentCongressNumber) {
      throw new Error("Congress.gov returned no current Congress number");
    }
    return currentCongressNumber;
  } catch (error) {
    if (error.message === "Congress.gov returned no current Congress number") {
      throw error;
    }
    const responseStatus = error.response?.status;
    throw new Error(
      responseStatus
        ? `Congress.gov current Congress request failed (HTTP ${responseStatus})`
        : "Congress.gov current Congress request failed",
    );
  }
}

export async function getCurrentCongress({ supabase, dryRun = false }) {
  let cachedCongressNumber = null;
  let cachedAtMs = null;

  try {
    const { data: metaRow, error: metaError } = await supabase
      .from("meta")
      .select("value, updated_at")
      .eq("key", "current_congress")
      .maybeSingle();
    if (!metaError && metaRow) {
      cachedCongressNumber = getCachedCongressNumber(metaRow.value);
      const parsedUpdatedAt = Date.parse(metaRow.updated_at);
      cachedAtMs = Number.isFinite(parsedUpdatedAt) ? parsedUpdatedAt : null;
    }
  } catch {
    // Congress.gov can still supply a value if the cache lookup fails.
  }

  const nowMs = Date.now();
  const cacheIsFresh =
    cachedCongressNumber !== null &&
    cachedAtMs !== null &&
    nowMs >= cachedAtMs &&
    nowMs - cachedAtMs < CURRENT_CONGRESS_CACHE_MAX_AGE_MS;
  if (cacheIsFresh) {
    return cachedCongressNumber;
  }

  try {
    const currentCongressNumber = await fetchCurrentCongressFromApi();
    if (!dryRun) {
      const { error: cacheWriteError } = await supabase.from("meta").upsert({
        key: "current_congress",
        value: { congress: currentCongressNumber },
        updated_at: new Date().toISOString(),
      });
      if (cacheWriteError) {
        console.warn("Could not refresh current Congress cache");
      }
    }
    return currentCongressNumber;
  } catch (error) {
    if (cachedCongressNumber !== null) {
      console.warn("Congress.gov unavailable; using cached current Congress");
      return cachedCongressNumber;
    }
    throw new Error(
      `Unable to determine current Congress: ${error.message}`,
    );
  }
}

export async function getSponsoredBills(bioguideId, currentCongress) {
  const congressApiKey = process.env.CONGRESS_API_KEY;
  if (!congressApiKey) {
    throw new Error("Congress.gov API key is not configured");
  }

  let response;
  try {
    response = await axios.get(
      `${CONGRESS_API_BASE_URL}/member/${encodeURIComponent(bioguideId)}/sponsored-legislation`,
      {
        params: { api_key: congressApiKey, format: "json", limit: 50 },
        timeout: CONGRESS_API_TIMEOUT_MS,
      },
    );
  } catch (error) {
    const responseStatus = error.response?.status;
    throw new Error(
      responseStatus
        ? `Congress.gov sponsored legislation request failed (HTTP ${responseStatus})`
        : "Congress.gov sponsored legislation request failed",
    );
  }

  const billRecords = getSponsoredLegislationRecords(response.data)
    .filter(
      (billRecord) =>
        billRecord &&
        Number.isInteger(Number(billRecord.congress)) &&
        billRecord.type != null &&
        billRecord.number != null &&
        typeof billRecord.title === "string" &&
        billRecord.title.trim(),
    )
    .map((billRecord) => ({
      congress: Number(billRecord.congress),
      type: String(billRecord.type),
      number: String(billRecord.number),
      title: billRecord.title.trim(),
    }));

  return billRecords
    .sort(
      (firstBill, secondBill) =>
        Number(secondBill.congress === currentCongress) -
        Number(firstBill.congress === currentCongress),
    )
    .slice(0, 10);
}
