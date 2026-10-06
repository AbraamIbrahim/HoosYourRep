import assert from "node:assert/strict";
import axios from "axios";
import process from "node:process";
import test from "node:test";
import {
  buildReplaceBillsRpcArgs,
  getCosponsoredBills,
  getSponsoredBills,
  normalizeBillRecords,
  toBillRpcPayload,
} from "../lib/congress.js";

test("normalizes, current-Congress prioritizes, and date-sorts bills", () => {
  const normalized = normalizeBillRecords(
    {
      sponsoredLegislation: [
        {
          congress: 118,
          type: "hr",
          number: 12,
          title: "Older Congress",
          introducedDate: "2025-01-01",
        },
        {
          congress: 119,
          type: "s",
          number: 34,
          title: "Old current bill",
          introducedDate: "2025-01-01",
        },
        {
          congress: 119,
          type: "hr",
          number: 56,
          title: "Newest current bill",
          introducedDate: "2025-02-01",
        },
        {
          congress: 119,
          type: "hr",
          number: 78,
          title: "Missing date",
        },
        {
          congress: 119,
          type: "hr",
          number: 90,
          title: " ",
        },
      ],
    },
    "sponsoredLegislation",
    119,
  );

  assert.deepEqual(normalized, [
    {
      congress: 119,
      type: "hr",
      number: "56",
      title: "Newest current bill",
      introducedDate: "2025-02-01",
    },
    {
      congress: 119,
      type: "s",
      number: "34",
      title: "Old current bill",
      introducedDate: "2025-01-01",
    },
    {
      congress: 119,
      type: "hr",
      number: "78",
      title: "Missing date",
      introducedDate: null,
    },
    {
      congress: 118,
      type: "hr",
      number: "12",
      title: "Older Congress",
      introducedDate: "2025-01-01",
    },
  ]);
});

test("sponsored bills keep their cap of ten", () => {
  const normalized = normalizeBillRecords(
    Array.from({ length: 12 }, (_, index) => ({
      congress: 119,
      type: "hr",
      number: index + 1,
      title: `Bill ${index + 1}`,
      introducedDate: `2025-${String(index + 1).padStart(2, "0")}-01`,
    })),
    "sponsoredLegislation",
    119,
  );

  assert.equal(normalized.length, 10);
  assert.equal(normalized[0].number, "12");
  assert.equal(normalized[9].number, "3");
});

test("normalizes co-sponsored titles from title or latestTitle and caps at twenty", () => {
  const normalized = normalizeBillRecords(
    {
      cosponsoredLegislation: [
        {
          congress: 119,
          type: "hr",
          number: 1,
          latestTitle: "Latest title",
          introducedDate: "2025-02-01",
        },
        {
          congress: 119,
          type: "hr",
          number: 2,
          title: "Current title",
          latestTitle: "Ignored fallback",
          introducedDate: "2025-01-01",
        },
        {
          congress: 118,
          type: "s",
          number: 3,
          latestTitle: "Older Congress",
          introducedDate: "2025-03-01",
        },
      ],
    },
    "cosponsoredLegislation",
    119,
    20,
  );

  assert.deepEqual(normalized, [
    {
      congress: 119,
      type: "hr",
      number: "1",
      title: "Latest title",
      introducedDate: "2025-02-01",
    },
    {
      congress: 119,
      type: "hr",
      number: "2",
      title: "Current title",
      introducedDate: "2025-01-01",
    },
    {
      congress: 118,
      type: "s",
      number: "3",
      title: "Older Congress",
      introducedDate: "2025-03-01",
    },
  ]);
});

test("co-sponsored legislation is capped at twenty and prefers the current Congress", () => {
  const normalized = normalizeBillRecords(
    Array.from({ length: 25 }, (_, index) => ({
      congress: index === 0 ? 118 : 119,
      type: "hr",
      number: index + 1,
      title: `Bill ${index + 1}`,
      introducedDate: new Date(Date.UTC(2025, 0, index + 1))
        .toISOString()
        .slice(0, 10),
    })),
    "cosponsoredLegislation",
    119,
    20,
  );

  assert.equal(normalized.length, 20);
  assert.equal(normalized[0].number, "25");
  assert.equal(normalized.some((bill) => bill.congress === 118), false);
});

test("RPC bill payload preserves introduced dates using the database column name", () => {
  assert.deepEqual(
    toBillRpcPayload([
      {
        congress: 119,
        type: "hr",
        number: "20",
        title: "Example bill",
        introducedDate: "2025-02-01",
      },
    ]),
    [
      {
        congress: 119,
        type: "hr",
        number: "20",
        title: "Example bill",
        introduced_date: "2025-02-01",
      },
    ],
  );
});

test("replacement arguments use the relationship-aware RPC signature for each list", () => {
  const bills = [
    {
      congress: 119,
      type: "hr",
      number: "20",
      title: "Example bill",
      introducedDate: "2025-02-01",
    },
  ];

  assert.deepEqual(
    buildReplaceBillsRpcArgs("W000804", "sponsor", bills),
    {
      p_bioguide_id: "W000804",
      p_relationship: "sponsor",
      p_bills: [
        {
          congress: 119,
          type: "hr",
          number: "20",
          title: "Example bill",
          introduced_date: "2025-02-01",
        },
      ],
    },
  );
  assert.equal(
    buildReplaceBillsRpcArgs("W000804", "cosponsor", bills).p_relationship,
    "cosponsor",
  );
});

test("loads co-sponsored bills from the Congress.gov endpoint with the requested limit", async () => {
  const originalGet = axios.get;
  const originalApiKey = process.env.CONGRESS_API_KEY;
  let requestUrl;
  let requestOptions;
  axios.get = async (url, options) => {
    requestUrl = url;
    requestOptions = options;
    return {
      data: {
        cosponsoredLegislation: [
          {
            congress: 119,
            type: "hr",
            number: 20,
            latestTitle: "Example bill",
            introducedDate: "2025-02-01",
          },
        ],
      },
    };
  };
  process.env.CONGRESS_API_KEY = "test-api-key";

  try {
    const bills = await getCosponsoredBills("W000804", 119);
    assert.equal(
      requestUrl,
      "https://api.congress.gov/v3/member/W000804/cosponsored-legislation",
    );
    assert.equal(requestOptions.params.limit, 50);
    assert.deepEqual(bills, [
      {
        congress: 119,
        type: "hr",
        number: "20",
        title: "Example bill",
        introducedDate: "2025-02-01",
      },
    ]);
  } finally {
    axios.get = originalGet;
    if (originalApiKey === undefined) {
      delete process.env.CONGRESS_API_KEY;
    } else {
      process.env.CONGRESS_API_KEY = originalApiKey;
    }
  }
});

test("Congress.gov bill number endpoints preserve introducedDate", async () => {
  const originalGet = axios.get;
  const originalApiKey = process.env.CONGRESS_API_KEY;
  axios.get = async () => ({
    data: {
      sponsoredLegislation: [
        {
          congress: 119,
          type: "hr",
          number: 99,
          title: "Introduced bill",
          introducedDate: "2025-03-04",
        },
      ],
    },
  });
  process.env.CONGRESS_API_KEY = "test-api-key";

  try {
    const bills = await getSponsoredBills("W000804", 119);
    assert.equal(bills[0].introducedDate, "2025-03-04");
  } finally {
    axios.get = originalGet;
    if (originalApiKey === undefined) {
      delete process.env.CONGRESS_API_KEY;
    } else {
      process.env.CONGRESS_API_KEY = originalApiKey;
    }
  }
});
