# React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

## Refresh member data

The protected `GET /api/refresh` route refreshes member promises, sponsored bills, and analysis. Configure `CRON_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CONGRESS_API_KEY`, `BROWSERBASE_API_KEY`, and `GEMINI_API_KEY` in the Vercel project environment. Keep these values server-side and never add them to `src/` or commit them.

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
