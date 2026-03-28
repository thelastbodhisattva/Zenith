import fs from "node:fs";
import path from "node:path";

import { appendJsonlRecordSync } from "./durable-store.js";

const TRACE_DIR = "./logs";

export function createCycleId(cycleType) {
  return `${cycleType}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createActionId(cycleId, toolName, index = 0) {
  return `${cycleId}:${toolName}:${index + 1}`;
}

export function appendReplayEnvelope(envelope) {
	const timestamp = new Date().toISOString();
	const dateStr = timestamp.split("T")[0];
	const file = path.join(TRACE_DIR, `replay-${dateStr}.jsonl`);
	appendJsonlRecordSync(file, { timestamp, ...envelope });
}

export function readReplayEnvelopeReport() {
	if (!fs.existsSync(TRACE_DIR)) return { envelopes: [], parse_errors: [] };
	const files = fs.readdirSync(TRACE_DIR)
		.filter((file) => /^replay-.*\.jsonl$/.test(file))
		.sort();
	const envelopes = [];
	const parse_errors = [];

	for (const file of files) {
		const fullPath = path.join(TRACE_DIR, file);
		const lines = fs.readFileSync(fullPath, "utf8").split(/\r?\n/).filter(Boolean);
		for (let index = 0; index < lines.length; index += 1) {
			try {
				envelopes.push(JSON.parse(lines[index]));
			} catch (error) {
				parse_errors.push({
					file,
					line: index + 1,
					error: error.message,
				});
			}
		}
	}

	return { envelopes, parse_errors };
}

export function readReplayEnvelopes() {
	const report = readReplayEnvelopeReport();
	if (report.parse_errors.length > 0) {
		const first = report.parse_errors[0];
		throw new Error(`Invalid replay envelope in ${first.file}:${first.line}: ${first.error}`);
	}
	return report.envelopes;
}

export function getReplayEnvelope(cycleId) {
	return readReplayEnvelopeReport().envelopes.find((envelope) => envelope.cycle_id === cycleId) || null;
}
