// District data hook
// Loads the requested Virginia House member and both senators in one Supabase
// query, embedding promises, legislation, and analysis so the results page can
// render from a single consistent response. Exposes loading, error, data, and
// retry states, and ignores results from requests that have since been replaced.
import { useCallback, useEffect, useState } from "react";
import { getSupabaseClient } from "../lib/supabase";

// Normalizes the one-to-one analysis relation because PostgREST can represent
// it either as a row object or as a one-element array.
function normalizeAnalysis(analysis) {
  return Array.isArray(analysis) ? analysis[0] ?? null : analysis ?? null;
}

// Fetches records for one valid Virginia House district while also returning
// Virginia's two senators. Each request embeds the related data required by
// ResultsPage, sorts nested rows for display, and converts query failures into
// a readable error state rather than returning incomplete data as success.
export function useDistrictData(district) {
  const [result, setResult] = useState({
    requestKey: null,
    data: null,
    error: null,
  });
  const [retryCount, setRetryCount] = useState(0);

  // Starts a fresh request generation so the effect re-runs even though the
  // selected district has not changed.
  const retry = useCallback(() => {
    setRetryCount((count) => count + 1);
  }, []);
  const requestKey = `${district}:${retryCount}`;

  // Requery for a new district or retry. Cleanup marks an old request stale so
  // its response cannot overwrite state for the current route.
  useEffect(() => {
    let cancelled = false;

    // Runs the nested members query, separates the House member from senators,
    // and stores either the normalized result or a user-visible error.
    async function loadDistrictData() {
      try {
        const { data: members, error: queryError } = await getSupabaseClient()
          .from("members")
          .select(`
            bioguide_id,
            name,
            party,
            chamber,
            district,
            campaign_url,
            ballotpedia_url,
            last_scraped_at,
            promises(position, topic, text, keywords, source_url, scraped_at),
            bills(congress, type, number, title, introduced_date, relationship),
            analysis(score, breakdown, analyzed_at)
          `)
          .eq("state", "VA")
          .or(
            `and(chamber.eq.house,district.eq.${district}),chamber.eq.senate`,
          )
          .order("position", {
            referencedTable: "promises",
            ascending: true,
          })
          .order("introduced_date", {
            referencedTable: "bills",
            ascending: false,
            nullsFirst: false,
          });

        if (queryError) {
          throw new Error(`Could not load district data: ${queryError.message}`);
        }

        const rows = members ?? [];
        const member = rows.find(
          (row) => row.chamber === "house" && Number(row.district) === district,
        );
        const senators = rows.filter((row) => row.chamber === "senate");

        if (!cancelled) {
          setResult({
            requestKey,
            data: member
              ? {
                  member,
                  senators,
                  promises: member.promises ?? [],
                  bills: member.bills ?? [],
                  analysis: normalizeAnalysis(member.analysis),
                }
              : {
                  member: null,
                  senators,
                  promises: [],
                  bills: [],
                  analysis: null,
                },
            error: null,
          });
        }
      } catch (loadError) {
        if (!cancelled) {
          console.error(
            "[useDistrictData] Could not load district data:",
            loadError instanceof Error ? loadError.message : loadError,
          );
          setResult({
            requestKey,
            data: null,
            error: "Could not load results. Please try again.",
          });
        }
      }
    }

    loadDistrictData();
    return () => {
      cancelled = true;
    };
  }, [district, requestKey]);

  const currentResult = result.requestKey === requestKey;
  return {
    loading: !currentResult,
    error: currentResult ? result.error : null,
    data: currentResult ? result.data : null,
    retry,
  };
}
