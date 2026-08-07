// kilocode_change - new file

export type AiCodeUploadAction = "commit" | "retry" | "reanalysis" | "status_check"

export type AiCodeUploadErrorCategory =
	| "server_unreachable"
	| "timeout"
	| "payload_too_large"
	| "invalid_local_payload"
	| "rate_limited"
	| "auth_error"
	| "server_error"
	| "client_error"
	| "unknown"

export interface AiCodeUploadTargetDiagnostics {
	targetProtocol?: string
	targetHost?: string
	targetPath?: string
}

export interface AiCodeUploadFailureDiagnostics extends AiCodeUploadTargetDiagnostics {
	errorCategory: AiCodeUploadErrorCategory
	userMessage: string
}

export const summarizeUploadTarget = (rawUrl?: string): AiCodeUploadTargetDiagnostics => {
	const trimmed = rawUrl?.trim()
	if (!trimmed) {
		return {}
	}

	try {
		const url = new URL(trimmed)
		return {
			targetProtocol: url.protocol.replace(/:$/, ""),
			targetHost: url.host,
			targetPath: url.pathname || "/",
		}
	} catch {
		return {
			targetHost: trimmed,
		}
	}
}

export const classifyUploadError = (message?: string): AiCodeUploadErrorCategory => {
	const normalized = message?.toLowerCase() ?? ""
	if (!normalized) {
		return "unknown"
	}
	if (
		normalized === "fetch failed" ||
		normalized.includes("failed to fetch") ||
		normalized.includes("networkerror") ||
		/\bload failed\b/.test(normalized) ||
		normalized.includes("econnrefused") ||
		normalized.includes("enotfound") ||
		normalized.includes("ehostunreach") ||
		normalized.includes("econnreset")
	) {
		return "server_unreachable"
	}
	if (
		normalized.includes("timeout") ||
		normalized.includes("timed out") ||
		normalized.includes("etimedout") ||
		normalized.includes("aborterror")
	) {
		return "timeout"
	}
	if (
		normalized.includes("(413") ||
		(normalized.includes("payload") && normalized.includes("too large")) ||
		normalized.includes("上报包过大") ||
		normalized.includes("超过大小限制")
	) {
		return "payload_too_large"
	}
	if (normalized.includes("(429")) {
		return "rate_limited"
	}
	if (normalized.includes("(401") || normalized.includes("(403")) {
		return "auth_error"
	}
	if (/\(5\d\d\b/.test(normalized)) {
		return "server_error"
	}
	if (/\(4\d\d\b/.test(normalized)) {
		return "client_error"
	}
	return "unknown"
}

export const buildUploadFailureUserMessage = (
	category: AiCodeUploadErrorCategory,
	fallbackMessage?: string,
): string => {
	switch (category) {
		case "server_unreachable":
			return "无法连接上报服务器，请检查后台服务是否启动、服务器地址是否正确，或网络是否可达。"
		case "timeout":
			return "连接上报服务器超时，请检查网络或后台服务状态。"
		case "payload_too_large":
			return "上报包过大，请导出诊断并联系管理员处理。"
		case "invalid_local_payload":
			return "本地保留的上报事实不符合当前服务端协议，已停止自动重试；请导出诊断并联系管理员处理。"
		case "rate_limited":
			return "上报请求被限流，请稍后重试。"
		case "auth_error":
			return "上报请求未被服务器授权，请检查服务端配置。"
		case "server_error":
			return "上报服务器返回错误，请稍后重试或查看后台日志。"
		case "client_error":
			return "上报请求参数被服务器拒绝，请导出诊断并联系管理员处理。"
		default:
			return fallbackMessage?.trim() || "上报失败，请导出诊断并联系管理员处理。"
	}
}

export const buildUploadFailureDiagnostics = (message?: string, rawUrl?: string): AiCodeUploadFailureDiagnostics => {
	const errorCategory = classifyUploadError(message)
	return {
		errorCategory,
		userMessage: buildUploadFailureUserMessage(errorCategory, message),
		...summarizeUploadTarget(rawUrl),
	}
}
