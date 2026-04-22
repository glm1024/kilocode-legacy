export type AiCodeSourceType = "agent_insert"
export type AiCodeIde = string
export type AiCodeMetricType = "generated" | "accepted"
export type AiCodeUploadMode = "incremental"
export type AiCodeGeneratedBlockUploadStatus = "pending" | "queued" | "uploaded"
export type AiCodeStatsSemanticsVersion = 1

export interface AiCodeStatsEvent {
	eventId: string
	timestamp: number
	semanticsVersion?: AiCodeStatsSemanticsVersion
	sourceType: AiCodeSourceType
	ide: AiCodeIde
	metricType: AiCodeMetricType
	userName?: string
	departmentName?: string
	officeName?: string
	teamName?: string
	userEmail?: string
	organizationId?: string
	organizationName?: string
	sourceIp?: string
	projectKey?: string
	projectName?: string
	repoRoot?: string
	repoRelativePath?: string
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
	commitHash?: string
	commitOccurredAt?: number
	generatedBlockId?: string
}

export interface AiCodeGeneratedBlock {
	eventId: string
	generatedBlockId: string
	timestamp: number
	semanticsVersion?: AiCodeStatsSemanticsVersion
	sourceType: AiCodeSourceType
	ide: AiCodeIde
	userName?: string
	departmentName?: string
	officeName?: string
	teamName?: string
	userEmail?: string
	organizationId?: string
	organizationName?: string
	sourceIp?: string
	projectKey?: string
	projectName?: string
	repoRoot?: string
	repoRelativePath?: string
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

export interface AiCodeCommitCandidateLine {
	clientLineId: string
	generatedBlockId: string
	baselineEventId: string
	baselineMetricType: "generated" | "accepted"
	sourceTimestamp: number
	sourceType: AiCodeSourceType
	ide: AiCodeIde
	userName?: string
	departmentName?: string
	officeName?: string
	teamName?: string
	userEmail?: string
	organizationId?: string
	organizationName?: string
	sourceIp?: string
	projectKey?: string
	projectName?: string
	filePath: string
	relativePath: string
	repoRoot: string
	repoRelativePath: string
	language?: string
	gitRemoteUrl?: string
	gitBranch?: string
	taskId?: string
	lineNumber: number
	rawLine: string
	blockLineIndex: number
	blockLineCount: number
	lineHash: string
	occurrenceIndex: number
}

export interface AiCodeCommitAddedLine {
	addedIndex: number
	lineNumber: number
	content: string
	lineHash: string
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
	addedLines?: AiCodeCommitAddedLine[]
}

export interface AiCodeCommitReport {
	version: "v2"
	source: "kilocode-ai-code-stats"
	mode: "commit_report"
	semanticsVersion?: AiCodeStatsSemanticsVersion
	attributionInputVersion?: 1
	reportId: string
	reportGeneratedAt: number
	client: AiCodeStatsUploadClient
	repoRoot: string
	projectKey?: string
	projectName?: string
	gitRemoteUrl?: string
	gitBranch?: string
	commitHash: string
	previousCommitHash?: string
	commitOccurredAt: number
	acceptedBlocks?: AiCodeGeneratedBlock[]
	generatedBlocks?: AiCodeGeneratedBlock[]
	changedFiles: AiCodeCommitChangedFile[]
	candidateLines?: AiCodeCommitCandidateLine[]
}

export interface AiCodeQueuedCommitReport {
	report: AiCodeCommitReport
	createdAt: number
	generatedBlockIds: string[]
}

export type AiCodePendingCommitMetricBlock = AiCodeGeneratedBlock

export interface AiCodeStatsLastUpload {
	status: "idle" | "success" | "failed"
	timestamp?: number
	message?: string
	uploadedEvents?: number
	mode?: AiCodeUploadMode
	trigger?: "commit"
}

export interface AiCodeStatsPersistedState {
	version: 1
	pendingEventIds: string[]
	supersededEventIds: string[]
	repoObservedCommits: Record<string, string>
	lastUpload: AiCodeStatsLastUpload
}

export interface AiCodeStatsUploadSettings {
	enabled?: boolean
	webhookUrl?: string
	// kilocode_change start
	departmentName?: string
	officeName?: string
	teamName?: string
	userName?: string
	userEmail?: string
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
	departmentName?: string
	officeName?: string
	teamName?: string
	userEmail?: string
	organizationId?: string
	organizationName?: string
	sourceIp?: string
	projectKey?: string
	projectName?: string
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

export const normalizePath = (value: string): string => value.replace(/\\/g, "/")

export const normalizeUserEmail = (value?: string): string | undefined => {
	const normalized = value?.trim().toLowerCase()
	return normalized ? normalized : undefined
}

export const buildEmailUserKey = (userEmail: string): string => `email:${normalizeUserEmail(userEmail) ?? ""}`
