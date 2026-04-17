export type AiCodeSourceType = "autocomplete" | "agent_insert"
export type AiCodeIde = "vscode" | "jetbrains"
export type AiCodeUploadMode = "incremental" | "backfill"
export type AiCodeStatsRangeType = "current" | "last7days" | "last30days" | "custom" | "all"
export type AiCodeMetricType = "generated" | "accepted" | "committed"
export type AiCodeCommitMatchStrategy = "exact" | "partial"
export type AiCodeGeneratedBlockUploadStatus = "pending" | "queued" | "uploaded"
export type AiCodeStatsSemanticsVersion = 1
export type AiCodeCommitMatchDetailScoreSource = "attribution" | "inferred"
export type AiCodeCommitMatchOverlapKind = "identifier" | "term"
export type AiCodeCommitMatchAdjustment = "inline_comment_bonus"

export interface AiCodeCommitLineMatchDetail {
	committedLineNumber: number
	generatedLineNumber: number
	scoreSource: "attribution"
	finalScore: number
	baseScore: number
	editSimilarity: number
	tokenSimilarity: number
	overlapSimilarity: number
	overlapKind: AiCodeCommitMatchOverlapKind
	adjustments: AiCodeCommitMatchAdjustment[]
}

export interface AiCodeCommitMatchDetail {
	scoreSource: AiCodeCommitMatchDetailScoreSource
	finalScore: number
	baseScore?: number
	editSimilarity?: number
	tokenSimilarity?: number
	overlapSimilarity?: number
	adjustments?: AiCodeCommitMatchAdjustment[]
	lineDetails: AiCodeCommitLineMatchDetail[]
}

export interface AiCodeStatsRange {
	type: AiCodeStatsRangeType
	startDate?: string
	endDate?: string
}

export interface AiCodeStatsEvent {
	eventId: string
	timestamp: number
	semanticsVersion?: AiCodeStatsSemanticsVersion
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
	fileSnapshotContent?: string
	taskId?: string
	commitHash?: string
	commitOccurredAt?: number
	matchStrategy?: AiCodeCommitMatchStrategy
	matchConfidence?: number
	equivalentLineCount?: number
	generatedBlockId?: string
	matchDetail?: AiCodeCommitMatchDetail
}

export interface AiCodeGeneratedBlock {
	eventId: string
	generatedBlockId: string
	timestamp: number
	semanticsVersion?: AiCodeStatsSemanticsVersion
	sourceType: AiCodeSourceType
	ide: AiCodeIde
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
	lineStart: number
	lineEnd: number
	lineCount: number
	codeSnippet: string
	fileSnapshotContent?: string
	taskId?: string
}

export interface AiCodeGeneratedBlockState extends AiCodeGeneratedBlock {
	stateId: string
	repoRoot?: string
	repoRelativePath?: string
	originEventId?: string
	originTimestamp?: number
	originLineStart?: number
	originLineEnd?: number
	originLineCount?: number
	originCodeSnippet?: string
	originFileSnapshotContent?: string
	currentTimestamp?: number
	currentLineStart?: number
	currentLineEnd?: number
	currentLineCount?: number
	currentCodeSnippet?: string
	currentFileSnapshotContent?: string
	uploadStatus: AiCodeGeneratedBlockUploadStatus
	queuedReportId?: string
}

export interface AiCodeCommittedBlock {
	eventId: string
	generatedBlockId: string
	timestamp: number
	semanticsVersion?: AiCodeStatsSemanticsVersion
	sourceType: AiCodeSourceType
	ide: AiCodeIde
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
	lineStart: number
	lineEnd: number
	lineCount: number
	codeSnippet: string
	fileSnapshotContent?: string
	taskId?: string
	commitHash: string
	commitOccurredAt: number
	matchStrategy?: AiCodeCommitMatchStrategy
	matchConfidence?: number
	equivalentLineCount?: number
	matchDetail?: AiCodeCommitMatchDetail
}

export interface AiCodeCommitChangedBlock {
	startLine: number
	endLine: number
	lineCount: number
	codeSnippet: string
	displayOrder: number
}

export interface AiCodeCommitChangedFile {
	relativePath: string
	filePath: string
	previousFilePath?: string
	language?: string
	committedSnapshotContent?: string
	changedBlocks: AiCodeCommitChangedBlock[]
}

export interface AiCodeCommitReport {
	version: "v2"
	source: "kilocode-ai-code-stats"
	mode: "commit_report"
	semanticsVersion?: AiCodeStatsSemanticsVersion
	reportId: string
	reportGeneratedAt: number
	client: AiCodeStatsUploadClient
	repoRoot: string
	workspaceName: string
	workspacePath: string
	projectKey?: string
	gitRemoteUrl?: string
	gitBranch?: string
	commitHash: string
	previousCommitHash?: string
	commitOccurredAt: number
	acceptedBlocks?: AiCodeGeneratedBlock[]
	generatedBlocks?: AiCodeGeneratedBlock[]
	committedBlocks: AiCodeCommittedBlock[]
	changedFiles: AiCodeCommitChangedFile[]
}

export interface AiCodeQueuedCommitReport {
	report: AiCodeCommitReport
	createdAt: number
	generatedBlockIds: string[]
	matchedPendingLineIds: string[]
}

export type AiCodePendingCommitMetricBlock = AiCodeGeneratedBlock

export interface AiCodeStatsDailyAggregate {
	suggestedLines: number
	generatedLines: number
	acceptedLines: number
	committedLines: number
	equivalentCommittedLines: number
	eventCount: number
}

export interface AiCodeStatsSummaryPeriod {
	suggestedLines: number
	generatedLines: number
	acceptedLines: number
	committedLines: number
	adoptionRate: number
	retentionRate: number
	strictCommittedLines: number
	equivalentCommittedLines: number
	strictAdoptionRate: number
	equivalentAdoptionRate: number
}

export interface AiCodeStatsRangeSummary {
	generatedLines: number
	acceptedLines: number
	committedLines: number
	adoptionRate: number
	retentionRate: number
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
}

export interface AiCodeStatsPersistedState {
	version: 1
	dailyAggregates: Record<string, AiCodeStatsDailyAggregate>
	pendingEventIds: string[]
	supersededEventIds: string[]
	repoObservedCommits: Record<string, string>
	lastUpload: AiCodeStatsLastUpload
}

export interface AiCodeStatsUploadSettings {
	enabled?: boolean
	webhookUrl?: string
	// kilocode_change start
	userName?: string
	// kilocode_change end
}

export interface AiCodeCommitAttributionConfig {
	candidateMinLineScore: number
	contextualMinLineScore: number
	isolatedMinLineScore: number
	ambiguityGap: number
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
	semanticsVersion?: AiCodeStatsSemanticsVersion
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

export interface AiCodePatchHunk {
	oldStart: number
	oldLines: number
	newStart: number
	newLines: number
}

export interface AiCodePatchFile {
	filePath: string
	previousFilePath?: string
	addedLines: AiCodePatchAddedLine[]
	changedBlocks: AiCodeCommitChangedBlock[]
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

export const DEFAULT_AI_CODE_COMMIT_ATTRIBUTION_CONFIG: AiCodeCommitAttributionConfig = {
	candidateMinLineScore: 0.6,
	contextualMinLineScore: 0.65,
	isolatedMinLineScore: 0.7,
	ambiguityGap: 0.02,
}

export const AI_CODE_STATS_VERSION = 1 as const
export const CURRENT_AI_CODE_STATS_SEMANTICS_VERSION = 1 as const
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
	acceptedLines: 0,
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
	acceptedLines: 0,
	committedLines: 0,
	adoptionRate: 0,
	retentionRate: 0,
	strictCommittedLines: 0,
	equivalentCommittedLines: 0,
	strictAdoptionRate: 0,
	equivalentAdoptionRate: 0,
})

export const normalizePath = (value: string): string => value.replace(/\\/g, "/")
