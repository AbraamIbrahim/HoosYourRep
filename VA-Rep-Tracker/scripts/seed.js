// One-time (re-runnable) seed: loads Virginia members and source URLs from urls.jsonc.
// Needs in .env.local: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { readFileSync } from "node:fs";
import process from "node:process";
import { createClient } from "@supabase/supabase-js";
import { parse as parseJsonc } from "jsonc-parser";

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
for (const [environmentVariableName, environmentVariableValue] of Object.entries({
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
})) {
  if (!environmentVariableValue) {
    console.error(`Missing env var: ${environmentVariableName}`);
    process.exit(1);
  }
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const urlsFile = readFileSync(
  new URL("../data/urls.jsonc", import.meta.url),
  "utf8",
);
const memberEntries = parseJsonc(urlsFile);

if (
  !memberEntries ||
  typeof memberEntries !== "object" ||
  Array.isArray(memberEntries)
) {
  console.error("Invalid member roster in data/urls.jsonc");
  process.exit(1);
}

const cleanUrl = (urlValue) =>
  (typeof urlValue === "string" && urlValue.trim()) || null;

const memberRows = Object.entries(memberEntries).map(
  ([bioguideId, memberEntry]) => ({
    bioguide_id: bioguideId,
    name: memberEntry.name,
    party: memberEntry.party,
    chamber: memberEntry.chamber,
    district: memberEntry.district,
    state: "VA",
    issues_url: cleanUrl(memberEntry.issues),
    campaign_url: cleanUrl(memberEntry.campaign),
    ballotpedia_url: cleanUrl(memberEntry.ballotpedia),
  }),
);

const { error } = await supabase.from("members").upsert(memberRows);
if (error) {
  console.error("FAILED: upsert Virginia members", error.message);
  process.exit(1);
}

console.log(`Upserted ${memberRows.length} Virginia members`);
console.log("Done.");
