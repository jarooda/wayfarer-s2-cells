// Wayfarer change watcher.
// Fetches the public Wayfarer app shell (no login, no cookies), fingerprints the
// JS bundles and checks that the things scripts/bridge.js relies on still exist.
//
// Exit is always 0 unless the script itself crashes; the result is written to
// $GITHUB_OUTPUT as `status` (ok | changed | broken | baseline) and `cause`,
// and a markdown report to watch/report.md for the workflow to post.
//
// Run locally: node watch/check.mjs

import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ORIGIN = 'https://wayfarer.scopely.com';
const PAGE = `${ORIGIN}/mapview`;
const UA = 's2-cell-overlay-watch (+https://github.com/jarooda/wayfarer-s2-cells)';
const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(HERE, 'state.json');
const REPORT_FILE = join(HERE, 'report.md');

// What bridge.js depends on. Each test runs against main bundle + map page chunk.
// If one goes missing, map detection is likely broken.
const SIGNALS = [
  {
    id: 'maps-loader',
    why: 'Page loads the Google Maps JS API (bridge hooks window.google.maps)',
    test: src => src.includes('maps.googleapis.com/maps/api/js'),
  },
  {
    id: 'map-constructor',
    why: 'Page constructs a google.maps.Map (bridge wraps the Map constructor)',
    test: src => /new [\w$.]+\.Map\(/.test(src),
  },
  {
    id: 'map-listeners',
    why: 'Map instance uses addListener (bridge relies on bounds/idle/click events)',
    test: src => src.includes('.addListener('),
  },
];

async function get(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function readState() {
  try { return JSON.parse(await readFile(STATE_FILE, 'utf8')); } catch { return null; }
}

function setOutput(key, value) {
  if (!process.env.GITHUB_OUTPUT) return Promise.resolve();
  return appendFile(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

async function inspect() {
  const html = await get(PAGE);
  const entry = html.match(/<script[^>]+src="([^"]*\/assets\/index-[^"]+\.js)"/);
  if (!entry) throw Object.assign(new Error('Main bundle script tag not found in /mapview HTML'), { cause: 'no-entry-bundle' });
  const entryUrl = new URL(entry[1], ORIGIN).href;
  const main = await get(entryUrl);

  const chunk = main.match(/"(assets\/MapViewPage-[^"]+\.js)"/);
  if (!chunk) throw Object.assign(new Error('MapViewPage chunk not referenced by main bundle'), { cause: 'no-mapview-chunk' });
  const chunkUrl = new URL(chunk[1], entryUrl.replace(/assets\/[^/]+$/, '')).href;
  const mapPage = await get(chunkUrl);

  const src = main + '\n' + mapPage;
  const signals = Object.fromEntries(SIGNALS.map(s => [s.id, s.test(src)]));
  return {
    bundles: { main: entryUrl.split('/').pop(), mapPage: chunkUrl.split('/').pop() },
    signals,
  };
}

async function main() {
  const prev = await readState();
  const now = new Date().toISOString();
  let status, cause, lines = [];

  let cur;
  try {
    cur = await inspect();
  } catch (err) {
    status = 'broken';
    cause = err.cause && typeof err.cause === 'string' ? err.cause : 'fetch-failed';
    lines.push(`Could not inspect Wayfarer: **${err.message}**`);
  }

  if (cur) {
    const missing = SIGNALS.filter(s => !cur.signals[s.id]);
    const changed = !prev || prev.bundles.main !== cur.bundles.main || prev.bundles.mapPage !== cur.bundles.mapPage;

    if (missing.length) {
      status = 'broken';
      cause = `signal-missing:${missing.map(s => s.id).join(',')}`;
      lines.push('Map signals missing from the Wayfarer bundle:', '');
      for (const s of missing) lines.push(`- \`${s.id}\`: ${s.why}`);
    } else if (!prev) {
      status = 'baseline';
      cause = 'baseline';
      lines.push('First run: recorded baseline, all signals present.');
    } else if (changed) {
      status = 'changed';
      cause = 'frontend-changed';
      lines.push('Wayfarer frontend changed; all map signals still present.');
    } else {
      status = 'ok';
      cause = 'ok';
      lines.push('No change.');
    }

    lines.push('', '| | Previous | Current |', '|---|---|---|');
    lines.push(`| Main bundle | \`${prev?.bundles.main ?? '-'}\` | \`${cur.bundles.main}\` |`);
    lines.push(`| Map page chunk | \`${prev?.bundles.mapPage ?? '-'}\` | \`${cur.bundles.mapPage}\` |`);

    // Only persist when the frontend actually looks healthy or changed; keep the
    // last good state when broken so the next run compares against it.
    if (status !== 'broken' && status !== 'ok') {
      await writeFile(STATE_FILE, JSON.stringify({ checkedAt: now, ...cur }, null, 2) + '\n');
    }
  }

  const report = [`**Status:** \`${status}\` (\`${cause}\`)`, '', ...lines].join('\n') + '\n';
  await writeFile(REPORT_FILE, report);
  console.log(report);
  await setOutput('status', status);
  await setOutput('cause', cause);
}

main().catch(err => { console.error(err); process.exit(1); });
