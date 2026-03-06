// kilocode_change - new file

export type AiCodeSourceType = "autocomplete" | "agent_insert"
export type AiCodeIde = "vscode" | "jetbrains"
export type AiCodeUploadMode = "incremental" | "backfill"
export type AiCodeStatsRangeType = "current" | "last3days" | "last7days" | "last30days" | "custom" | "all"

export interface AiCodeStatsRange {
	type: AiCodeStatsRangeType
	startDate?: string
	endDate?: string
}

export interface AiCodeStatsEvent {
	eventId: string
	timestamp: number
	sourceType: AiCodeSourceType
	ide: AiCodeIde
	workspaceName: string
	workspacePath: string
	filePath: string
	relativePath: string
	lineStart: number
	lineEnd: number
	lineCount: number
	codeSnippet: string
	taskId?: string
}

export interface AiCodeStatsDailyAggregate {
	agentLines: number
	totalLines: number
	eventCount: number
}

export interface AiCodeStatsLastUpload {
	status: "idle" | "success" | "failed"
	timestamp?: number
	message?: string
	uploadedEvents?: number
	mode?: AiCodeUploadMode
	trigger?: "daily" | "threshold" | "manual"
}

export interface AiCodeStatsSummary {
	today: {
		agentLines: number
		totalLines: number
	}
	total: {
		agentLines: number
		totalLines: number
	}
	pendingEvents: number
	lastUpload: AiCodeStatsLastUpload
	lastSuccessfulUploadAt?: number
}

export interface AiCodeStatsPersistedState {
	version: 1
	dailyAggregates: Record<string, AiCodeStatsDailyAggregate>
	pendingEventIds: string[]
	lastUpload: AiCodeStatsLastUpload
	lastSuccessfulUploadAt?: number
}

export interface AiCodeStatsUploadSettings {
	enabled?: boolean
	webhookUrl?: string
}

export interface AiCodeStatsUploadClient {
	ide: AiCodeIde
	wrapperName?: string
	wrapperVersion?: string
	extensionVersion?: string
	machineId?: string
}

export interface AiCodeStatsUploadEnvelope {
	version: "v1"
	source: "kilocode-ai-code-stats"
	mode: AiCodeUploadMode
	client: AiCodeStatsUploadClient
	window: {
		fromTimestamp: number
		toTimestamp: number
		timezone: string
		generatedAt: number
	}
	events: AiCodeStatsEvent[]
}

export interface AiCodeAddedCodeBlock {
	lineStart: number
	lineEnd: number
	lineCount: number
	codeSnippet: string
}

export const AI_CODE_STATS_VERSION = 1 as const
export const AI_CODE_STATS_RETENTION_DAYS = 30
export const AI_CODE_STATS_BACKFILL_DAYS = 3
export const AI_CODE_STATS_THRESHOLD = 300

export const toLocalDateKey = (timestamp: number): string => {
	const d = new Date(timestamp)
	const y = d.getFullYear()
	const m = String(d.getMonth() + 1).padStart(2, "0")
	const day = String(d.getDate()).padStart(2, "0")
	return `${y}-${m}-${day}`
}

export const emptyAggregate = (): AiCodeStatsDailyAggregate => ({
	agentLines: 0,
	totalLines: 0,
	eventCount: 0,
})

export const emptySummary = (): AiCodeStatsSummary => ({
	today: {
		agentLines: 0,
		totalLines: 0,
	},
	total: {
		agentLines: 0,
		totalLines: 0,
	},
	pendingEvents: 0,
	lastUpload: {
		status: "idle",
	},
})

export const normalizePath = (value: string): string => value.replace(/\\/g, "/")
