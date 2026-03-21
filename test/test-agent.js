/**
 * Test the full agent loop in dry-run mode (no wallet needed for screening).
 * Run: node test/test-agent.js
 */

import "dotenv/config";

// Keep this test path Windows-safe by setting env vars in-process.
process.env.DRY_RUN = "true";

function isMissingAuthError(err) {
  const msg = (err?.message ?? String(err ?? "")).toLowerCase();
  return (
    msg.includes("missing authentication") ||
    msg.includes("missing authentication header") ||
    msg.includes("authentication header")
  );
}

async function main() {
  console.log("=== Testing Agent Loop (DRY RUN) ===\n");
  console.log("Goal: Discover top pools and recommend 3 LP opportunities\n");

  const openRouterKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!openRouterKey) {
    console.log(
      "SKIP: OPENROUTER_API_KEY is not set; skipping agent smoke test (DRY_RUN remains enabled)."
    );
    console.log(
      "Tip: add OPENROUTER_API_KEY to .env to run the full agent loop test."
    );
    return;
  }

  const { agentLoop } = await import("../agent.js");

  let result;
  try {
    result = await agentLoop(
      "Run get_top_candidates. Then deploy_position into the #1 candidate using 0.1 SOL. Report what was deployed.",
      5
    );
  } catch (err) {
    // If auth is misconfigured at runtime, degrade to a clean skip instead of a stacktrace.
    if (isMissingAuthError(err)) {
      console.log(
        "SKIP: Model authentication is unavailable/misconfigured; skipping agent smoke test."
      );
      console.log(String(err?.message ?? err));
      return;
    }
    throw err;
  }

  console.log("\n=== Agent Response ===");
  console.log(result);
  console.log("\n=== Test complete ===");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
