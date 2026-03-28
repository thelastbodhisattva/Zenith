import { formatRecoveryWorkflowReport } from "./boot-recovery.js";
import { listOperatorActions } from "./operator-controls.js";
import { formatPortfolioGuardReport, getPortfolioGuardStatus } from "./portfolio-guards.js";
import { formatRuntimeHealthReport } from "./runtime-health.js";

export function buildStaticProviderHealth({ secretHealth, telegramEnabled }) {
  return {
    wallet_secret: {
      status: secretHealth.wallet_key_source === "missing" ? "missing" : "ok",
      detail: secretHealth.wallet_key_source,
      checked_at: new Date().toISOString(),
    },
    rpc: {
      status: process.env.RPC_URL ? "configured" : "missing",
      detail: process.env.RPC_URL ? "RPC_URL present" : "RPC_URL missing",
      checked_at: new Date().toISOString(),
    },
    llm: {
      status: process.env.OPENROUTER_API_KEY || process.env.LLM_API_KEY ? "configured" : "missing",
      detail: process.env.OPENROUTER_API_KEY ? "OPENROUTER_API_KEY present" : process.env.LLM_API_KEY ? "LLM_API_KEY present" : "no model auth configured",
      checked_at: new Date().toISOString(),
    },
    telegram: {
      status: telegramEnabled() ? "configured" : "disabled",
      detail: telegramEnabled() ? "TELEGRAM_BOT_TOKEN present" : "telegram disabled",
      checked_at: new Date().toISOString(),
    },
    lpagent: {
      status: process.env.LPAGENT_API_KEY ? "configured" : "optional_missing",
      detail: process.env.LPAGENT_API_KEY ? "LPAGENT_API_KEY present" : "LP Agent disabled",
      checked_at: new Date().toISOString(),
    },
  };
}

export function buildProviderHealthFromSnapshot(snapshot, { secretHealth, telegramEnabled }) {
  return {
    ...buildStaticProviderHealth({ secretHealth, telegramEnabled }),
    wallet: {
      status: snapshot?.wallet?.error ? "degraded" : "ok",
      detail: snapshot?.wallet?.error || `wallet ${snapshot?.wallet?.wallet || "available"}`,
      checked_at: new Date().toISOString(),
    },
    positions: {
      status: snapshot?.positions?.error ? "degraded" : "ok",
      detail: snapshot?.positions?.error || `${snapshot?.positions?.total_positions ?? 0} open positions`,
      checked_at: new Date().toISOString(),
    },
    candidates: {
      status: snapshot?.error ? "degraded" : "ok",
      detail: snapshot?.error || `${snapshot?.total_eligible ?? snapshot?.candidates?.length ?? 0} eligible candidates`,
      checked_at: new Date().toISOString(),
    },
  };
}

export function createRuntimeHealthRefresher({
  updateRuntimeHealth,
  getAutonomousWriteSuppression,
  getRecoveryWorkflowReport,
  getOperatorControlSnapshot,
} = {}) {
  return function refreshRuntimeHealth(overrides = {}) {
    const suppression = getAutonomousWriteSuppression();
    const recoveryReport = getRecoveryWorkflowReport({ limit: 5 });
    const portfolioGuard = getPortfolioGuardStatus();
    const operatorControls = getOperatorControlSnapshot();
    return updateRuntimeHealth({
      recovery: {
        status: recoveryReport.status,
        reason: suppression.reason || null,
        suppressed: suppression.suppressed,
      },
      portfolio_guard: {
        active: portfolioGuard.active,
        reason_code: portfolioGuard.reason_code,
        reason: portfolioGuard.reason,
        pause_until: portfolioGuard.pause_until,
      },
      general_write_arm: operatorControls.general_write_arm,
      recovery_resume_override: operatorControls.recovery_resume_override,
      ...overrides,
    });
  };
}

export function formatRecoveryReport(report, suppression) {
  return formatRecoveryWorkflowReport(report, suppression);
}

export function formatActionJournalReport(listActionJournalEntries, limit = 10) {
  const lines = ["", "Action journal:", ""];
  const entries = listActionJournalEntries(limit);
  if (entries.length === 0) {
    lines.push("  No action journal entries recorded.");
    lines.push("");
    return lines.join("\n");
  }

  for (const entry of entries) {
    lines.push(`  - ${entry.ts}: ${entry.tool} / ${entry.lifecycle} / ${entry.workflow_id}${entry.reason ? ` / ${entry.reason}` : ""}`);
  }
  lines.push("");
  return lines.join("\n");
}

export function formatEvidenceBundle(bundle) {
  if (!bundle) return "\nEvidence bundle not found.\n";
  const lines = ["", "Evidence bundle:", ""];
  if (bundle.runbook_slug) lines.push(`  runbook_slug: ${bundle.runbook_slug}`);
  if (bundle.incident_key) lines.push(`  incident_key: ${bundle.incident_key}`);
  for (const [key, value] of Object.entries(bundle)) {
		if (key === "runbook_slug" || key === "incident_key") continue;
    lines.push(`  ${key}: ${typeof value === "object" ? JSON.stringify(value) : value}`);
  }
  lines.push("");
  return lines.join("\n");
}

export function formatReplayEnvelope(envelope) {
  if (!envelope) return "\nReplay envelope not found.\n";
  const lines = ["", "Replay envelope:", ""];
  lines.push(`  cycle_id: ${envelope.cycle_id}`);
  lines.push(`  cycle_type: ${envelope.cycle_type}`);
  if (envelope.reason_code) lines.push(`  reason_code: ${envelope.reason_code}`);
  if (Array.isArray(envelope.shortlist)) lines.push(`  shortlist: ${envelope.shortlist.length}`);
  if (Array.isArray(envelope.runtime_actions)) lines.push(`  runtime_actions: ${envelope.runtime_actions.length}`);
  lines.push(`  raw: ${JSON.stringify(envelope).slice(0, 1200)}`);
  lines.push("");
  return lines.join("\n");
}

export async function buildOperationalHealthReport({
  getStartupSnapshot,
  getWalletBalances,
  getMyPositions,
  getTopCandidates,
  isFailClosedResult,
  buildStaticProviderHealth,
  buildProviderHealthFromSnapshot,
  refreshRuntimeHealth,
  getOperatorControlSnapshot,
  secretHealth,
  telegramEnabled,
} = {}) {
  const snapshot = await getStartupSnapshot({
    force: true,
    getWalletBalances,
    getMyPositions,
    getTopCandidates,
  });

  const health = refreshRuntimeHealth(
    isFailClosedResult(snapshot)
      ? {
          startup: {
            status: "fail_closed",
            reason: `[${snapshot.reason_code}] ${snapshot.message}`,
          },
          provider_health: {
            ...buildStaticProviderHealth({ secretHealth, telegramEnabled }),
            startup_snapshot: {
              status: "fail_closed",
              detail: `[${snapshot.reason_code}] ${snapshot.message}`,
              checked_at: new Date().toISOString(),
            },
          },
        }
      : {
          startup: {
            status: "ready",
            reason: null,
          },
          provider_health: buildProviderHealthFromSnapshot(snapshot, { secretHealth, telegramEnabled }),
        }
  );

  const operatorControls = getOperatorControlSnapshot ? getOperatorControlSnapshot({ recentActionLimit: 3 }) : null;
  const actionLines = (operatorControls?.recent_actions || listOperatorActions(3))
    .map((entry) => `  - ${entry.ts}: ${entry.type}${entry.reason ? ` / ${entry.reason}` : ""}`);

  return [
    formatRuntimeHealthReport(health).trimEnd(),
    formatPortfolioGuardReport(getPortfolioGuardStatus()).trimEnd(),
    actionLines.length > 0 ? ["", "Recent operator actions:", ...actionLines, ""].join("\n") : "",
  ].filter(Boolean).join("\n");
}

export function createHeadlessTelegramCommandHandler({
	handleOperatorCommandText,
	buildOperationalHealthReport,
	getRecoveryWorkflowReport,
	getAutonomousWriteSuppression,
	formatRecoveryReport,
	sendMessage,
} = {}) {
	return async function onTelegramMessage(text) {
		if (text === "/health") {
			await sendMessage(await buildOperationalHealthReport()).catch(() => {});
			return;
		}
		if (text === "/recovery") {
			await sendMessage(formatRecoveryReport(
				getRecoveryWorkflowReport({ limit: 5 }),
				getAutonomousWriteSuppression(),
			)).catch(() => {});
			return;
		}

		const operatorCommand = await handleOperatorCommandText({ text, source: "telegram" });
		if (!operatorCommand?.handled) {
			await sendMessage("Headless mode only accepts /health, /recovery, and operator commands over Telegram.").catch(() => {});
			return;
		}
		if (operatorCommand.message) {
			await sendMessage(operatorCommand.message).catch(() => {});
		}
	};
}
