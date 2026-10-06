# Hoo's Your Rep?

Hoo's Your Rep? shows Virginia's U.S. representatives, their campaign promises and sources, recent sponsored and cosponsored legislation, and AI-generated promise analysis. County-to-district lookup data is kept in `data/ziptodist.json`; representative data is read directly from Supabase.

## Database

The app and refresh job expect the database migration in [`supabase/migrations/`](./supabase/migrations/) to have already been applied. The `public.bills` table must contain `relationship` (`sponsor` or `cosponsor`) and `introduced_date`, and the database must expose `replace_bills(p_bioguide_id text, p_relationship text, p_bills jsonb)`. The browser reads member rows with their related promises, bills, and analysis. Do not store cosponsored legislation in a separate table.

Public browser reads use the Supabase anon key and are subject to the database's grants and row-level security policies. The service-role key is used only by server-side refresh code.

Update the member roster in [`data/urls.jsonc`](./data/urls.jsonc) whenever a Virginia seat changes.

## Local development

Install the declared dependencies, then configure a local `.env.local` file with the environment variables below:

| Variable | Purpose |
| --- | --- |
| `VITE_SUPABASE_URL` | Supabase project URL used by the browser |
| `VITE_SUPABASE_ANON_KEY` | Public anon key used by the browser |
| `SUPABASE_URL` | Supabase URL used by server-side refresh code |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only Supabase service-role key |
| `CONGRESS_API_KEY` | Congress.gov API key |
| `GEMINI_API_KEY` | Gemini API key used for analysis and promise scraping |
| `BROWSERBASE_API_KEY` | Browserbase API key used for promise scraping |
| `CRON_SECRET` | Secret protecting the refresh route |
| `REFRESH_TIME_BUDGET_MS` | Total refresh time budget; default `270000`, maximum `295000` |
| `REFRESH_CONCURRENCY` | Maximum concurrent members; default `2`, maximum `4` |
| `MIN_PROMISES_TO_REPLACE` | Minimum scraped promises before replacing saved promises; default `3` |
| `REFRESH_MEMBER_TIMEOUT_MS` | Per-member scrape timeout in milliseconds; default `60000` |

Set `REFRESH_TIME_BUDGET_MS=270000` in production. The refresh worker reserves each member's timeout plus 45 seconds for Congress.gov calls and analysis before starting more work.

The `VITE_` variables are embedded in the browser bundle at build time. Set them in the environment before building, and redeploy after changing either value. Never put the service-role key or other server secrets in a `VITE_` variable or commit secret values.

Run the development server:

```sh
npm run dev
```

Run checks:

```sh
npm test
npm run lint
npm run build
```

## Refreshing member data

The protected `GET /api/refresh` route refreshes member promises, sponsored bills, cosponsored bills, and analysis. Each legislation relationship is stored through the `replace_bills` database function independently. Empty or failed fetches keep the saved list for that relationship.

The daily cron is configured in `vercel.json` and runs at **05:00 UTC**.

For Vercel deployments, set the project's **Root Directory** to `VA-Rep-Tracker`. Configure the environment variables above in Vercel; in particular, set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` for the build environment before building. `VITE_` variables are baked into the bundle at build time; redeploy after changing either value.

Run the protected local Vercel server with `vercel dev`. In another terminal, send a dry-run request for one member; it reads the existing data and calls external APIs but does not write to Supabase:

```sh
export CRON_SECRET='your-local-cron-secret'
curl --fail-with-body \
  -H "Authorization: Bearer $CRON_SECRET" \
  "http://localhost:3000/api/refresh?dryRun=1&member=W000804"
```

Omit `dryRun=1` to persist successful updates, and omit `member` to process the roster within the configured time budget.
