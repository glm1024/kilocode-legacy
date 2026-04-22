import { buildEmailUserKey, normalizePath as normalizeFsPath, normalizeUserEmail } from "../ai-code-stats/types"

export type AiTokenUsageIde = "vscode" | "jetbrains" | "unscoped"
export type AiTokenUsageUploadMode = "incremental"

export type AiTokenUsageRange =
	| { type: "current" }
	| { type: "last7days" }
	| { type: "last30days" }
	| { type: "all" }
	| { type: "custom"; startDate?: string; endDate?: string }

export interface AiTokenUsageUploadSettings {
	webhookUrl?: string
	departmentName?: string
	officeName?: string
	teamName?: string
	userName?: string
	userEmail?: string
}

export interface AiTokenUsageUploadClient {
	ide: AiTokenUsageIde
	wrapperName?: string
	wrapperVersion?: string
	extensionVersion?: string
	machineId?: string
}

export interface AiTokenUsageRecordInput {
	taskId?: string
	occurredAt: number
	timezone: string
	userName: string
	userEmail?: string
	departmentName?: string
	officeName?: string
	teamName?: string
	sourceIp: string
	userKey: string
	organizationId?: string
	organizationName?: string
	projectKey: string
	projectName: string
	repoRoot?: string
	gitRemoteUrl?: string
	gitBranch?: string
	ide: AiTokenUsageIde
	provider: string
	model: string
	requestCount: number
	inputTokens: number
	outputTokens: number
	cacheReadTokens: number
	cacheWriteTokens: number
	totalTokens: number
}

export interface AiTokenUsageAggregateRow extends AiTokenUsageRecordInput {
	key: string
	dateKey: string
	firstOccurredAt: number
	lastOccurredAt: number
	dirty: boolean
	uploadedAt?: number
}

export interface AiTokenUsagePersistedState {
	version: 1
	rows: Record<string, AiTokenUsageAggregateRow>
}

export interface AiTokenUsageUploadEnvelope {
	version: "v1"
	source: "kilocode-ai-token-usage"
	mode: AiTokenUsageUploadMode
	client: AiTokenUsageUploadClient
	window: {
		fromDate: string
		toDate: string
		timezone: string
		generatedAt: number
	}
	rows: AiTokenUsageAggregateUploadRow[]
}

export interface AiTokenUsageAggregateUploadRow {
	dateKey: string
	timezone: string
	userName: string
	userEmail?: string
	departmentName?: string
	officeName?: string
	teamName?: string
	sourceIp: string
	userKey: string
	organizationId?: string
	organizationName?: string
	projectKey: string
	projectName: string
	repoRoot?: string
	gitRemoteUrl?: string
	gitBranch?: string
	ide: AiTokenUsageIde
	provider: string
	model: string
	requestCount: number
	inputTokens: number
	outputTokens: number
	cacheReadTokens: number
	cacheWriteTokens: number
	totalTokens: number
	firstOccurredAt: number
	lastOccurredAt: number
}

export interface AiTokenUsageSummary {
	inputTokens: number
	outputTokens: number
	totalTokens: number
}

export const AI_TOKEN_USAGE_VERSION = 1 as const
export const AI_TOKEN_USAGE_RETENTION_DAYS = 180

export const toLocalDateKey = (timestamp: number): string => {
	const date = new Date(timestamp)
	const year = date.getFullYear()
	const month = String(date.getMonth() + 1).padStart(2, "0")
	const day = String(date.getDate()).padStart(2, "0")
	return `${year}-${month}-${day}`
}

export const normalizePath = (value: string): string => normalizeFsPath(value)

export const normalizeDimensionValue = (value?: string, fallback = "unknown"): string => {
	const trimmed = value?.trim()
	return trimmed ? trimmed : fallback
}

export { normalizeUserEmail }

export const buildUserKey = (userEmail: string): string => buildEmailUserKey(userEmail)

export const buildAggregateKey = (
	dateKey: string,
	userKey: string,
	projectKey: string,
	ide: AiTokenUsageIde,
	provider: string,
	model: string,
): string => [dateKey, userKey, projectKey, ide, provider, model].join("::")
