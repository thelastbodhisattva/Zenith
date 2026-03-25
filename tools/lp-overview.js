import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { log } from "../logger.js";

const LPAGENT_API = "https://api.lpagent.io/open-api/v1";
const CACHE_TTL_MS = 5 * 60 * 1000;

let cachedOverview = null;
let cachedAt = 0;
let keyIndex = 0;

function getApiKey() {
  const keys = (process.env.LPAGENT_API_KEY || "")
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);

  if (keys.length === 0) return null;
  const key = keys[keyIndex % keys.length];
  keyIndex += 1;
  return key;
}

function getWalletAddress() {
  if (!process.env.WALLET_PRIVATE_KEY) return null;
  return Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY)).publicKey.toString();
}

export async function getLpOverview({ force = false } = {}) {
  if (!force && cachedOverview && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cachedOverview;
  }

  const apiKey = getApiKey();
  const owner = getWalletAddress();
  if (!apiKey || !owner) return cachedOverview || null;

  try {
    const res = await fetch(`${LPAGENT_API}/lp-positions/overview?owner=${owner}&protocol=meteora`, {
      headers: { "x-api-key": apiKey },
    });

    if (!res.ok) {
      log("lp_overview", `API error: ${res.status}`);
      return cachedOverview || null;
    }

    const json = await res.json();
    const row = (json.data || [])[0];
    if (!row) return cachedOverview || null;

    cachedOverview = {
      total_pnl_usd: round2(row.total_pnl?.ALL),
      total_pnl_sol: round4(row.total_pnl_native?.ALL),
      total_fees_usd: round2(row.total_fee?.ALL),
      total_fees_sol: round4(row.total_fee_native?.ALL),
      win_rate_pct: Math.round((row.win_rate?.ALL || 0) * 100),
      closed_positions: row.closed_lp?.ALL || 0,
      open_positions: row.opening_lp || 0,
      total_positions: row.total_lp || 0,
      total_pools: row.total_pool || 0,
      avg_hold_hours: round2(row.avg_age_hour),
      roi_pct: round2((row.roi || 0) * 100),
      updated_at: row.updated_at,
    };
    cachedAt = Date.now();
    return cachedOverview;
  } catch (error) {
    log("lp_overview", `Fetch failed: ${error.message}`);
    return cachedOverview || null;
  }
}

export async function getLpOverviewSummary() {
  const overview = await getLpOverview();
  if (!overview) return null;

  return `LP Performance (${overview.closed_positions} closed, ${overview.open_positions} open): PnL $${overview.total_pnl_usd} | Fees $${overview.total_fees_usd} | Win rate ${overview.win_rate_pct}% | Avg hold ${overview.avg_hold_hours}h | ROI ${overview.roi_pct}%`;
}

function round2(value) {
  return value != null ? Math.round(value * 100) / 100 : 0;
}

function round4(value) {
  return value != null ? Math.round(value * 10000) / 10000 : 0;
}
