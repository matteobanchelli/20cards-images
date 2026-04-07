/**
 * sync.mjs — Download card images missing from this repo.
 *
 * Reads the card list from Supabase, checks which images don't exist
 * locally, and downloads them from Limitless CDN (original source).
 *
 * Env vars: SUPABASE_URL, SUPABASE_KEY
 */

import fs from "node:fs";
import path from "node:path";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_KEY");
  process.exit(1);
}

const LIMITLESS_BASE =
  "https://limitlesstcg.nyc3.cdn.digitaloceanspaces.com/pocket";
const OUTPUT_DIR = "pocket";
const CONCURRENCY = 10;

function toFileSetId(setId) {
  return setId.replace(/^PROMO-/, "P-");
}

function localPath(setId, localId) {
  const s = toFileSetId(setId);
  return path.join(OUTPUT_DIR, s, `${s}_${localId}_EN.webp`);
}

function limitlessUrl(setId, localId) {
  const s = toFileSetId(setId);
  return `${LIMITLESS_BASE}/${s}/${s}_${localId}_EN.webp`;
}

async function supabaseFetch(endpoint) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${endpoint}`, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.json();
}

async function fetchAllCards() {
  let all = [];
  let offset = 0;
  const limit = 1000;
  while (true) {
    const data = await supabaseFetch(
      `cards?select=id,set_id,local_id&order=id&offset=${offset}&limit=${limit}`
    );
    all = all.concat(data);
    if (data.length < limit) break;
    offset += limit;
  }
  return all;
}

async function downloadOne(card) {
  const dest = localPath(card.set_id, card.local_id);
  if (fs.existsSync(dest)) return { status: "exists" };

  fs.mkdirSync(path.dirname(dest), { recursive: true });

  try {
    const res = await fetch(limitlessUrl(card.set_id, card.local_id));
    if (!res.ok) return { status: "error", id: card.id, code: res.status };
    fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    return { status: "new", id: card.id };
  } catch (err) {
    return { status: "error", id: card.id, error: err.message };
  }
}

async function pooled(items, concurrency, fn) {
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

// --- main ---
const cards = await fetchAllCards();
console.log(`Total cards in DB: ${cards.length}`);

const missing = cards.filter((c) => !fs.existsSync(localPath(c.set_id, c.local_id)));
console.log(`Missing images: ${missing.length}`);

if (missing.length === 0) {
  console.log("All images up to date.");
  process.exit(0);
}

const results = await pooled(missing, CONCURRENCY, downloadOne);

const downloaded = results.filter((r) => r.status === "new");
const errors = results.filter((r) => r.status === "error");

console.log(`\nDownloaded: ${downloaded.length}`);
console.log(`Errors: ${errors.length}`);

if (errors.length > 0) {
  console.log("\nFailed:");
  for (const e of errors) console.log(`  ${e.id}: ${e.code || e.error}`);
}
