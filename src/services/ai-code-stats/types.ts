export type AiCodeSourceType = "autocomplete" | "agent_insert"
export type AiCodeIde = "vscode" | "jetbrains"
export type AiCodeUploadMode = "incremental" | "backfill"
export type AiCodeStatsRangeType = "current" | "last3days" | "last7days" | "last30days" | "custom" | "all"
export type AiCodeMetricType = "generated" | "committed"
export type AiCodeCommitMatchStrategy = "exact" | "partial_block"

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
	metricType: AiCodeMetricType
	// kilocode_change start
	userName?: string
	userEmail?: string
	organizationId?: string
	organizationName?: string
	sourceIp?: string
	workspaceName: string
	workspacePath: string
	projectKey?: string
	filePath: string
	relativePath: string
	language?: string
	gitRemoteUrl?: string
	gitBranch?: string
	// kilocode_change end
	lineStart: number
	lineEnd: number
	lineCount: number
	codeSnippet: string
	taskId?: string
	commitHash?: string
	commitOccurredAt?: number
	matchStrategy?: AiCodeCommitMatchStrategy
	matchConfidence?: number
	equivalentLineCount?: number
}

export interface AiCodeStatsDailyAggregate {
	suggestedLines: number
	generatedLines: number
	committedLines: number
	equivalentCommittedLines: number
	eventCount: number
}

export interface AiCodeStatsSummaryPeriod {
	suggestedLines: number
	generatedLines: number
	committedLines: number
	adoptionRate: number
	strictCommittedLines: number
	equivalentCommittedLines: number
	strictAdoptionRate: number
	equivalentAdoptionRate: number
}

export interface AiCodeStatsLastUpload {
	status: "idle" | "success" | "failed"
	timestamp?: number
	message?: string
	uploadedEvents?: number
	mode?: AiCodeUploadMode
	trigger?: "daily" | "threshold" | "commit" | "manual"
}

export interface AiCodeStatsSummary {
	today: AiCodeStatsSummaryPeriod
	total: AiCodeStatsSummaryPeriod
	pendingEvents: number
	lastUpload: AiCodeStatsLastUpload
	lastSuccessfulUploadAt?: number
}

export interface AiCodeStatsPersistedState {
	version: 1
	dailyAggregates: Record<string, AiCodeStatsDailyAggregate>
	pendingEventIds: string[]
	repoObservedCommits: Record<string, string>
	lastUpload: AiCodeStatsLastUpload
	lastSuccessfulUploadAt?: number
}

export interface AiCodeStatsUploadSettings {
	enabled?: boolean
	webhookUrl?: string
	// kilocode_change start
	userName?: string
	// kilocode_change end
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

export interface AiCodePatchAddedLine {
	lineNumber: number
	content: string
}

export interface AiCodePatchFile {
	filePath: string
	previousFilePath?: string
	addedLines: AiCodePatchAddedLine[]
}

export interface AiCodePendingLineAttribution {
	id: string
	generatedEventId: string
	blockId: string
	timestamp: number
	sourceType: AiCodeSourceType
	ide: AiCodeIde
	// kilocode_change start
	userName?: string
	userEmail?: string
	organizationId?: string
	organizationName?: string
	sourceIp?: string
	workspaceName: string
	workspacePath: string
	projectKey?: string
	filePath: string
	relativePath: string
	repoRoot: string
	repoRelativePath: string
	language?: string
	gitRemoteUrl?: string
	gitBranch?: string
	// kilocode_change end
	taskId?: string
	rawLine: string
	blockLineIndex: number
	blockLineCount: number
	lineHash: string
	occurrenceIndex: number
	normalizedLine: string
	normalizedTokenLine: string
	rareIdentifiers: string[]
}

export const AI_CODE_STATS_VERSION = 1 as const
export const AI_CODE_STATS_RETENTION_DAYS = 30

export const toLocalDateKey = (timestamp: number): string => {
	const d = new Date(timestamp)
	const y = d.getFullYear()
	const m = String(d.getMonth() + 1).padStart(2, "0")
	const day = String(d.getDate()).padStart(2, "0")
	return `${y}-${m}-${day}`
}

export const emptyAggregate = (): AiCodeStatsDailyAggregate => ({
	suggestedLines: 0,
	generatedLines: 0,
	committedLines: 0,
	equivalentCommittedLines: 0,
	eventCount: 0,
})

export const emptySummary = (): AiCodeStatsSummary => ({
	today: emptySummaryPeriod(),
	total: emptySummaryPeriod(),
	pendingEvents: 0,
	lastUpload: {
		status: "idle",
	},
})

export const emptySummaryPeriod = (): AiCodeStatsSummaryPeriod => ({
	suggestedLines: 0,
	generatedLines: 0,
	committedLines: 0,
	adoptionRate: 0,
	strictCommittedLines: 0,
	equivalentCommittedLines: 0,
	strictAdoptionRate: 0,
	equivalentAdoptionRate: 0,
})

export const normalizePath = (value: string): string => value.replace(/\\/g, "/")
