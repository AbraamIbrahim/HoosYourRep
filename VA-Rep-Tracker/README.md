# React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

## Refresh member data

The protected `GET /api/refresh` route refreshes member promises, sponsored bills, and analysis. Configure the following variables in the Vercel project environment:

| Variable | Purpose |
| --- | --- |
| `VITE_SUPABASE_URL` | Supabase URL used by the browser app |
| `VITE_SUPABASE_ANON_KEY` | Supabase publishable/anon key used by the browser app |
| `SUPABASE_URL` | Supabase URL used by server-side refresh code |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only Supabase service-role key |
| `CONGRESS_API_KEY` | Congress.gov API key |
| `GEMINI_API_KEY` | Gemini API key used for analysis and browser scraping |
| `BROWSERBASE_API_KEY` | Browserbase API key used for scraping |
| `CRON_SECRET` | Secret protecting `/api/refresh` |
| `REFRESH_TIME_BUDGET_MS` | Total refresh time budget; default `50000` processes about 4 members per run. Set to `240000` in production. |
| `REFRESH_CONCURRENCY` | Maximum concurrent members (default `2`, maximum `4`) |
| `MIN_PROMISES_TO_REPLACE` | Minimum scraped promises before replacing saved promises (default `3`) |
| `REFRESH_MEMBER_TIMEOUT_MS` | Per-member scrape timeout in milliseconds (default `90000`, maximum `280000`) |

Only the Supabase URL and publishable/anon key use the `VITE_` prefix. Congress.gov and Gemini keys stay server-side; browser requests go through `/api/congress` and `/api/analyze`, respectively. The analysis endpoint is public and can consume Gemini quota, so configure usage limits with your API provider and protect it with authentication or rate limiting before relying on it at scale. Never commit actual secret values. `.env.example` lists variable names without credentials.

The daily cron is configured in the project's root `vercel.json` and runs at 09:00 UTC. On Vercel Hobby, cron jobs run once per day and may be invoked at any time within the scheduled hour.

Start the local Vercel development server from the project root:

```sh
vercel dev
```

In another terminal, set the same `CRON_SECRET` value configured for the local server and run the dry-run request for one member. Dry runs make the read and external API calls, but do not write to Supabase:

```sh
export CRON_SECRET='your-local-cron-secret'
curl --fail-with-body \
  -H "Authorization: Bearer $CRON_SECRET" \
  "http://localhost:3000/api/refresh?dryRun=1&member=W000804"
```

Refresh one member and persist successful updates:

```sh
curl --fail-with-body \
  -H "Authorization: Bearer $CRON_SECRET" \
  "http://localhost:3000/api/refresh?member=W000804"
```

Refresh all members, subject to the configured time budget:

```sh
curl --fail-with-body \
  -H "Authorization: Bearer $CRON_SECRET" \
  "http://localhost:3000/api/refresh"
```

Use these SQL queries in the Supabase SQL Editor to check table row counts:

```sql
select 'members' as table_name, count(*) from public.members
union all
select 'promises', count(*) from public.promises
union all
select 'bills', count(*) from public.bills
union all
select 'analysis', count(*) from public.analysis;
```

To inspect per-member refresh outcomes:

```sql
select bioguide_id, name, last_scraped_at, last_scrape_status, last_scrape_error
from public.members
order by last_scraped_at asc nulls first;
```

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.
