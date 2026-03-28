export async function renderInteractiveStartup({
  bootRecoveryBlockActive,
  bootRecovery,
  summarizeRecoveryBlock,
  getStartupSnapshot,
  getWalletBalances,
  getMyPositions,
  getTopCandidates,
  isFailClosedResult,
  refreshRuntimeHealth,
  buildProviderHealthFromSnapshot,
  buildStaticProviderHealth,
  secretHealth,
  telegramEnabled,
  formatRangeStatus,
  formatCandidates,
} = {}) {
  console.log(`
╔═══════════════════════════════════════════╗
║         DLMM LP Agent — Ready             ║
╚═══════════════════════════════════════════╝
`);

  console.log("Fetching wallet and top pool candidates...\n");
  if (bootRecoveryBlockActive) {
    const recoveryBlock = summarizeRecoveryBlock(bootRecovery);
    console.log(`RECOVERY BLOCK ACTIVE: ${recoveryBlock.headline}.`);
    console.log(`Autonomous write-capable cycles are suppressed until operator review. ${recoveryBlock.detail}\n`);
  }

  try {
    const startupSnapshot = await getStartupSnapshot({
      force: true,
      getWalletBalances,
      getMyPositions,
      getTopCandidates,
    });
    if (isFailClosedResult(startupSnapshot)) {
      throw new Error(`[${startupSnapshot.reason_code}] ${startupSnapshot.message}`);
    }
    const { wallet, positions, candidates, total_eligible, total_screened } = startupSnapshot;
    refreshRuntimeHealth({
      startup: {
        status: "ready",
        reason: null,
      },
      provider_health: buildProviderHealthFromSnapshot(startupSnapshot, { secretHealth, telegramEnabled }),
    });

    console.log(`Wallet:    ${wallet.sol} SOL  ($${wallet.sol_usd})  |  SOL price: $${wallet.sol_price}`);
    console.log(`Positions: ${positions.total_positions} open\n`);

    if (positions.total_positions > 0) {
      console.log("Open positions:");
      for (const p of positions.positions) {
        const status = formatRangeStatus(p);
        console.log(`  ${p.pair.padEnd(16)} ${status}  fees: $${p.unclaimed_fees_usd}`);
      }
      console.log();
    }

    console.log(`Top pools (${total_eligible} eligible from ${total_screened} screened):\n`);
    console.log(formatCandidates(candidates));
    return candidates;
  } catch (error) {
    console.error(`Startup fetch failed: ${error.message}`);
    refreshRuntimeHealth({
      startup: {
        status: "startup_fetch_failed",
        reason: error.message,
      },
      provider_health: buildStaticProviderHealth({ secretHealth, telegramEnabled }),
    });
    return [];
  }
}

export async function runNonInteractiveStartup({
  bootRecoveryBlockActive,
  bootRecovery,
	summarizeRecoveryBlock,
	log,
	startCronJobs,
	maybeRunMissedBriefing,
	startPolling,
	onTelegramMessage,
} = {}) {
	if (startPolling) {
		startPolling(onTelegramMessage);
	}

  if (bootRecoveryBlockActive) {
    const recoveryBlock = summarizeRecoveryBlock(bootRecovery);
    log("recovery_block", `Non-TTY boot recovery blocked autonomous write-capable startup because ${recoveryBlock.headline}. ${recoveryBlock.detail}`);
    return;
  }

  log("startup", "Non-TTY mode — starting cron cycles immediately.");
  startCronJobs();
  maybeRunMissedBriefing().catch(() => {});
  log("startup", "Non-TTY autonomous startup deploy path disabled; cron-only startup in effect.");
}

export function formatInteractiveHelp(deployAmountSol) {
  return `
Commands:
  1 / 2 / 3 ...  Deploy ${deployAmountSol} SOL into that pool
  auto           Let the agent pick and deploy automatically
  /status        Refresh wallet + positions
  /candidates    Refresh top pool list
  /candidate <n> Inspect one ranked candidate with richer signals
  /health        Show heartbeat, provider health, and ops state
  /preflight     Run explicit risk-opening preflight and persist the latest result
  /evaluation    Show recent cycle/tool evaluation summary
  /failures      Show recent persisted bad-cycle evidence bundles
  /failure <id>  Show one evidence bundle in detail
  /recovery      Show unresolved/manual-review recovery workflows
  /journal       Show recent action-journal entries
  /replay <id>   Show one replay envelope
  /reconcile <id> Run replay reconciliation for one cycle
  /review        Show replay-backed review stats
  /resume <why>  Persist a bounded restart-aware override for the current unresolved-workflow incident
  /arm [min] [why]  Temporarily arm GENERAL free-form write tools
  /disarm        Remove GENERAL free-form write access
  /performance   Show recent closed-position performance history
  /proof         Show bounded strategy proof summary from realized closes
  /briefing      Show morning briefing (last 24h)
  /learn         Study top LPers from the best current pool and save lessons
  /learn <addr>  Study top LPers from a specific pool address
  /thresholds    Show current screening thresholds + performance stats
  /evolve        Manually trigger threshold evolution from performance data
  /stop          Shut down
`;
}
