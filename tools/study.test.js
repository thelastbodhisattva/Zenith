import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { getPoolInfo, scoreTopLPers, studyTopLPers } from "./study.js";

test("scoreTopLPers returns bounded disabled payload when LPAgent is unavailable", async () => {
  const originalKey = process.env.LPAGENT_API_KEY;

  try {
    delete process.env.LPAGENT_API_KEY;
    const result = await scoreTopLPers({ pool_address: "pool-chaos", limit: 3 });

    assert.equal(result.candidates.length, 0);
    assert.equal(result.source_status.lpagent.enabled, false);
    assert.equal(result.source_status.lpagent.status, "missing_api_key");
    assert.match(result.message, /disabled/i);
  } finally {
    if (originalKey == null) {
      delete process.env.LPAGENT_API_KEY;
    } else {
      process.env.LPAGENT_API_KEY = originalKey;
    }
  }
});

test("studyTopLPers returns bounded disabled payload when LPAgent is unavailable", async () => {
  const originalKey = process.env.LPAGENT_API_KEY;

  try {
    delete process.env.LPAGENT_API_KEY;
    const result = await studyTopLPers({ pool_address: "pool-chaos", limit: 2 });

    assert.equal(result.pool, "pool-chaos");
    assert.deepEqual(result.patterns, []);
    assert.deepEqual(result.lpers, []);
    assert.match(result.message, /disabled/i);
  } finally {
    if (originalKey == null) {
      delete process.env.LPAGENT_API_KEY;
    } else {
      process.env.LPAGENT_API_KEY = originalKey;
    }
	}
});

test("getPoolInfo stays read-only and does not create memory side effects", async () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-study-readonly-test-"));
	const originalKey = process.env.LPAGENT_API_KEY;
	const originalDir = process.env.ZENITH_MEMORY_DIR;
	const originalFetch = global.fetch;

	try {
		process.env.LPAGENT_API_KEY = "test-lpagent-key";
		process.env.ZENITH_MEMORY_DIR = path.join(tempDir, "memory");
		global.fetch = async () => ({
			ok: true,
			json: async () => ({
				data: {
					type: "dlmm",
					tokenInfo: [{ data: [{ symbol: "AAA", audit: {}, organicScore: 80, holderCount: 1000 }, { symbol: "SOL" }] }],
					feeInfo: {},
					feeStats: [],
				},
			}),
		});

		const result = await getPoolInfo({ pool_address: "pool-readonly" });
		assert.equal(result.pool, "pool-readonly");
		assert.equal(fs.existsSync(process.env.ZENITH_MEMORY_DIR), false);
	} finally {
		if (originalKey == null) delete process.env.LPAGENT_API_KEY;
		else process.env.LPAGENT_API_KEY = originalKey;
		if (originalDir == null) delete process.env.ZENITH_MEMORY_DIR;
		else process.env.ZENITH_MEMORY_DIR = originalDir;
		global.fetch = originalFetch;
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});
