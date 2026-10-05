// Test the scraper on a few members. Prints results; writes NOTHING to Supabase.
//
// From VA-Rep-Tracker/:
//   node --env-file=.env.local scripts/testScrape.js                 (first 3 members with URLs)
//   node --env-file=.env.local scripts/testScrape.js W000804 S000185 (specific bioguide IDs)

import { createClient } from "@supabase/supabase-js";
import { scrapePromises } from "../lib/scrapePromises.js";

const required = [
  "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY",
  "BROWSERBASE_API_KEY", "GEMINI_API_KEY", // project ID is optional: inferred from the API key
];
for (const environmentVariableName of required) {
  if (!process.env[environmentVariableName]) {
    console.error(`Missing env var: ${environmentVariableName}`);
    process.exit(1);
  }
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const ids = process.argv.slice(2);
let query = supabase
  .from("members")
  .select("bioguide_id, name, campaign_url, ballotpedia_url")
  .or("campaign_url.not.is.null,ballotpedia_url.not.is.null");
if (ids.length) query = query.in("bioguide_id", ids);
else query = query.limit(3);

const { data: members, error } = await query;
if (error) { console.error(error.message); process.exit(1); }
if (!members.length) {
  console.error("No members with URLs found. Add URLs to data/campaignUrls.jsonc and re-run seed.js.");
  process.exit(1);
}

for (const member of members) {
  console.log(`\n=== ${member.name} (${member.bioguide_id}) ===`);
  const t0 = Date.now();
  const { promises, source, method, errors } = await scrapePromises(member);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`source: ${source ?? "NONE"} via ${method ?? "-"} | ${promises.length} promises | ${secs}s`);
  if (errors.length) console.log("notes:", errors);
  console.log(JSON.stringify(promises, null, 2));
}