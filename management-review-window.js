const DEFAULT_SLOW_REVIEW_INTERVAL_MS = 15 * 60 * 1000;

let lastSlowManagementReviewAt = 0;

export function shouldRunSlowManagementReview({
	nowMs = Date.now(),
	intervalMs = DEFAULT_SLOW_REVIEW_INTERVAL_MS,
} = {}) {
	return nowMs - lastSlowManagementReviewAt >= intervalMs;
}

export function markSlowManagementReview({ nowMs = Date.now() } = {}) {
	lastSlowManagementReviewAt = nowMs;
	return lastSlowManagementReviewAt;
}

export function resetSlowManagementReviewForTests() {
	lastSlowManagementReviewAt = 0;
}
