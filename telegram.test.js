import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("telegram polling stays disabled without a configured chat id", async () => {
	const originalCwd = process.cwd();
	const originalToken = process.env.TELEGRAM_BOT_TOKEN;
	const originalChatId = process.env.TELEGRAM_CHAT_ID;
	const originalConfigPath = process.env.ZENITH_USER_CONFIG_PATH;
	const originalFetch = global.fetch;
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-telegram-test-"));
	let fetchCalled = false;

	try {
		process.chdir(tempDir);
		delete process.env.TELEGRAM_CHAT_ID;
		process.env.TELEGRAM_BOT_TOKEN = "test-telegram-token";
		process.env.ZENITH_USER_CONFIG_PATH = path.join(tempDir, "user-config.json");
		global.fetch = async () => {
			fetchCalled = true;
			throw new Error("fetch should not run when chat id is missing");
		};

		const telegram = await import(`./telegram.js?test=${Date.now()}`);
		assert.equal(telegram.isEnabled(), false);
		telegram.startPolling(() => {});
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(fetchCalled, false);
		telegram.stopPolling();
	} finally {
		process.chdir(originalCwd);
		if (originalToken == null) delete process.env.TELEGRAM_BOT_TOKEN;
		else process.env.TELEGRAM_BOT_TOKEN = originalToken;
		if (originalChatId == null) delete process.env.TELEGRAM_CHAT_ID;
		else process.env.TELEGRAM_CHAT_ID = originalChatId;
		if (originalConfigPath == null) delete process.env.ZENITH_USER_CONFIG_PATH;
		else process.env.ZENITH_USER_CONFIG_PATH = originalConfigPath;
		global.fetch = originalFetch;
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});
