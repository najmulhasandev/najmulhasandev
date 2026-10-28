#!/usr/bin/env node
/**
 * Generates the "GitHub Activity" section of the profile README from the
 * official GitHub GraphQL API. No third-party services, no dependencies.
 *
 * Writes (relative to the repo root):
 *   assets/github-activity/{stats,languages,heatmap}-{dark,light}.svg
 *   assets/github-activity/data.json   (last successful data; also the change check)
 *   README.md                          (only the block between the github-activity markers)
 *
 * Environment:
 *   GITHUB_TOKEN        required. Read-only is enough; only public data is requested.
 *   GITHUB_USER         default: najmulhasandev
 *   OUT_DIR             default: assets/github-activity
 *   README_PATH         default: README.md
 *   GITHUB_GRAPHQL_URL  default: https://api.github.com/graphql (override for tests)
 *
 * Flags:
 *   --force             re-render even when the data has not changed
 *
 * Failure behaviour: if GitHub cannot be reached or rejects the token, the script
 * exits non-zero BEFORE writing anything, so the previously committed files stay.
 * It never writes an error graphic.
 */
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const LOGIN = process.env.GITHUB_USER || 'najmulhasandev';
const OUT_DIR = process.env.OUT_DIR || 'assets/github-activity';
const README_PATH = process.env.README_PATH || 'README.md';
const GRAPHQL_URL = process.env.GITHUB_GRAPHQL_URL || 'https://api.github.com/graphql';
const RAW_BASE = `https://raw.githubusercontent.com/${LOGIN}/${LOGIN}/main/assets/github-activity`;
const START_MARK = '<!-- github-activity:start -->';
const END_MARK = '<!-- github-activity:end -->';
const FONT = '-apple-system, BlinkMacSystemFont, Segoe UI, Noto Sans, Helvetica, Arial, sans-serif';
const LEVELS = { NONE: 0, FIRST_QUARTILE: 1, SECOND_QUARTILE: 2, THIRD_QUARTILE: 3, FOURTH_QUARTILE: 4 };

const THEMES = {
  dark: {
    bg: '#0d1117', border: '#30363d', text: '#e6edf3', muted: '#8b949e', accent: '#58a6ff',
    levels: ['#161b22', '#0e4429', '#006d32', '#26a641', '#39d353'], other: '#6e7681', fallback: '#d2a8ff',
  },
  light: {
    bg: '#ffffff', border: '#d0d7de', text: '#1f2328', muted: '#59636e', accent: '#0969da',
    levels: ['#ebedf0', '#9be9a8', '#40c463', '#30a14e', '#216e39'], other: '#8c959f', fallback: '#8250df',
  },
};

// ---------------------------------------------------------------- GitHub API

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gql(token, query, variables) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(GRAPHQL_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': `${LOGIN}-profile-activity`,
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status >= 500) throw new Error(`GitHub API responded ${res.status}`); // retryable
      if (!res.ok) {
        const err = new Error(`GitHub API responded ${res.status}`);
        err.fatal = true;
        throw err;
      }
      const json = await res.json();
      if (json.errors?.length) {
        const err = new Error(`GraphQL error: ${json.errors.map((e) => e.message).join('; ')}`);
        err.fatal = true;
        throw err;
      }
      return json.data;
    } catch (e) {
      lastErr = e;
      if (e.fatal || attempt === 3) break;
      await sleep(1000 * attempt);
    }
  }
  throw lastErr; // messages never contain the token
}

const CALENDAR = `contributionsCollection { contributionCalendar { totalContributions weeks { contributionDays { date contributionCount contributionLevel weekday } } } }`;
const query = (withCalendar) => `query($login: String!, $cursor: String) {
  user(login: $login) {
    ${withCalendar ? CALENDAR : ''}
    repositories(first: 100, after: $cursor, ownerAffiliations: OWNER, privacy: PUBLIC, isFork: false, orderBy: {field: NAME, direction: ASC}) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes { stargazerCount languages(first: 20, orderBy: {field: SIZE, direction: DESC}) { edges { size node { name color } } } }
    }
  }
}`;

async function fetchData(token) {
  let calendar = null;
  const repos = [];
  let repoCount = 0;
  let cursor = null;
  for (let page = 0; page < 20; page++) {
    const data = await gql(token, query(page === 0), { login: LOGIN, cursor });
    if (!data?.user) throw new Error(`GitHub user "${LOGIN}" not found`);
    if (page === 0) calendar = data.user.contributionsCollection?.contributionCalendar;
    const r = data.user.repositories;
    repoCount = r.totalCount;
    repos.push(...r.nodes);
    if (!r.pageInfo.hasNextPage) break;
    cursor = r.pageInfo.endCursor;
  }
  if (!calendar?.weeks?.length) throw new Error('GitHub returned no contribution calendar');
  return normalize(calendar, repos, repoCount);
}

// ------------------------------------------------------------------- compute

export function computeStreaks(days) {
  // `days` is contiguous and sorted ascending: [{ date, count }]
  let longest = { length: 0, start: null, end: null };
  let run = 0;
  let runStart = null;
  for (const d of days) {
    if (d.count > 0) {
      if (run === 0) runStart = d.date;
      run++;
      if (run >= longest.length) longest = { length: run, start: runStart, end: d.date };
    } else {
      run = 0;
    }
  }
  // Today is the last day. If it has no activity YET, the streak is not broken:
  // count back from yesterday and flag it, instead of showing 0.
  let i = days.length - 1;
  let throughYesterday = false;
  if (i >= 0 && days[i].count === 0) {
    throughYesterday = true;
    i--;
  }
  const endIdx = i;
  let length = 0;
  while (i >= 0 && days[i].count > 0) {
    length++;
    i--;
  }
  return {
    current: {
      length,
      start: length ? days[i + 1].date : null,
      end: length ? days[endIdx].date : null,
      throughYesterday: throughYesterday && length > 0,
    },
    longest,
  };
}

function normalize(calendar, repos, repoCount) {
  // Drop anything later than tomorrow (UTC) as a guard against timezone skew.
  const limit = new Date(Date.now() + 36 * 3600 * 1000).toISOString().slice(0, 10);
  const weeks = calendar.weeks
    .map((w) =>
      w.contributionDays
        .filter((d) => d.date <= limit)
        .sort((a, b) => a.date.localeCompare(b.date))
        .map((d) => [d.date, d.contributionCount, LEVELS[d.contributionLevel] ?? 0, d.weekday]),
    )
    .filter((w) => w.length);
  const days = weeks.flat().map(([date, count]) => ({ date, count }));
  const { current, longest } = computeStreaks(days);

  const bytes = new Map();
  const colors = new Map();
  let stars = 0;
  for (const repo of repos) {
    stars += repo.stargazerCount || 0;
    for (const e of repo.languages?.edges || []) {
      bytes.set(e.node.name, (bytes.get(e.node.name) || 0) + e.size);
      if (e.node.color && !colors.has(e.node.name)) colors.set(e.node.name, e.node.color);
    }
  }
  const ranked = [...bytes].sort((a, b) => b[1] - a[1]);
  const totalBytes = ranked.reduce((s, [, n]) => s + n, 0);
  const top = ranked.slice(0, 6).map(([name, n]) => ({ name, bytes: n, color: colors.get(name) || null }));
  const otherBytes = totalBytes - top.reduce((s, l) => s + l.bytes, 0);

  return {
    login: LOGIN,
    totalContributions: days.reduce((s, d) => s + d.count, 0),
    activeDays: days.filter((d) => d.count > 0).length,
    current,
    longest,
    publicRepos: repoCount,
    stars,
    languages: top,
    otherBytes,
    totalBytes,
    weeks,
  };
}

// ----------------------------------------------------------------- formatting

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmt = (n) => n.toLocaleString('en-US');
const md = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const mdy = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const mon = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
const plural = (n, w) => `${fmt(n)} ${w}${n === 1 ? '' : 's'}`;
const pct = (n, total) => (total ? `${((n / total) * 100).toFixed(1)}%` : '0.0%');
const range = (s) => (s.length ? `${md(s.start)} – ${md(s.end)}` : 'none');
const stamp = (iso) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function busiest(d) {
  let best = null;
  for (const [date, count] of d.weeks.flat()) if (!best || count > best.count) best = { date, count };
  return best;
}

function summaries(d) {
  const b = busiest(d);
  const streak = d.current.length
    ? `current streak ${plural(d.current.length, 'day')}${d.current.throughYesterday ? ' (through yesterday)' : ''}`
    : 'no current streak';
  return {
    stats: `GitHub statistics for ${d.login}: ${plural(d.totalContributions, 'contribution')} in the last 12 months; ${streak}; longest streak in that period ${plural(d.longest.length, 'day')}; ${fmt(d.publicRepos)} public ${d.publicRepos === 1 ? 'repository' : 'repositories'} excluding forks; ${plural(d.stars, 'star')} on them.`,
    languages: d.languages.length
      ? `Top languages by bytes across owned public repositories: ${d.languages.map((l) => `${l.name} ${pct(l.bytes, d.totalBytes)}`).join(', ')}${d.otherBytes > 0 ? `, other ${pct(d.otherBytes, d.totalBytes)}` : ''}.`
      : '',
    heatmap: `Contribution heatmap for the last 12 months: active on ${fmt(d.activeDays)} days${b && b.count > 0 ? `; busiest day ${mdy(b.date)} with ${plural(b.count, 'contribution')}` : ''}. Each cell is one day.`,
  };
}

// ------------------------------------------------------------------ rendering

function open(w, h, title, desc, t) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-labelledby="t d" font-family="${FONT}">
<title id="t">${esc(title)}</title>
<desc id="d">${esc(desc)}</desc>
<rect x=".5" y=".5" width="${w - 1}" height="${h - 1}" rx="8" fill="${t.bg}" stroke="${t.border}"/>
`;
}

function statsSvg(d, t, s) {
  const W = 800;
  const H = 124;
  const cols = [
    [fmt(d.totalContributions), 'Contributions', 'Last 12 months'],
    [fmt(d.current.length), 'Current streak', d.current.length ? range(d.current) : 'no active streak'],
    [fmt(d.longest.length), 'Longest streak', d.longest.length ? range(d.longest) : 'none'],
    [fmt(d.publicRepos), 'Public repos', 'owned, excluding forks'],
    [fmt(d.stars), 'Stars', 'on those repos'],
  ];
  let out = open(W, H, 'GitHub statistics', s.stats, t);
  cols.forEach(([value, label, sub], i) => {
    const cx = 80 + i * 160;
    if (i > 0) out += `<line x1="${i * 160}" y1="24" x2="${i * 160}" y2="100" stroke="${t.border}"/>\n`;
    out += `<text x="${cx}" y="58" text-anchor="middle" font-size="30" font-weight="700" fill="${t.accent}">${esc(value)}</text>\n`;
    out += `<text x="${cx}" y="82" text-anchor="middle" font-size="13" fill="${t.text}">${esc(label)}</text>\n`;
    out += `<text x="${cx}" y="102" text-anchor="middle" font-size="11" fill="${t.muted}">${esc(clip(sub, 30))}</text>\n`;
  });
  return `${out}</svg>\n`;
}

function languagesSvg(d, t, s) {
  const W = 800;
  const H = 150;
  const items = d.languages.map((l) => ({ ...l, color: l.color || t.fallback })) // no colour from GitHub: distinct from "Other";
  if (d.otherBytes > 0) items.push({ name: 'Other', bytes: d.otherBytes, color: t.other });
  const total = d.totalBytes;
  let out = open(W, H, 'Top languages', s.languages, t);
  out += `<text x="24" y="30" font-size="14" font-weight="600" fill="${t.text}">Top languages</text>\n`;
  out += `<text x="776" y="30" text-anchor="end" font-size="11" fill="${t.muted}">by bytes, owned public repos, excluding forks</text>\n`;
  out += `<clipPath id="bar"><rect x="24" y="44" width="752" height="10" rx="5"/></clipPath>\n<g clip-path="url(#bar)">\n`;
  let x = 24;
  for (const it of items) {
    const w = (it.bytes / total) * 752;
    out += `<rect x="${x.toFixed(2)}" y="44" width="${w.toFixed(2)}" height="10" fill="${it.color}"><title>${esc(it.name)} ${pct(it.bytes, total)}</title></rect>\n`;
    x += w;
  }
  out += `</g>\n`;
  items.forEach((it, i) => {
    const col = i % 4;
    const row = Math.floor(i / 4);
    const lx = 24 + col * 190;
    const ly = 88 + row * 28;
    out += `<circle cx="${lx + 5}" cy="${ly - 4}" r="5" fill="${it.color}"/>\n`;
    out += `<text x="${lx + 16}" y="${ly}" font-size="12" fill="${t.text}">${esc(clip(it.name, 16))}</text>\n`;
    out += `<text x="${lx + 172}" y="${ly}" text-anchor="end" font-size="12" fill="${t.muted}">${pct(it.bytes, total)}</text>\n`;
  });
  return `${out}</svg>\n`;
}

function heatmapSvg(d, t, s) {
  const W = 800;
  const x0 = 40;
  const y0 = 64;
  const n = d.weeks.length;
  const pitch = Math.min(14, Math.floor((W - x0 - 16) / n));
  const cell = pitch - 3;
  const H = y0 + 7 * pitch + 44;
  let out = open(W, H, 'Contribution heatmap, last 12 months', s.heatmap, t);
  out += `<text x="24" y="30" font-size="14" font-weight="600" fill="${t.text}">Contributions in the last 12 months</text>\n`;
  out += `<text x="776" y="30" text-anchor="end" font-size="11" fill="${t.muted}">${plural(d.totalContributions, 'contribution')}</text>\n`;

  // Month labels sit on the first week of each month. If the leading partial week's
  // label would crowd the next one, drop the leading one so no month is skipped.
  const labels = [];
  d.weeks.forEach((w, wi) => {
    const m = mon(w[0][0]);
    if (!labels.length || labels[labels.length - 1].m !== m) labels.push({ wi, m });
  });
  if (labels.length > 1 && labels[1].wi - labels[0].wi < 3) labels.shift();
  for (const { wi, m } of labels) {
    out += `<text x="${x0 + wi * pitch}" y="${y0 - 8}" font-size="11" fill="${t.muted}">${m}</text>\n`;
  }
  [['Mon', 1], ['Wed', 3], ['Fri', 5]].forEach(([label, row]) => {
    out += `<text x="${x0 - 8}" y="${y0 + row * pitch + cell - 1}" text-anchor="end" font-size="10" fill="${t.muted}">${label}</text>\n`;
  });

  d.weeks.forEach((w, wi) => {
    for (const [date, count, level, weekday] of w) {
      const label = `${mdy(date)}: ${count === 0 ? 'no contributions' : plural(count, 'contribution')}`;
      out += `<rect x="${x0 + wi * pitch}" y="${y0 + weekday * pitch}" width="${cell}" height="${cell}" rx="2" fill="${t.levels[level]}"><title>${esc(label)}</title></rect>\n`;
    }
  });

  const ly = y0 + 7 * pitch + 22;
  const step = cell + 3;
  const cellsStart = 776 - 30 - 5 * step + 3;
  out += `<text x="${cellsStart - 6}" y="${ly + cell - 1}" text-anchor="end" font-size="11" fill="${t.muted}">Less</text>\n`;
  t.levels.forEach((c, i) => {
    out += `<rect x="${cellsStart + i * step}" y="${ly}" width="${cell}" height="${cell}" rx="2" fill="${c}"/>\n`;
  });
  out += `<text x="776" y="${ly + cell - 1}" text-anchor="end" font-size="11" fill="${t.muted}">More</text>\n`;
  return `${out}</svg>\n`;
}

function readmeBlock(d, updatedAt) {
  const s = summaries(d);
  const pic = (name, alt) => `<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="${RAW_BASE}/${name}-dark.svg" />
    <img width="800" alt="${esc(alt)}" src="${RAW_BASE}/${name}-light.svg" />
  </picture>
</p>`;
  const parts = [pic('stats', s.stats)];
  if (d.languages.length) parts.push(pic('languages', s.languages));
  parts.push(pic('heatmap', s.heatmap));
  parts.push(`<p align="center"><sub>Last 12 months · today counts toward the streak once it has activity · Source: GitHub, updated ${stamp(updatedAt)}</sub></p>`);
  return `${START_MARK}\n${parts.join('\n\n')}\n${END_MARK}`;
}

// ----------------------------------------------------------------------- main

async function writeAtomic(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, content);
  await rename(tmp, file);
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is not set');
  const force = process.argv.includes('--force');

  const data = await fetchData(token); // throws before any file is touched
  const dataFile = path.join(OUT_DIR, 'data.json');

  const svgNames = ['stats', 'languages', 'heatmap'].filter((n) => n !== 'languages' || data.languages.length);
  const outputsExist = svgNames.every((n) => ['dark', 'light'].every((th) => existsSync(path.join(OUT_DIR, `${n}-${th}.svg`))));
  let previous = null;
  if (existsSync(dataFile)) {
    try {
      previous = JSON.parse(await readFile(dataFile, 'utf8'));
    } catch {
      previous = null;
    }
  }
  if (previous) {
    const { updatedAt: _ignored, ...prevData } = previous;
    if (!force && outputsExist && JSON.stringify(prevData) === JSON.stringify(data)) {
      console.log('No changes in GitHub data; nothing written.');
      return;
    }
  }

  const updatedAt = new Date().toISOString();
  const s = summaries(data);
  const files = [[dataFile, `${JSON.stringify({ updatedAt, ...data })}\n`]];
  for (const th of ['dark', 'light']) {
    const t = THEMES[th];
    files.push([path.join(OUT_DIR, `stats-${th}.svg`), statsSvg(data, t, s)]);
    if (data.languages.length) files.push([path.join(OUT_DIR, `languages-${th}.svg`), languagesSvg(data, t, s)]);
    files.push([path.join(OUT_DIR, `heatmap-${th}.svg`), heatmapSvg(data, t, s)]);
  }

  const readme = await readFile(README_PATH, 'utf8');
  const a = readme.indexOf(START_MARK);
  const b = readme.indexOf(END_MARK);
  if (a === -1 || b === -1 || b < a) throw new Error(`${README_PATH} is missing the github-activity markers`);
  const nextReadme = readme.slice(0, a) + readmeBlock(data, updatedAt) + readme.slice(b + END_MARK.length);

  for (const [file, content] of files) await writeAtomic(file, content);
  if (nextReadme !== readme) await writeAtomic(README_PATH, nextReadme);
  console.log(`Updated ${files.length} files for ${LOGIN}: ${data.totalContributions} contributions, current streak ${data.current.length}, longest ${data.longest.length}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`generate-github-activity: ${e.message}`);
    process.exit(1);
  });
}
