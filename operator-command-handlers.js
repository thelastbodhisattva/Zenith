function parseArmScopeOptions(parts = []) {
	const scope = {};
	const reasonParts = [];
	for (const part of parts) {
		if (!part) continue;
		if (part === "once") {
			scope.one_shot = true;
			continue;
		}
		const [key, ...valueParts] = part.split("=");
		if (!valueParts.length) {
			reasonParts.push(part);
			continue;
		}
		const value = valueParts.join("=");
		if (key === "tool" || key === "tools") {
			scope.allowed_tools = value.split(",").map((tool) => tool.trim()).filter(Boolean);
			continue;
		}
		if (key === "pool") {
			scope.pool_address = value;
			continue;
		}
		if (key === "position") {
			scope.position_address = value;
			continue;
		}
		if (key === "max_sol" || key === "amount_sol") {
			scope.max_amount_sol = Number(value);
			continue;
		}
		if (key === "one_shot") {
			scope.one_shot = value === "true" || value === "1";
			continue;
		}
		reasonParts.push(part);
	}
	return {
		scope,
		reason: reasonParts.join(" "),
	};
}

function formatApprovalScope(scope = null) {
	if (!scope) return "general scope";
	const parts = [];
	if (Array.isArray(scope.allowed_tools) && scope.allowed_tools.length > 0) {
		parts.push(`tools=${scope.allowed_tools.join(",")}`);
	}
	if (scope.pool_address) parts.push(`pool=${scope.pool_address}`);
	if (scope.position_address) parts.push(`position=${scope.position_address}`);
	if (scope.max_amount_sol != null) parts.push(`max_sol=${scope.max_amount_sol}`);
	if (scope.one_shot) parts.push("once");
	return parts.length > 0 ? parts.join(" ") : "general scope";
}

export async function handleOperatorCommandText({
  text,
  source,
	config,
	getRecoveryWorkflowReport,
	getAutonomousWriteSuppression,
	setAutonomousWriteSuppression,
	acknowledgeRecoveryResume,
  armGeneralWriteTools,
  disarmGeneralWriteTools,
  getOperatorControlSnapshot,
  refreshRuntimeHealth,
} = {}) {
  if (!text) return { handled: false, message: null };

  if (text.startsWith("/arm")) {
    const [, minutesRaw, ...reasonParts] = text.split(/\s+/);
    const minutes = Math.max(1, Number(minutesRaw) || 10);
    const parsed = parseArmScopeOptions(reasonParts);
    if (!Array.isArray(parsed.scope.allowed_tools) || parsed.scope.allowed_tools.length === 0) {
			return {
				handled: true,
				message: "Scoped approvals require at least one explicit tool via tool=<name>.",
			};
		}
    const reason = parsed.reason || `${source} operator arm`;
    const armStatus = armGeneralWriteTools({ minutes, reason, scope: parsed.scope });
    const snapshot = getOperatorControlSnapshot?.() || { general_write_arm: armStatus };
    refreshRuntimeHealth();
    return {
      handled: true,
      message: `GENERAL write tools armed for ${minutes} minute(s)${snapshot.general_write_arm?.armed_until ? ` until ${snapshot.general_write_arm.armed_until}` : ""} with ${formatApprovalScope(snapshot.general_write_arm?.scope)}.`,
    };
  }

  if (text.startsWith("/disarm")) {
    const armStatus = disarmGeneralWriteTools({ reason: `${source} operator disarm` });
    const snapshot = getOperatorControlSnapshot?.() || { general_write_arm: armStatus };
    refreshRuntimeHealth();
    return {
      handled: true,
      message: `GENERAL write tools ${snapshot.general_write_arm?.armed ? "still armed" : "disarmed"}.`,
    };
  }

  if (text.startsWith("/resume ")) {
    const reason = text.slice(8).trim();
    const report = getRecoveryWorkflowReport({ limit: 10 });
    if (report.status === "journal_invalid") {
      return {
        handled: true,
        message: "Cannot resume while the action journal is invalid. Fix journal corruption first.",
      };
    }
    const suppression = getAutonomousWriteSuppression();
    const resumableWorkflowBlock = suppression.suppressed
      && suppression.code === "UNRESOLVED_WORKFLOW"
      && Boolean(suppression.incident_key);
    if (!resumableWorkflowBlock) {
      return {
        handled: true,
        message: "Cannot persist resume override unless autonomous writes are currently suppressed for an unresolved-workflow manual-review block.",
      };
    }
    setAutonomousWriteSuppression({ suppressed: false });
    const override = acknowledgeRecoveryResume({
      reason,
      report_status: report.status,
      cleared_guard_pause: false,
      incident_key: suppression.incident_key,
      source,
      override_minutes: config.protections.recoveryResumeOverrideMinutes,
    });
    const snapshot = getOperatorControlSnapshot?.() || { recovery_resume_override: override };
    refreshRuntimeHealth();
    return {
      handled: true,
      message: `Autonomous write suppression cleared. Previous suppression: ${suppression.reason || "none"}. Portfolio guard pause unchanged. Persisted resume override until ${snapshot.recovery_resume_override?.override_until || "n/a"}.`,
    };
  }

  return { handled: false, message: null };
}
