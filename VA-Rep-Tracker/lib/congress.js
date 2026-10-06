// Congress.gov integration
// Fetches the current Congress and members' sponsored/cosponsored legislation,
// normalizes inconsistent API fields, prioritizes current and recently
// introduced bills, and builds payloads for the relationship-aware database RPC.
import axios from "axios";
import process from "node:process";

const CONGRESS_API_BASE_URL = "https://api.congress.gov/v3";
// Cache the active Congress number for one day to avoid an API call on every
// refresh while still allowing the value to roll forward promptly.
const CURRENT_CONGRESS_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CONGRESS_API_TIMEOUT_MS = 10_000;

// Extracts a positive integer from either Congress.gov's numeric `number`
// property or a display name such as "119th Congress"; returns null if neither
// representation can be interpreted.
function parseCongressNumber(congressRecord) {
  if (Number.isInteger(congressRecord?.number) && congressRecord.number > 0) {
    return congressRecord.number;
  }

  const congressName =
    typeof congressRecord?.name === "string" ? congressRecord.name : "";
  const congressNameMatch = congressName.match(/^(\d+)(?:st|nd|rd|th) Congress$/i);
  return congressNameMatch ? Number(congressNameMatch[1]) : null;
}

// Reads the cache formats historically stored in `meta.value` and returns a
// usable positive integer, or null when the stored value is absent or invalid.
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

// Normalizes the current-Congress response to an array whether the API returned
// the records directly or nested them under its `congresses` property.
function getCongressRecords(responseData) {
  if (Array.isArray(responseData)) {
    return responseData;
  }
  if (Array.isArray(responseData?.congresses)) {
    return responseData.congresses;
  }
  return [];
}

// Normalizes member-legislation responses to a record array, accepting direct
// arrays and the endpoint-specific collection property used by Congress.gov.
function getMemberLegislationRecords(responseData, collectionName) {
  if (Array.isArray(responseData)) {
    return responseData;
  }
  if (Array.isArray(responseData?.[collectionName])) {
    return responseData[collectionName];
  }
  return [];
}

// Requests Congress.gov's current-Congress endpoint and parses its response.
// Missing credentials, failed requests, and responses without a valid Congress
// number are reported explicitly to the caller.
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

// Uses a recent Supabase cache entry when available; otherwise fetches the
// current number from Congress.gov and refreshes the cache unless this is a
// dry run. If the API fails, a previously cached number remains a fallback.
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

// Converts an API date string to milliseconds for newest-first ordering.
// Invalid or missing dates return null so the caller can place those bills last.
function getIntroducedDateTimestamp(introducedDate) {
  if (typeof introducedDate !== "string") {
    return null;
  }

  const timestamp = Date.parse(introducedDate);
  return Number.isFinite(timestamp) ? timestamp : null;
}

// Removes records missing required identifiers or titles, keeps only the
// requested Congress to avoid ambiguous bill identifiers, sorts dated bills
// newest first (undated records last), and applies the relationship cap.
export function normalizeBillRecords(
  responseData,
  collectionName,
  currentCongress,
  limit = 10,
) {
  const billRecords = getMemberLegislationRecords(responseData, collectionName)
    .flatMap((billRecord) => {
      const title = billRecord?.title ?? billRecord?.latestTitle;
      if (
        !billRecord ||
        !Number.isInteger(Number(billRecord.congress)) ||
        Number(billRecord.congress) !== currentCongress ||
        billRecord.type == null ||
        !String(billRecord.type).trim() ||
        billRecord.number == null ||
        !String(billRecord.number).trim() ||
        typeof title !== "string" ||
        !title.trim()
      ) {
        return [];
      }

      return [{
        congress: Number(billRecord.congress),
        type: String(billRecord.type),
        number: String(billRecord.number),
        title: title.trim(),
        introducedDate:
          typeof billRecord.introducedDate === "string"
            ? billRecord.introducedDate
            : null,
      }];
    });

  return billRecords
    .sort((firstBill, secondBill) => {
      const firstTimestamp = getIntroducedDateTimestamp(
        firstBill.introducedDate,
      );
      const secondTimestamp = getIntroducedDateTimestamp(
        secondBill.introducedDate,
      );
      if (firstTimestamp === null) return secondTimestamp === null ? 0 : 1;
      if (secondTimestamp === null) return -1;
      return secondTimestamp - firstTimestamp;
    })
    .slice(0, limit);
}

// Calls the member endpoint for the requested relationship with a bounded
// response size, then normalizes and caps its records. API failures are
// converted to concise relationship-specific errors for the refresh report.
async function getMemberBills(bioguideId, currentCongress, sponsorship, limit) {
  const congressApiKey = process.env.CONGRESS_API_KEY;
  if (!congressApiKey) {
    throw new Error("Congress.gov API key is not configured");
  }

  const collectionName = `${sponsorship}Legislation`;
  const endpoint =
    `${CONGRESS_API_BASE_URL}/member/${encodeURIComponent(bioguideId)}/` +
    `${sponsorship}-legislation`;
  const allRecords = [];

  for (let page = 0; page < 5; page += 1) {
    let response;
    try {
      response = await axios.get(endpoint, {
        params: {
          api_key: congressApiKey,
          format: "json",
          limit: 50,
          offset: page * 50,
        },
        timeout: CONGRESS_API_TIMEOUT_MS,
      });
    } catch (error) {
      const responseStatus = error.response?.status;
      throw new Error(
        responseStatus
          ? `Congress.gov ${sponsorship} legislation request failed (HTTP ${responseStatus})`
          : `Congress.gov ${sponsorship} legislation request failed`,
      );
    }

    const pageRecords = getMemberLegislationRecords(
      response.data,
      collectionName,
    );
    allRecords.push(...pageRecords);
    if (pageRecords.length < 50) {
      break;
    }
  }

  return normalizeBillRecords(
    { [collectionName]: allRecords },
    collectionName,
    currentCongress,
    limit,
  );
}

// Loads up to ten recent sponsored bills for a bioguide ID, preserving each
// bill's introduction date for database storage and display ordering.
export async function getSponsoredBills(bioguideId, currentCongress) {
  return getMemberBills(bioguideId, currentCongress, "sponsored", 10);
}

// Loads up to twenty recent cosponsored bills for a bioguide ID, using the
// same pagination and introduced-date ordering as sponsorship.
export async function getCosponsoredBills(bioguideId, currentCongress) {
  return getMemberBills(bioguideId, currentCongress, "cosponsored", 20);
}

// Converts normalized bill objects into the JSON record fields accepted by
// replace_bills, mapping the JavaScript introducedDate property to
// introduced_date and explicitly preserving missing dates as null.
export function toBillRpcPayload(bills) {
  return bills.map((bill) => ({
    congress: bill.congress,
    type: bill.type,
    number: bill.number,
    title: bill.title,
    introduced_date: bill.introducedDate ?? null,
  }));
}

// Assembles the named RPC parameters for one member and one relationship so
// sponsor and cosponsor refreshes can replace their lists independently.
export function buildReplaceBillsRpcArgs(bioguideId, relationship, bills) {
  return {
    p_bioguide_id: bioguideId,
    p_relationship: relationship,
    p_bills: toBillRpcPayload(bills),
  };
}
