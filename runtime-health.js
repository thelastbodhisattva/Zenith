import path from "node:path";

import {
	readJsonSnapshotWithBackupSync,
	writeJsonSnapshotAtomicSync,
} from "./durable-store.js";

const DATA_DIR = "./data";
const HEALTH_FILE = path.join(DATA_DIR, "runtime-health.json");

function emptyHealth() {
  return {
    updated_at: null,
    startup: null,
    cycles: {
      screening: null,
      management: null,
      health: null,
    },
    provider_health: {},
    recovery: null,
    portfolio_guard: null,
    general_write_arm: null,
    recovery_resume_override: null,
    preflight: null,
  };
}

function loadRuntimeHealth() {
	const snapshot = readJsonSnapshotWithBackupSync(HEALTH_FILE);
	if (!snapshot.value) {
		return {
			...emptyHealth(),
			parse_error: snapshot.error || null,
		};
}
	return {
		...emptyHealth(),
		...snapshot.value,
		loaded_from_backup: snapshot.source === "backup",
	};
}

function saveRuntimeHealth(health) {
	writeJsonSnapshotAtomicSync(HEALTH_FILE, health);
}

export function getRuntimeHealth() {
  return loadRuntimeHealth();
}

export function updateRuntimeHealth(patch = {}) {
  const current = loadRuntimeHealth();
  const next = {
    ...current,
    ...patch,
    cycles: {
      ...current.cycles,
      ...(patch.cycles || {}),
    },
    provider_health: {
      ...current.provider_health,
      ...(patch.provider_health || {}),
    },
    updated_at: new Date().toISOString(),
  };
  saveRuntimeHealth(next);
  return next;
}

export function formatRuntimeHealthReport(health = getRuntimeHealth()) {
  const lines = ["", "Runtime health:", ""];
  lines.push(`  updated_at: ${health.updated_at || "never"}`);
	if (health.startup) {
		lines.push(`  startup: ${health.startup.status}${health.startup.reason ? ` / ${health.startup.reason}` : ""}`);
	}
	if (health.parse_error) {
		lines.push(`  parse_error: ${health.parse_error}`);
	}
	if (health.loaded_from_backup) {
		lines.push("  loaded_from_backup: true");
	}
  for (const [cycleType, cycle] of Object.entries(health.cycles || {})) {
    if (!cycle) continue;
    lines.push(`  ${cycleType}_cycle: ${cycle.status}${cycle.reason ? ` / ${cycle.reason}` : ""}${cycle.at ? ` / ${cycle.at}` : ""}`);
  }
  if (health.recovery) {
    lines.push(`  recovery: ${health.recovery.status}${health.recovery.reason ? ` / ${health.recovery.reason}` : ""}`);
  }
  if (health.portfolio_guard) {
    lines.push(`  portfolio_guard: ${health.portfolio_guard.active ? "active" : "clear"}${health.portfolio_guard.reason ? ` / ${health.portfolio_guard.reason}` : ""}`);
  }
  if (health.general_write_arm) {
    lines.push(`  general_write_arm: ${health.general_write_arm.armed ? "armed" : "disarmed"}${health.general_write_arm.armed_until ? ` / ${health.general_write_arm.armed_until}` : ""}${health.general_write_arm.reason ? ` / ${health.general_write_arm.reason}` : ""}`);
  }
  if (health.recovery_resume_override) {
    lines.push(`  recovery_resume_override: ${health.recovery_resume_override.active ? "active" : "inactive"}${health.recovery_resume_override.override_until ? ` / ${health.recovery_resume_override.override_until}` : ""}${health.recovery_resume_override.source ? ` / ${health.recovery_resume_override.source}` : ""}${health.recovery_resume_override.reason ? ` / ${health.recovery_resume_override.reason}` : ""}`);
  }
  if (health.preflight) {
	lines.push(`  preflight: ${health.preflight.status}${health.preflight.reason ? ` / ${health.preflight.reason}` : ""}${health.preflight.valid_until ? ` / ${health.preflight.valid_until}` : ""}`);
  }

  const providers = Object.entries(health.provider_health || {});
  if (providers.length > 0) {
    lines.push("", "  Providers:");
    for (const [name, provider] of providers) {
      lines.push(`    - ${name}: ${provider.status}${provider.detail ? ` / ${provider.detail}` : ""}${provider.checked_at ? ` / ${provider.checked_at}` : ""}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}
