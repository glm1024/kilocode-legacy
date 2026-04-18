import { normalizePath as normalizeFsPath } from "../ai-code-stats/types"

export type AiTokenUsageIde = "vscode" | "jetbrains"
export type AiTokenUsageUploadMode = "incremental"

export type AiTokenUsageRange =
	| { type: "current" }
	| { type: "last7days" }
	| { type: "last30days" }
	| { type: "all" }
	| { type: "custom"; startDate?: string; endDate?: string }

export interface AiTokenUsageUploadSettings {
	webhookUrl?: string
	userName?: string
}

export interface AiTokenUsageUploadClient {
	ide: AiTokenUsageIde
	wrapperName?: string
	wrapperVersion?: string
	extensionVersion?: string
	machineId?: string
}

export interface AiTokenUsageRecordInput {
	occurredAt: number
	timezone: string
	userName: string
	sourceIp: string
	userKey: string
	organizationId?: string
	organizationName?: string
	workspaceName: string
	projectKey: string
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
	sourceIp: string
	userKey: string
	organizationId?: string
	organizationName?: string
	workspaceName: string
	projectKey: string
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

export const buildUserKey = (userName: string, sourceIp: string): string => `${userName}|${sourceIp}`

export const buildAggregateKey = (
	dateKey: string,
	userKey: string,
	projectKey: string,
	ide: AiTokenUsageIde,
	provider: string,
	model: string,
): string => [dateKey, userKey, projectKey, ide, provider, model].join("::")
