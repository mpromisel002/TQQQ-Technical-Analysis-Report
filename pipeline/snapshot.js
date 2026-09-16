#!/usr/bin/env node
/*
 * Writes the daily support/resistance snapshot using the same method as the page.
 *   node pipeline/snapshot.js            -> snapshot for the latest session
 *   node pipeline/snapshot.js --backfill 30   -> also (re)build the last 30 sessions
 * Outputs:
 *   docs/data/history/YYYY-MM-DD.json   one per session (default 12-month settings)
 *   docs/data/history/index.json        list of snapshot dates
 *   docs/data/changes.json              what changed vs the previous snapshot
 */
"use strict";
const fs = require("fs");
const path = require("path");
const SR = require("../docs/js/support.js");

const ROOT = path.resolve(__dirname, "..");
const DATA = path.join(ROOT, "docs", "data");
const HIST = path.join(DATA, "history");
const KEEP = 400; // snapshots kept (~18 months)

const args = process.argv.slice(2);
const bi = args.indexOf("--backfill");
const backfill = bi >= 0 ? parseInt(args[bi + 1], 10) || 20 : 0;

const payload = JSON.parse(fs.readFileSync(path.join(DATA, "tqqq.json"), "utf8"));
const data = SR.fromPayload(payload);
fs.mkdirSync(HIST, { recursive: true });

const n = data.close.length;
const ends = [];
for (let k = backfill; k >= 0; k--) if (n - 1 - k >= 260) ends.push(n - 1 - k);
for (const end of ends) {
  const snap = SR.snapshot(SR.truncate(data, end), {});
  fs.writeFileSync(path.join(HIST, `${snap.as_of}.json`), JSON.stringify(snap));
}

let dates = fs.readdirSync(HIST).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.slice(0, 10)).sort();
for (const old of dates.slice(0, Math.max(0, dates.length - KEEP))) fs.unlinkSync(path.join(HIST, `${old}.json`));
dates = dates.slice(-KEEP);
fs.writeFileSync(path.join(HIST, "index.json"), JSON.stringify({ dates }));

const load = (d) => JSON.parse(fs.readFileSync(path.join(HIST, `${d}.json`), "utf8"));
const cur = load(dates[dates.length - 1]);
const prev = dates.length > 1 ? load(dates[dates.length - 2]) : null;
const changes = { as_of: cur.as_of, previous: prev ? prev.as_of : null, items: SR.diffSnapshots(prev, cur) };
fs.writeFileSync(path.join(DATA, "changes.json"), JSON.stringify(changes, null, 1));
console.log(`snapshot ${cur.as_of}: ${cur.supports.length} supports, ${cur.resistances.length} resistances, ${changes.items.length} changes; ${dates.length} snapshots kept`);
