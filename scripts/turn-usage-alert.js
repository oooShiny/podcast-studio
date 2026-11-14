#!/usr/bin/env node
// Checks Cloudflare Realtime TURN usage and alerts when it crosses a monthly
// budget threshold or spikes in the last 24h. Meant to run on a schedule
// (cron, GitHub Actions, etc.) — e.g. every 30 minutes:
//
//   */30 * * * * cd /path/to/podcast-studio && node scripts/turn-usage-alert.js
//
// TURN billing is on egress bytes (relay -> client), $0.05/GB after a shared
// 1,000 GB/month free tier. Usage appears in analytics within ~30 seconds.
//
// Env:
//   CLOUDFLARE_ACCOUNT_ID    required — your account tag
//   CLOUDFLARE_API_TOKEN     required — token with Account Analytics: Read
//   TURN_MONTHLY_BUDGET_GB   default 1000 (the free tier) — thresholds are % of this
//   TURN_ALERT_PERCENTS      default "50,80,100" — alert once per level per month
//   TURN_DAILY_ALERT_GB      default 100 — alert if the last 24h exceeds this
//   ALERT_WEBHOOK_URL        optional — Slack/Discord-style incoming webhook. Without
//                            one, alerts go to stderr and the exit code is 1, so cron
//                            mail or a failing CI job still tells you.
//   TURN_ALERT_STATE_FILE    default ~/.podcast-studio-turn-alert.json — remembers which
//                            levels already fired so you aren't re-alerted every run
//
// Exit codes: 0 = nothing to report, 1 = alert(s) fired, 2 = couldn't check usage.
// Same .env the server reads, so one file holds all the credentials.
require("dotenv").config({ quiet: true });
const fs = require("fs");
const os = require("os");
const path = require("path");

const GB = 1024 ** 3; // Cloudflare's docs say "GB"; the binary/decimal gap is ~7%, so treat figures as approximate
const FREE_GB = 1000;
const PRICE_PER_GB = 0.05;

function config(env = process.env) {
  return {
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: env.CLOUDFLARE_API_TOKEN,
    budgetGb: Number(env.TURN_MONTHLY_BUDGET_GB) || FREE_GB,
    percents: (env.TURN_ALERT_PERCENTS || "50,80,100").split(",").map(Number).filter((n) => n > 0).sort((a, b) => a - b),
    dailyGb: Number(env.TURN_DAILY_ALERT_GB) || 100,
    webhook: env.ALERT_WEBHOOK_URL || "",
    stateFile: env.TURN_ALERT_STATE_FILE || path.join(os.homedir(), ".podcast-studio-turn-alert.json"),
    graphqlUrl: env.CLOUDFLARE_GRAPHQL_URL || "https://api.cloudflare.com/client/v4/graphql",
  };
}

// One un-grouped query per window. Cloudflare recommends a single summed value
// rather than listing many groups, since adaptive sampling can skew those.
async function egressGb(cfg, fromIso, toIso) {
  const query = `query { viewer { accounts(filter: { accountTag: "${cfg.accountId}" }) {
    callsTurnUsageAdaptiveGroups(filter: { datetimeMinute_gt: "${fromIso}", datetimeMinute_lt: "${toIso}" }, limit: 1) {
      sum { egressBytes }
    } } } }`;
  const res = await fetch(cfg.graphqlUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.apiToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Cloudflare GraphQL responded ${res.status}`);
  const body = await res.json();
  if (body.errors && body.errors.length) throw new Error(`GraphQL error: ${body.errors[0].message}`);
  const account = body.data && body.data.viewer && body.data.viewer.accounts && body.data.viewer.accounts[0];
  if (!account) throw new Error("No account in response — check CLOUDFLARE_ACCOUNT_ID and token permissions");
  const groups = account.callsTurnUsageAdaptiveGroups || [];
  const bytes = groups.reduce((sum, g) => sum + ((g.sum && g.sum.egressBytes) || 0), 0);
  return bytes / GB; // no rows = no usage yet
}

// Pure: decides which alerts to raise and the state to remember. `state` is
// { month, firedPercents: [...], dailyFiredOn }.
function evaluate({ monthGb, dayGb, now, state, cfg }) {
  const month = now.toISOString().slice(0, 7);
  const next = state && state.month === month ? { ...state } : { month, firedPercents: [], dailyFiredOn: null };
  next.firedPercents = next.firedPercents || [];
  const alerts = [];
  const cost = Math.max(0, monthGb - FREE_GB) * PRICE_PER_GB;
  const pct = (monthGb / cfg.budgetGb) * 100;

  // Only announce the highest newly-crossed level, so a jump from 40% to 120%
  // sends one message instead of three.
  const crossed = cfg.percents.filter((p) => pct >= p && !next.firedPercents.includes(p));
  if (crossed.length) {
    next.firedPercents.push(...crossed);
    const top = crossed[crossed.length - 1];
    alerts.push(
      `TURN usage is at ${pct.toFixed(0)}% of the ${cfg.budgetGb} GB monthly budget (crossed ${top}%): ` +
      `${monthGb.toFixed(1)} GB this month, about $${cost.toFixed(2)} billed so far.`
    );
  }

  // Spike alert, at most once per UTC day.
  const today = now.toISOString().slice(0, 10);
  if (dayGb >= cfg.dailyGb && next.dailyFiredOn !== today) {
    next.dailyFiredOn = today;
    alerts.push(`TURN usage spike: ${dayGb.toFixed(1)} GB in the last 24h (threshold ${cfg.dailyGb} GB). Possible credential abuse or a video-heavy surge.`);
  }
  return { alerts, state: next };
}

function loadState(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

async function notify(cfg, text) {
  console.error(`[turn-alert] ${text}`);
  if (!cfg.webhook) return;
  // `text` is Slack's field, `content` is Discord's; each ignores the other.
  const res = await fetch(cfg.webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, content: text }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) console.error(`[turn-alert] webhook responded ${res.status}`);
}

async function main() {
  const cfg = config();
  if (!cfg.accountId || !cfg.apiToken) {
    console.error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (Account Analytics: Read).");
    return 2;
  }
  if (!/^[0-9a-f]{32}$/i.test(cfg.accountId)) {
    console.error("CLOUDFLARE_ACCOUNT_ID should be the 32-character account tag.");
    return 2;
  }

  const now = new Date();
  // Assumes the free tier resets on the calendar (UTC) month — confirm against your invoice.
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const dayStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  let monthGb, dayGb;
  try {
    monthGb = await egressGb(cfg, monthStart.toISOString(), now.toISOString());
    dayGb = await egressGb(cfg, dayStart.toISOString(), now.toISOString());
  } catch (e) {
    // A silent monitor is worse than none, so a failed check is itself an alert.
    await notify(cfg, `TURN usage check failed: ${e.message}`).catch(() => {});
    return 2;
  }

  const { alerts, state } = evaluate({ monthGb, dayGb, now, state: loadState(cfg.stateFile), cfg });
  console.log(`TURN usage: ${monthGb.toFixed(1)} GB this month, ${dayGb.toFixed(1)} GB in the last 24h`);
  for (const a of alerts) await notify(cfg, a);
  try { fs.writeFileSync(cfg.stateFile, JSON.stringify(state)); } catch (e) { console.error("could not save state:", e.message); }
  return alerts.length ? 1 : 0;
}

module.exports = { evaluate, egressGb, config };

if (require.main === module) main().then((code) => process.exit(code));
