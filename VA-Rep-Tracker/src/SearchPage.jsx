// County search page
// Lets visitors find their Virginia House district by county or city, then
// opens a URL that preserves both the district number and selected county.
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import ziptodist from "../data/ziptodist.json";

// Renders the search input, filtered county matches, and district navigation.
// District availability is constrained to Virginia's current 1–11 range; the
// selected county is passed as a query parameter so a refreshed link retains it.
export default function SearchPage() {
  const [query, setQuery] = useState("");
  const navigate = useNavigate();

  const normalizedQuery = query.trim().toLowerCase();
  // Build the valid district set once; it filters archive lookup data without
  // needing to load a representative list just to enable county search.
  const availableDistricts = useMemo(
    () => new Set(Array.from({ length: 11 }, (_, index) => String(index + 1))),
    [],
  );
  // Resolve a case-insensitive exact county/city match separately from the
  // partial matches shown in the suggestion list.
  const selectedCounty = useMemo(
    () =>
      Object.keys(ziptodist).find(
        (name) => name.toLowerCase() === normalizedQuery,
      ),
    [normalizedQuery],
  );

  // Filter the static county-to-district map by the normalized text and valid
  // district range, then cap suggestions to keep the list manageable.
  const results = useMemo(() => {
    if (!normalizedQuery) return [];
    return Object.keys(ziptodist)
      .filter(
        (name) =>
          name.toLowerCase().includes(normalizedQuery) &&
          availableDistricts.has(String(ziptodist[name])),
      )
      .slice(0, 30)
      .map((name) => ({ name, district: ziptodist[name] }));
  }, [availableDistricts, normalizedQuery]);

  const isExactMatch =
    selectedCounty !== undefined &&
    availableDistricts.has(String(ziptodist[selectedCounty]));

  // Replace a partial query with the full suggested county/city name so it
  // becomes eligible for the exact-match submit action.
  const handleSelect = (name) => setQuery(name);

  // Navigate only when the current text exactly identifies a known county/city;
  // encode the county so spaces and punctuation survive in the shareable URL.
  const handleSubmit = (event) => {
    event.preventDefault();
    if (!isExactMatch || !selectedCounty) return;
    const district = ziptodist[selectedCounty];
    navigate(
      `/rep/${district}?county=${encodeURIComponent(selectedCounty)}`,
    );
  };

  return (
    <div className="search-page">
      <img
        className="sp-logo"
        src="/hoos-logo/hoos.png"
        alt="Hoo's Your Rep?"
      />

      <form className="sp-search" onSubmit={handleSubmit}>
        <label htmlFor="county-input">Find out what your rep did for you!</label>
        <input
          id="county-input"
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Enter your County/City…"
        />

        {normalizedQuery && results.length === 0 && (
          <p className="sp-no-results">No matches for "{query}"</p>
        )}

        {results.length > 0 && (
          <ul className="sp-results">
            {results.map((item, index) => (
              <li key={item.name} style={{ "--stagger": index }}>
                <button
                  className="sp-result-option"
                  type="button"
                  onClick={() => handleSelect(item.name)}
                >
                  <span className="sp-result-name">{item.name}</span>
                  <span className="sp-result-district">
                    District {item.district}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="sp-submit">
          <button type="submit" disabled={!isExactMatch}>
          View My Rep →
          </button>
        </div>
      </form>
    </div>
  );
}
