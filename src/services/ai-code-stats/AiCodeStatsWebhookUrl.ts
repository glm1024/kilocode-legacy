export const AI_CODE_STATS_INGEST_PATH = "/api/v1/ingest/ai-code-stats"

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

	const normalizedPathname = normalizePathname(parsedUrl.pathname)
	parsedUrl.pathname = normalizedPathname === "/" ? AI_CODE_STATS_INGEST_PATH : normalizedPathname
	parsedUrl.hash = ""
	return parsedUrl.toString()
}
