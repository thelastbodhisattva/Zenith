import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { foldActionJournal, readActionJournal, setActionJournalPathForTests } from "./action-journal.js";
import {
  executeTool,
  resetExecutorTestOverrides,
  setAutonomousWriteSuppression,
  setExecutorTestOverrides,
} from "./tools/executor.js";

test("executor journals intent and completion for write tools", async () => {
  const originalCwd = process.cwd();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-executor-lifecycle-test-"));
  const journalPath = path.join(tempDir, "data", "workflow-actions.jsonl");

  try {
    process.chdir(tempDir);
    fs.mkdirSync(path.join(tempDir, "logs"), { recursive: true });
    setActionJournalPathForTests(journalPath);
    setAutonomousWriteSuppression({ suppressed: false });

    let receivedArgs = null;
    setExecutorTestOverrides({
      getMyPositions: async () => ({ total_positions: 0, positions: [] }),
      getWalletBalances: async () => ({ sol: 10, sol_price: 100, tokens: [] }),
      tools: {
        deploy_position: async (args) => {
          receivedArgs = args;
          return { success: true, position: "pos-1", pool: "pool-1" };
        },
      },
      recordToolOutcome: () => {},
    });

    const result = await executeTool(
      "deploy_position",
      { pool_address: "pool-1", amount_y: 0.5, base_mint: "mint-1", bin_step: 100 },
      { cycle_id: "cycle-1", action_id: "cycle-1:deploy_position:1" }
    );

    assert.equal(result.success, true);

    const journal = readActionJournal();
    assert.equal(journal.parse_errors.length, 0);
    assert.equal(journal.entries.length, 2);
    assert.equal(journal.entries[0].lifecycle, "intent");
    assert.equal(journal.entries[1].lifecycle, "completed");
    assert.equal(journal.entries[0].workflow_id, "cycle-1:deploy_position:1");
    assert.equal(journal.entries[1].workflow_id, "cycle-1:deploy_position:1");
    assert.equal(receivedArgs.decision_context.cycle_id, "cycle-1");
    assert.equal(receivedArgs.decision_context.action_id, "cycle-1:deploy_position:1");
    assert.equal(receivedArgs.decision_context.workflow_id, "cycle-1:deploy_position:1");

    const folded = foldActionJournal(journal.entries);
    assert.equal(folded.length, 1);
    assert.equal(folded[0].lifecycle, "completed");
  } finally {
    resetExecutorTestOverrides();
    setAutonomousWriteSuppression({ suppressed: false });
    setActionJournalPathForTests(null);
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("executor writes terminal manual_review for blocked write attempts", async () => {
  const originalCwd = process.cwd();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-executor-blocked-lifecycle-test-"));
  const journalPath = path.join(tempDir, "data", "workflow-actions.jsonl");

  try {
    process.chdir(tempDir);
    fs.mkdirSync(path.join(tempDir, "logs"), { recursive: true });
    setActionJournalPathForTests(journalPath);
    setAutonomousWriteSuppression({ suppressed: false });

    setExecutorTestOverrides({
      getMyPositions: async () => ({
        total_positions: 1,
        positions: [{ position: "already-open", pool: "pool-block", base_mint: "mint-b" }],
      }),
      getWalletBalances: async () => ({ sol: 10, sol_price: 100, tokens: [] }),
      recordToolOutcome: () => {},
    });

    const result = await executeTool(
      "deploy_position",
      { pool_address: "pool-block", amount_y: 0.5, base_mint: "mint-b", bin_step: 100 },
      { cycle_id: "cycle-b", action_id: "cycle-b:deploy_position:1" }
    );

    assert.equal(result.blocked, true);

    const journal = readActionJournal();
    assert.equal(journal.parse_errors.length, 0);
    assert.equal(journal.entries.length, 2);
    assert.equal(journal.entries[0].lifecycle, "intent");
    assert.equal(journal.entries[1].lifecycle, "manual_review");

    const folded = foldActionJournal(journal.entries);
    assert.equal(folded[0].lifecycle, "manual_review");
  } finally {
    resetExecutorTestOverrides();
    setAutonomousWriteSuppression({ suppressed: false });
    setActionJournalPathForTests(null);
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("executor writes terminal manual_review for errored write attempts", async () => {
  const originalCwd = process.cwd();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-executor-error-lifecycle-test-"));
  const journalPath = path.join(tempDir, "data", "workflow-actions.jsonl");

  try {
    process.chdir(tempDir);
    fs.mkdirSync(path.join(tempDir, "logs"), { recursive: true });
    setActionJournalPathForTests(journalPath);
    setAutonomousWriteSuppression({ suppressed: false });

    setExecutorTestOverrides({
      getMyPositions: async () => ({ total_positions: 0, positions: [] }),
      getWalletBalances: async () => ({ sol: 10, sol_price: 100, tokens: [] }),
      tools: {
        deploy_position: async () => {
          throw new Error("simulated deploy failure");
        },
      },
      recordToolOutcome: () => {},
    });

    const result = await executeTool(
      "deploy_position",
      { pool_address: "pool-err", amount_y: 0.5, base_mint: "mint-err", bin_step: 100 },
      { cycle_id: "cycle-e", action_id: "cycle-e:deploy_position:1" }
    );

    assert.match(result.error || "", /simulated deploy failure/i);

    const journal = readActionJournal();
    assert.equal(journal.parse_errors.length, 0);
    assert.equal(journal.entries.length, 2);
    assert.equal(journal.entries[0].lifecycle, "intent");
    assert.equal(journal.entries[1].lifecycle, "manual_review");

    const folded = foldActionJournal(journal.entries);
    assert.equal(folded[0].lifecycle, "manual_review");
  } finally {
    resetExecutorTestOverrides();
    setAutonomousWriteSuppression({ suppressed: false });
    setActionJournalPathForTests(null);
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
