// Provides county lookup and navigates to the selected district's shareable URL.
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import ziptodist from "../data/ziptodist.json";

// Displays county matches and routes an exact selection to its representative.
export default function SearchPage() {
  const [query, setQuery] = useState("");
  const navigate = useNavigate();

  const normalizedQuery = query.trim().toLowerCase();
  // Restrict county results to the state's eleven valid House districts.
  const availableDistricts = useMemo(
    () => new Set(Array.from({ length: 11 }, (_, index) => String(index + 1))),
    [],
  );
  // Resolve a case-insensitive exact county name for submission.
  const selectedCounty = useMemo(
    () =>
      Object.keys(ziptodist).find(
        (name) => name.toLowerCase() === normalizedQuery,
      ),
    [normalizedQuery],
  );

  // Build a short list of counties matching the current search text.
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

  // Use the chosen full county name as the exact-match search value.
  const handleSelect = (name) => setQuery(name);

  // Navigate only after a valid county has resolved to a Virginia district.
  const handleSubmit = () => {
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

      <section className="sp-search">
        <label htmlFor="county-input">Find out what your rep did for you!</label>
        <input
          id="county-input"
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Enter your County/City…"
        />
      </section>

      {normalizedQuery && results.length === 0 && (
        <p className="sp-no-results">No matches for "{query}"</p>
      )}

      {results.length > 0 && (
        <ul className="sp-results">
          {results.map((item, index) => (
            <li
              key={item.name}
              style={{ "--stagger": index }}
              onClick={() => handleSelect(item.name)}
            >
              <span className="sp-result-name">{item.name}</span>
              <span className="sp-result-district">District {item.district}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="sp-submit">
        <button onClick={handleSubmit} disabled={!isExactMatch}>
          View My Rep →
        </button>
      </div>
    </div>
  );
}
