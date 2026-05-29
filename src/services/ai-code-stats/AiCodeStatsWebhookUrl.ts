export const AI_CODE_STATS_INGEST_PATH = "/api/v1/ingest/ai-code-stats"
export const AI_CODE_STATS_COMMIT_STATUS_PATH = "/api/v1/ingest/ai-code-stats/commit-status"
export const DEFAULT_AI_CODE_STATS_WEBHOOK_URL = "http://100.7.132.102:8081/prod-api"
const AI_TOKEN_USAGE_INGEST_PATH = "/api/v1/ingest/ai-token-usage"

export class InvalidAiCodeStatsWebhookUrlError extends Error {
	constructor(
		public readonly code: "invalid_url" | "unsupported_protocol",
		message: string,
	) {
		super(message)
		this.name = "InvalidAiCodeStatsWebhookUrlError"
	}
}

const normalizePathname = (pathname: string): string => {
	const trimmed = pathname.replace(/\/+$/, "")
	return trimmed || "/"
}

const resolveIngestPath = (pathname: string, targetPath: string): string => {
	const normalizedPathname = normalizePathname(pathname)
	if (normalizedPathname === "/") {
		return targetPath
	}

	for (const knownPath of [AI_CODE_STATS_INGEST_PATH, AI_CODE_STATS_COMMIT_STATUS_PATH, AI_TOKEN_USAGE_INGEST_PATH]) {
		if (normalizedPathname === knownPath) {
			return targetPath
		}
		if (normalizedPathname.endsWith(knownPath)) {
			const basePath = normalizedPathname.slice(0, -knownPath.length)
			return `${basePath || ""}${targetPath}`
		}
	}

	return `${normalizedPathname}${targetPath}`
}

export const resolveAiCodeStatsWebhookUrl = (rawValue: string): string => {
	const trimmed = rawValue.trim()
	if (!trimmed) {
		return ""
	}

	let parsedUrl: URL
	try {
		parsedUrl = new URL(trimmed)
	} catch {
		throw new InvalidAiCodeStatsWebhookUrlError("invalid_url", "Upload server URL is not a valid URL.")
	}

	if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
		throw new InvalidAiCodeStatsWebhookUrlError(
			"unsupported_protocol",
			"Upload server URL must start with http:// or https://.",
		)
	}

	parsedUrl.pathname = resolveIngestPath(parsedUrl.pathname, AI_CODE_STATS_INGEST_PATH)
	parsedUrl.hash = ""
	return parsedUrl.toString()
}

export const resolveAiCodeStatsCommitStatusUrl = (rawValue: string): string => {
	const trimmed = rawValue.trim()
	if (!trimmed) {
		return ""
	}

	let parsedUrl: URL
	try {
		parsedUrl = new URL(trimmed)
	} catch {
		throw new InvalidAiCodeStatsWebhookUrlError("invalid_url", "Upload server URL is not a valid URL.")
	}

	if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
		throw new InvalidAiCodeStatsWebhookUrlError(
			"unsupported_protocol",
			"Upload server URL must start with http:// or https://.",
		)
	}

	parsedUrl.pathname = resolveIngestPath(parsedUrl.pathname, AI_CODE_STATS_COMMIT_STATUS_PATH)
	parsedUrl.hash = ""
	return parsedUrl.toString()
}
