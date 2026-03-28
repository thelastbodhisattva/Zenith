import fs from "node:fs";
import path from "node:path";

import {
	readJsonSnapshotWithBackupSync,
	writeJsonSnapshotAtomicSync,
} from "./durable-store.js";
import { resolveRunbookSlug } from "./runbooks.js";

const EVIDENCE_DIR = "./logs/evidence";

function listEvidenceBaseFiles() {
	if (!fs.existsSync(EVIDENCE_DIR)) return [];
	return Array.from(
		new Set(
			fs.readdirSync(EVIDENCE_DIR)
				.filter((file) => file.endsWith(".json") || file.endsWith(".json.bak"))
				.map((file) => file.endsWith(".bak") ? file.slice(0, -4) : file),
		),
	).sort((a, b) => b.localeCompare(a));
}

export function writeEvidenceBundle(bundle) {
  if (!bundle?.cycle_id) return null;
  if (!fs.existsSync(EVIDENCE_DIR)) {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  }
  const safeCycleId = String(bundle.cycle_id).replace(/[^a-zA-Z0-9_-]/g, "_");
  const filePath = path.join(EVIDENCE_DIR, `${safeCycleId}.json`);
  writeJsonSnapshotAtomicSync(filePath, {
		...bundle,
		incident_key: bundle.incident_key || bundle.cycle_id,
		runbook_slug: resolveRunbookSlug(bundle),
	});
  return filePath;
}

export function listEvidenceBundles(limit = 5) {
	const bundles = [];
	for (const file of listEvidenceBaseFiles().slice(0, limit * 2)) {
		const fullPath = path.join(EVIDENCE_DIR, file);
		const snapshot = readJsonSnapshotWithBackupSync(fullPath);
		if (!snapshot.value) continue;
		bundles.push({
			file,
			cycle_id: snapshot.value.cycle_id,
			incident_key: snapshot.value.incident_key || null,
			cycle_type: snapshot.value.cycle_type,
			status: snapshot.value.status,
			reason_code: snapshot.value.reason_code || null,
			runbook_slug: snapshot.value.runbook_slug || null,
			error: snapshot.value.error || null,
			written_at: snapshot.value.written_at || null,
		});
		if (bundles.length >= limit) break;
	}
	return bundles;
}

export function getEvidenceBundle(identifier) {
	if (!identifier || !fs.existsSync(EVIDENCE_DIR)) return null;
	const fileName = String(identifier).endsWith(".json") ? String(identifier) : `${String(identifier)}.json`;
	const directPath = path.join(EVIDENCE_DIR, fileName);
	if (fs.existsSync(directPath) || fs.existsSync(`${directPath}.bak`)) {
		return readJsonSnapshotWithBackupSync(directPath).value;
	}

	const matches = listEvidenceBaseFiles().filter((file) => file.includes(String(identifier)));
	if (matches.length === 0) return null;
	return readJsonSnapshotWithBackupSync(path.join(EVIDENCE_DIR, matches[0])).value;
}
