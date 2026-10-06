// District results page
// Presents a Virginia House member's profile, promises, sponsored and
// cosponsored bills, analysis, and the state's senators. It connects analysis
// to current promise positions, draws links only to visible bills, and treats
// legacy analysis without a valid promise position as unavailable.
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useDistrictData } from "./hooks/useDistrictData";

const PROMISE_COLORS = [
  "#e74c3c",
  "#3498db",
  "#2ecc71",
  "#f39c12",
  "#9b59b6",
  "#1abc9c",
  "#e67e22",
  "#34495e",
  "#e91e63",
  "#00bcd4",
];

// Returns the canonical Congress bill key used by analysis and saved bill rows,
// so identifiers compare consistently regardless of the API's type casing.
function getBillIdentifier(bill) {
  return `${String(bill.type).toUpperCase()} ${bill.number}`;
}

// Accepts only absolute HTTP or HTTPS URLs before they are used in an anchor;
// malformed values and other schemes are omitted from the rendered page.
function getSafeHttpUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

// Formats a database timestamp using the visitor's locale, returning null for
// missing or invalid values so the UI can omit a misleading date.
function formatDate(value) {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? null
    : date.toLocaleDateString(undefined, {
        year: "numeric",
        month: "long",
        day: "numeric",
      });
}

// Creates a new-tab source link after validating its scheme. Returns no link
// when the database does not contain a usable source URL.
function SourceLink({ url, children }) {
  const safeUrl = getSafeHttpUrl(url);
  if (!safeUrl) return null;

  return (
    <a className="source-link" href={safeUrl} target="_blank" rel="noreferrer">
      {children} ↗
    </a>
  );
}

// Renders one bill card with its sponsor/cosponsor label, related-promise
// badges, and an expandable full title. Keyboard activation mirrors clicking.
function BillCard({
  bill,
  indices,
  expanded,
  highlighted = false,
  onToggle,
  title,
}) {
  return (
    <div
      className={`graph-bill-card${expanded ? " expanded" : ""}${highlighted ? " is-hover-match" : ""}`}
      onClick={onToggle}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onToggle();
        }
      }}
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
    >
      <div className="bill-badges">
        {indices.length > 0
          ? indices.map((index) => (
              <span
                key={index}
                className="promise-badge"
                style={{
                  background: PROMISE_COLORS[index % PROMISE_COLORS.length],
                }}
                title={title(index)}
              >
                {index + 1}
              </span>
            ))
          : (
            <span
              className="promise-badge no-match"
              title="No matching promise"
            >
              -
            </span>
          )}
      </div>
      <div className="bill-info">
        <div className="bill-info-header">
          <span className="bill-tag">{getBillIdentifier(bill)}</span>
          <span className={`relationship-tag relationship-tag--${bill.relationship}`}>
            {bill.relationship === "cosponsor" ? "Cosponsored" : "Sponsored"}
          </span>
          <span className="bill-expand-caret">{expanded ? "▲" : "▼"}</span>
        </div>
        <span className="bill-title bill-title--truncated">{bill.title}</span>
        {expanded && <div className="bill-title-dropdown">{bill.title}</div>}
      </div>
    </div>
  );
}

// Displays a senator as a compact statewide card, using a placeholder portrait
// and linking to the campaign website when one has been saved.
function SenatorCard({ senator }) {
  return (
    <article className="senator-card">
      <img
        src="/rep-portraits/placeholder.svg"
        alt=""
        className="senator-portrait"
      />
      <div>
        <p className="rep-kicker">U.S. Senator</p>
        <h3>{senator.name}</h3>
        <p>{senator.party}</p>
        <SourceLink url={senator.campaign_url}>Campaign website</SourceLink>
      </div>
    </article>
  );
}

// Coordinates the district query, client-side relationship filtering, and
// results UI. It handles loading, errors, and missing members before rendering
// profile data, optional senators, sourced promises, bill matches, and analysis.
export default function ResultsPage({ district }) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const county = searchParams.get("county");
  const { loading, error, data, retry } = useDistrictData(district);
  const [showCosponsored, setShowCosponsored] = useState(false);
  const [expandedBills, setExpandedBills] = useState(new Set());
  const [hoveredPromiseIndex, setHoveredPromiseIndex] = useState(null);
  const [arrowData, setArrowData] = useState({ lines: [], width: 0, height: 0 });
  const containerRef = useRef(null);
  const promiseRefs = useRef([]);
  const billRefs = useRef([]);

  const member = data?.member;
  const promises = useMemo(() => data?.promises ?? [], [data?.promises]);
  const bills = useMemo(() => data?.bills ?? [], [data?.bills]);
  const senators = useMemo(() => data?.senators ?? [], [data?.senators]);
  const analysis = data?.analysis;
  // Keep only analysis entries that point to a promise in the current result.
  // Older rows lacking promisePosition cannot be reliably attached, so they are
  // excluded from the score breakdown and promise-to-bill connections.
  const breakdown = useMemo(() => {
    if (!Array.isArray(analysis?.breakdown)) return [];
    return analysis.breakdown.filter(
      (entry) =>
        entry &&
        Number.isInteger(entry.promisePosition) &&
        entry.promisePosition >= 0 &&
        entry.promisePosition < promises.length &&
        typeof entry.reasoning === "string" &&
        Array.isArray(entry.correlatingBills),
    );
  }, [analysis, promises.length]);
  const currentAnalysis = breakdown.length > 0 ? analysis : null;
  const score =
    currentAnalysis && Number.isFinite(currentAnalysis.score)
      ? Math.max(0, Math.min(100, currentAnalysis.score))
      : null;
  const sponsoredBills = useMemo(
    () => bills.filter((bill) => bill.relationship === "sponsor"),
    [bills],
  );
  const cosponsoredBills = useMemo(
    () => bills.filter((bill) => bill.relationship === "cosponsor"),
    [bills],
  );
  const visibleBills = useMemo(
    () => [
      ...sponsoredBills,
      ...(showCosponsored ? cosponsoredBills : []),
    ],
    [cosponsoredBills, showCosponsored, sponsoredBills],
  );
  // Record each visible bill's rendered index by canonical identifier. The map
  // is recalculated when the cosponsored section opens or closes, ensuring SVG
  // connections are drawn only to cards currently present in the DOM.
  const visibleBillIndices = useMemo(() => {
    const index = new Map();
    visibleBills.forEach((bill, billIndex) => {
      const identifier = getBillIdentifier(bill);
      const indices = index.get(identifier) ?? [];
      indices.push(billIndex);
      index.set(identifier, indices);
    });
    return index;
  }, [visibleBills]);
  // Build the reverse lookup used by bill badges and hover highlighting:
  // bill identifier -> the positions of promises linked by the analysis.
  const billToPromiseIndices = useMemo(() => {
    const result = new Map();
    breakdown.forEach((entry) => {
      entry.correlatingBills.forEach((identifier) => {
        const indices = result.get(identifier) ?? [];
        indices.push(entry.promisePosition);
        result.set(identifier, indices);
      });
    });
    return result;
  }, [breakdown]);
  const billByIdentifier = useMemo(
    () => new Map(bills.map((bill) => [getBillIdentifier(bill), bill])),
    [bills],
  );
  // Convert valid breakdown links into promise/bill element indexes. Since the
  // lookup contains only visible bills, collapsed cosponsored bills get no
  // rendered connection lines.
  const diagramConnections = useMemo(() => {
    const connections = [];
    breakdown.forEach((entry, breakdownIndex) => {
      entry.correlatingBills.forEach((identifier) => {
        (visibleBillIndices.get(identifier) ?? []).forEach((billIndex) => {
          connections.push({
            promiseIndex: entry.promisePosition,
            billIndex,
            breakdownIndex,
          });
        });
      });
    });
    return connections;
  }, [breakdown, visibleBillIndices]);

  const newestPromiseTimestamp = promises.reduce((newest, promise) => {
    const timestamp = Date.parse(promise.scraped_at ?? "");
    return Number.isFinite(timestamp) ? Math.max(newest, timestamp) : newest;
  }, 0);
  const newestPromiseDate =
    newestPromiseTimestamp > 0
      ? formatDate(new Date(newestPromiseTimestamp).toISOString())
      : null;
  const analyzedAt = formatDate(currentAnalysis?.analyzed_at);
  const isAnalysisBasedOnEarlierData =
    analyzedAt &&
    newestPromiseTimestamp > 0 &&
    Date.parse(currentAnalysis.analyzed_at) < newestPromiseTimestamp;

  useEffect(() => {
    const container = containerRef.current;
    if (!container || diagramConnections.length === 0) return undefined;

      // Measures current promise and bill element bounds relative to the graph
      // container so each SVG curve ends at the matching visible cards.
      function measureConnections() {
      const currentContainer = containerRef.current;
      if (!currentContainer) return;
      const containerRect = currentContainer.getBoundingClientRect();
      const lines = diagramConnections.flatMap(
        ({ promiseIndex, billIndex, breakdownIndex }) => {
          const promiseElement = promiseRefs.current[promiseIndex];
          const billElement = billRefs.current[billIndex];
          if (!promiseElement || !billElement) return [];
          const promiseRect = promiseElement.getBoundingClientRect();
          const billRect = billElement.getBoundingClientRect();
          return [{
            x1: promiseRect.right - containerRect.left,
            y1: promiseRect.top + promiseRect.height / 2 - containerRect.top,
            x2: billRect.left - containerRect.left,
            y2: billRect.top + billRect.height / 2 - containerRect.top,
            breakdownIndex,
          }];
        },
      );
      setArrowData({
        lines,
        width: containerRect.width,
        height: currentContainer.offsetHeight,
      });
    }

    const frameId = requestAnimationFrame(measureConnections);
    const observer = new ResizeObserver(() =>
      requestAnimationFrame(measureConnections),
    );
    observer.observe(container);
    return () => {
      cancelAnimationFrame(frameId);
      observer.disconnect();
    };
  }, [diagramConnections]);

  // Toggle a card's expanded state by copying the Set, preserving React's
  // immutable state update semantics for independent bill cards.
  const toggleBill = (identifier) => {
    setExpandedBills((previous) => {
      const next = new Set(previous);
      if (next.has(identifier)) next.delete(identifier);
      else next.add(identifier);
      return next;
    });
  };

  if (loading) {
    return (
      <div className="rep-detail">
        <button className="back-btn" onClick={() => navigate("/")}>
          ← Back to Search
        </button>
        <section className="rep-info">
          <p className="loading-text">Loading representative data…</p>
        </section>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rep-detail">
        <button className="back-btn" onClick={() => navigate("/")}>
          ← Back to Search
        </button>
        <section className="rep-info">
          <h1>Could Not Load Results</h1>
          <p className="error">{error}</p>
          <button className="retry-btn" onClick={retry}>Retry</button>
        </section>
      </div>
    );
  }

  if (!member) {
    return (
      <div className="rep-detail">
        <button className="back-btn" onClick={() => navigate("/")}>
          ← Back to Search
        </button>
        <section className="rep-info">
          <h1>No Representative Found</h1>
          <p>
            There is no saved representative for Virginia district {district}.
          </p>
        </section>
      </div>
    );
  }

  const districtPortrait =
    `/rep-portraits/va-${String(district).padStart(2, "0")}.png`;
  const districtMap =
    `/district-maps/dist-${String(district).padStart(2, "0")}.png`;

  return (
    <div className="rep-detail">
      <button className="back-btn" onClick={() => navigate("/")}>
        ← Back to Search
      </button>

      <section className="rep-info">
        <p className="rep-kicker">U.S. Representative</p>
        <h1 className="rep-name">{member.name}</h1>
        <div className="rep-meta">
          {county && <span className="rep-chip"><strong>County</strong>{county}</span>}
          <span className="rep-chip">
            <strong>District</strong>VA-{member.district}
          </span>
          <span className="rep-chip">
            <strong>Party</strong>{member.party}
          </span>
        </div>
        <div className="rep-profile-sources">
          <SourceLink url={member.campaign_url}>Campaign website</SourceLink>
          <SourceLink url={member.ballotpedia_url}>Ballotpedia</SourceLink>
        </div>

        <div className="profile-visual-row">
          <figure className="rep-portrait-card">
            <img
              className="rep-portrait"
              src={districtPortrait}
              alt={`Virginia district ${district} representative`}
              onError={(event) => {
                event.currentTarget.onerror = null;
                event.currentTarget.src = "/rep-portraits/placeholder.svg";
              }}
            />
          </figure>

          <div className="profile-fulfillment">
            <h2>Promise Fulfillment Score</h2>
            <p className="score-disclaimer">
              AI estimate based on titles of recent sponsored and cosponsored
              bills
            </p>
            {score === null
              ? <p className="loading-text">Analysis pending</p>
              : (
                <div className="fulfillment-chart">
                  <div className="fulfillment-track">
                    <div
                      className="fulfillment-bar"
                      style={{ "--score": `${score}%` }}
                      role="img"
                      aria-label={`AI estimate ${score} percent`}
                    >
                      <span>{score}%</span>
                    </div>
                  </div>
                </div>
              )}
            {newestPromiseDate && (
              <p className="analysis-date">
                Last updated {newestPromiseDate}
              </p>
            )}
            {analyzedAt && (
              <p className="analysis-date">
                Analysis updated {analyzedAt}
                {isAnalysisBasedOnEarlierData ? " (based on earlier data)" : ""}
              </p>
            )}
          </div>

          <figure className="district-map-card">
            <img
              className="district-map"
              src={districtMap}
              alt={`Virginia congressional district ${district} map`}
              onError={(event) => {
                event.currentTarget.onerror = null;
                event.currentTarget.src = "/district-maps/placeholder.svg";
              }}
            />
            <figcaption className="district-map-label">
              VA-{member.district} District Map
            </figcaption>
          </figure>
        </div>
      </section>

      {senators.length > 0 && (
        <section className="senators-section">
          <h2>Virginia&apos;s U.S. Senators</h2>
          <div className="senator-list">
            {senators.map((senator) => (
              <SenatorCard key={senator.bioguide_id} senator={senator} />
            ))}
          </div>
        </section>
      )}

      <section className="graph-section">
        <h2>Promises and Legislation</h2>
        <p className="graph-hint">
          Promise sources and bill titles come from saved Supabase records.
        </p>

        <div className="graph-map-container" ref={containerRef}>
          {diagramConnections.length > 0 && arrowData.lines.length > 0 && (
            <svg
              className="graph-map-overlay"
              width={arrowData.width}
              height={arrowData.height}
              aria-hidden="true"
            >
              <defs>
                <marker
                  id="graph-arrow"
                  markerWidth="7"
                  markerHeight="7"
                  refX="5"
                  refY="3"
                  orient="auto"
                  markerUnits="strokeWidth"
                >
                  <path d="M0,0 L0,6 L6,3 z" fill="#8f5b33" opacity="0.7" />
                </marker>
              </defs>
              {arrowData.lines.map(
                ({ x1, y1, x2, y2, breakdownIndex }, index) => {
                  const midpoint = (x1 + x2) / 2;
                  const color =
                    PROMISE_COLORS[breakdownIndex % PROMISE_COLORS.length];
                  return (
                    <path
                      key={index}
                      d={`M ${x1} ${y1} C ${midpoint} ${y1}, ${midpoint} ${y2}, ${x2} ${y2}`}
                      fill="none"
                      stroke={color}
                      strokeWidth="2"
                      strokeLinecap="round"
                      markerEnd="url(#graph-arrow)"
                      opacity="0.65"
                    />
                  );
                },
              )}
            </svg>
          )}

          <div className="graph-layout">
            <div className="graph-col graph-col--promises">
              <h3>Campaign Promises</h3>
              {promises.length > 0
                ? promises.map((promise, index) => {
                  return (
                    <div
                        key={`${promise.position}-${promise.topic}`}
                        className="graph-promise-card"
                        ref={(element) => {
                          promiseRefs.current[index] = element;
                        }}
                        onMouseEnter={() =>
                          setHoveredPromiseIndex(index)
                        }
                        onMouseLeave={() => setHoveredPromiseIndex(null)}
                      >
                        <span
                          className="promise-badge"
                          style={{
                            background:
                              PROMISE_COLORS[index % PROMISE_COLORS.length],
                          }}
                        >
                          {index + 1}
                        </span>
                        <div>
                          <strong>{promise.topic}</strong>
                          <p>{promise.text}</p>
                          <SourceLink url={promise.source_url}>Source</SourceLink>
                        </div>
                      </div>
                    );
                  })
                : (
                  <p className="no-bills">
                    No promises found yet.{" "}
                    <SourceLink url={member.campaign_url}>
                      Visit the campaign site
                    </SourceLink>
                  </p>
                )}
            </div>

            <div className="graph-col graph-col--bills">
              <h3>Recently Sponsored Bills</h3>
              {sponsoredBills.length > 0
                ? sponsoredBills.map((bill, index) => {
                    const identifier = getBillIdentifier(bill);
                    const indices = billToPromiseIndices.get(identifier) ?? [];
                    const isHoverMatch =
                      hoveredPromiseIndex !== null &&
                      indices.includes(hoveredPromiseIndex);
                    return (
                      <div
                        key={`${identifier}-sponsor-${index}`}
                        className="bill-card-wrap"
                        style={{
                          "--hover-tint": isHoverMatch
                            ? "rgba(143,91,51,0.2)"
                            : "transparent",
                        }}
                        ref={(element) => {
                          billRefs.current[index] = element;
                        }}
                      >
                        <BillCard
                          bill={bill}
                          indices={indices}
                          expanded={expandedBills.has(`sponsor:${identifier}:${index}`)}
                          highlighted={isHoverMatch}
                          onToggle={() =>
                            toggleBill(`sponsor:${identifier}:${index}`)
                          }
                          title={() => promises[indices[0]]?.topic}
                        />
                      </div>
                    );
                  })
                : <p className="no-bills">No sponsored bills found yet.</p>}

              <button
                className="cosponsored-toggle"
                type="button"
                onClick={() => setShowCosponsored((shown) => !shown)}
                aria-expanded={showCosponsored}
              >
                {showCosponsored ? "Hide" : "Show"} cosponsored (
                {cosponsoredBills.length})
              </button>
              {showCosponsored &&
                (cosponsoredBills.length > 0
                  ? cosponsoredBills.map((bill, index) => {
                      const identifier = getBillIdentifier(bill);
                      const visibleIndex = sponsoredBills.length + index;
                      const indices =
                        billToPromiseIndices.get(identifier) ?? [];
                      const isHoverMatch =
                        hoveredPromiseIndex !== null &&
                        indices.includes(hoveredPromiseIndex);
                      return (
                        <div
                          key={`${identifier}-cosponsor-${index}`}
                          className="bill-card-wrap"
                          style={{
                            "--hover-tint": isHoverMatch
                              ? "rgba(143,91,51,0.2)"
                              : "transparent",
                          }}
                          ref={(element) => {
                            billRefs.current[visibleIndex] = element;
                          }}
                        >
                          <BillCard
                            bill={bill}
                            indices={indices}
                            expanded={expandedBills.has(
                              `cosponsor:${identifier}:${index}`,
                            )}
                            highlighted={isHoverMatch}
                            onToggle={() =>
                              toggleBill(`cosponsor:${identifier}:${index}`)
                            }
                            title={() => promises[indices[0]]?.topic}
                          />
                        </div>
                      );
                    })
                  : <p className="no-bills">No cosponsored bills found yet.</p>)}
            </div>
          </div>
        </div>
      </section>

      {breakdown.length > 0 && (
        <section className="breakdown-section">
          <h2>Detailed Breakdown</h2>
          <p className="graph-hint">
            Analysis is linked to promises by their saved position.
          </p>
          <div className="breakdown-list">
            {breakdown.map((entry) => (
              <div
                key={entry.promisePosition}
                className="breakdown-item"
              >
                <div className="breakdown-header">
                  <span
                    className="promise-badge"
                    style={{
                      background:
                        PROMISE_COLORS[
                          entry.promisePosition % PROMISE_COLORS.length
                        ],
                    }}
                  >
                    {entry.promisePosition + 1}
                  </span>
                  <strong>
                    {promises[entry.promisePosition]?.topic ?? "Promise"}
                  </strong>
                </div>
                <p className="breakdown-promise-text">
                  {promises[entry.promisePosition]?.text}
                </p>
                <p className="breakdown-reasoning">{entry.reasoning}</p>
                {entry.correlatingBills.length > 0
                  ? (
                    <ul className="breakdown-bills">
                      {entry.correlatingBills.map((identifier) => {
                        const bill = billByIdentifier.get(identifier);
                        return (
                          <li key={identifier}>
                            <span className="bill-tag">{identifier}</span>
                            {bill?.title ??
                              "Bill details are not in the saved list."}
                          </li>
                        );
                      })}
                    </ul>
                  )
                  : <p className="no-bills">No correlated bills found.</p>}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
