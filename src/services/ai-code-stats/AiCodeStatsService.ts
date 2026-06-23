import crypto from "crypto"
import { exec as execCallback } from "child_process"
import * as fs from "fs/promises"
import * as path from "path"
import { promisify } from "util"
import * as vscode from "vscode"

import { getKiloCodeWrapperProperties } from "../../core/kilocode/wrapper"
import { AiCodeCommitAttributionService, type AiCodeCommitFactsPayload } from "./AiCodeCommitAttributionService"
import { AI_CODING_CLIENT_VERSION } from "./AiCodingClientVersion"
import { AiCodeDiffExtractor } from "./AiCodeDiffExtractor"
import { hashLineFingerprint } from "./AiCodeLineFingerprint"
// kilocode_change start
import { AiCodeStatsMetadataResolver } from "./AiCodeStatsMetadataResolver"
import { AiTokenUsageService } from "../ai-token-usage/AiTokenUsageService"
// kilocode_change end
import { AiCodeStatsStore } from "./AiCodeStatsStore"
import {
	buildUploadFailureDiagnostics,
	summarizeUploadTarget,
	type AiCodeUploadAction,
	type AiCodeUploadFailureDiagnostics,
	type AiCodeUploadTargetDiagnostics,
} from "./AiCodeStatsUploadDiagnostics"
import {
	AiCodeStatsUploader,
	type AiCodeCommitLifecycleUploadResult,
	type AiCodeCommitReportUploadResult,
	type AiCodeStatsUploadResult,
} from "./AiCodeStatsUploader"
import { resolveAiCodeStatsCommitStatusUrl, resolveAiCodeStatsWebhookUrl } from "./AiCodeStatsWebhookUrl"
import {
	AI_CODE_STATS_RETENTION_DAYS,
	CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
	normalizePath,
	type AiCodeAddedCodeBlock,
	type AiCodeCommitCandidateLine,
	type AiCodeCommitLifecycleReport,
	type AiCodeCommitReport,
	type AiCodeCommitServerStatus,
	type AiCodeCommitUploadRecord,
	type AiCodeGeneratedBlock,
	type AiCodeGeneratedBlockState,
	type AiCodeIde,
	type AiCodeModelContext,
	type AiCodePatchHunk,
	type AiCodePendingLineAttribution,
	type AiCodeStatsEvent,
	type AiCodeStatsFailedReportUpload,
	type AiCodeStatsLastUpload,
	type AiCodeStatsUploadSettings,
} from "./types"

const execAsync = promisify(execCallback)
const EXEC_MAX_BUFFER_BYTES = 4 * 1024 * 1024
const COMMIT_UPLOAD_SCAN_INTERVAL_MS = 5 * 60 * 1000
const COMMIT_UPLOAD_SCAN_MAX_COMMITS = 50
const COMMIT_UPLOAD_SCAN_RETENTION_DAYS = 30
const COMMIT_UPLOAD_SCAN_VISIBLE_LIMIT = 10
const AUTO_REANALYSIS_MAX_ATTEMPTS = 3
const AUTO_REANALYSIS_BACKOFF_MS = [0, 5 * 60 * 1000, 30 * 60 * 1000] as const
const COMMIT_TIMESTAMP_MATCH_SKEW_MS = 2000
const COMMIT_CANDIDATE_CLIENT_LINE_ID_MAX_LENGTH = 128

const normalizeContentLines = (content: string): string[] => {
	const normalized = content.replace(/\r\n/g, "\n")
	const lines = normalized.split("\n")
	if (normalized.endsWith("\n")) {
		lines.pop()
	}
	return lines
}

const buildLineOccurrenceIndexes = (content: string): number[] => {
	const counts = new Map<string, number>()
	const indexes: number[] = []

	for (const line of normalizeContentLines(content)) {
		const lineHash = hashLineFingerprint(line)
		const nextIndex = (counts.get(lineHash) ?? 0) + 1
		counts.set(lineHash, nextIndex)
		indexes.push(nextIndex)
	}

	return indexes
}

const normalizeGeneratedBlockId = (generatedBlockId?: string): string =>
	typeof generatedBlockId === "string" ? generatedBlockId.trim() : ""

const normalizeModelContext = (context?: AiCodeModelContext): AiCodeModelContext | undefined => {
	const provider = context?.provider?.trim()
	const model = context?.model?.trim()
	if (!provider && !model) {
		return undefined
	}
	return {
		provider: provider || undefined,
		model: model || undefined,
	}
}

interface GeneratedLineRange {
	lineStart: number
	lineEnd: number
}

interface GeneratedStateBuildResult {
	nextBlocks: AiCodeGeneratedBlockState[]
	metricBlocks: AiCodeGeneratedBlock[]
}

interface AgentWriteBlockAnalysis {
	acceptedBlocks: AiCodeAddedCodeBlock[]
	acceptedDeletedBlocks: AiCodeAddedCodeBlock[]
}

interface CommitReportBuildOptions {
	reportId?: string
	includeUploadedBlocks?: boolean
	skipImmediateUpload?: boolean
}

interface LocalCommitSummary {
	commitHash: string
	commitOccurredAt?: number
	changedPaths: Set<string>
	addedLineCount?: number
	changedFileCount?: number
}

interface CommitCandidateSelection {
	changedPathSet: Set<string>
	addedLineHashesByPath: Map<string, Set<string>>
	deletedLineHashesByPath: Map<string, Set<string>>
	candidateBlocks: AiCodeGeneratedBlockState[]
}

const JETBRAINS_IDE_BY_WRAPPER_CODE: Record<string, AiCodeIde> = {
	AC: "appcode",
	IC: "idea",
	IU: "idea",
	AS: "android-studio",
	AI: "android-studio",
	WS: "webstorm",
	PS: "phpstorm",
	PY: "pycharm",
	PC: "pycharm",
	GO: "goland",
	CL: "clion",
	RD: "rider",
	RM: "rubymine",
	DB: "datagrip",
	DS: "dataspell",
	JB: "jetbrains",
}

const resolveJetBrainsIde = (wrapperCode: string | null | undefined): AiCodeIde => {
	const normalizedCode = typeof wrapperCode === "string" ? wrapperCode.trim().toUpperCase() : ""
	return JETBRAINS_IDE_BY_WRAPPER_CODE[normalizedCode] ?? "jetbrains"
}

const detectIde = (): AiCodeIde => {
	const wrapper = getKiloCodeWrapperProperties()
	if (!wrapper.kiloCodeWrapped || !wrapper.kiloCodeWrapperJetbrains) {
		return "vscode"
	}
	return resolveJetBrainsIde(wrapper.kiloCodeWrapperCode)
}

const resolveRealPath = async (targetPath: string): Promise<string> => {
	try {
		return normalizePath(await fs.realpath(targetPath))
	} catch {
		return normalizePath(path.resolve(targetPath))
	}
}

const resolveFilePathFromParent = async (targetPath: string): Promise<string> => {
	try {
		const realDir = await fs.realpath(path.dirname(targetPath))
		return normalizePath(path.join(realDir, path.basename(targetPath)))
	} catch {
		return normalizePath(path.resolve(targetPath))
	}
}

const resolveGitRepositoryRoot = async (cwd: string): Promise<string | undefined> => {
	try {
		const { stdout } = await execAsync("git rev-parse --show-toplevel", {
			cwd,
			maxBuffer: EXEC_MAX_BUFFER_BYTES,
		})
		const repoRoot = stdout.trim()
		return repoRoot ? resolveRealPath(repoRoot) : undefined
	} catch {
		return undefined
	}
}

export interface AgentFileWriteRecord {
	cwd: string
	filePath: string
	relativePath?: string
	originalContent: string
	proposedContent?: string
	newContent: string
	taskId?: string
	modelContext?: AiCodeModelContext
}

interface ResolvedFileContext {
	filePath: string
	relativePath: string
	repoRoot: string
	repoRelativePath: string
}

export class AiCodeStatsService {
	private static instance: AiCodeStatsService | null = null

	private readonly store: AiCodeStatsStore
	private readonly uploader: AiCodeStatsUploader
	private readonly extractor: AiCodeDiffExtractor
	private readonly commitAttributionService: AiCodeCommitAttributionService
	// kilocode_change start
	private readonly metadataResolver: AiCodeStatsMetadataResolver
	// kilocode_change end
	private readonly ide: AiCodeIde
	private readonly taskModelContexts = new Map<string, AiCodeModelContext>()
	private isUploading = false
	private uploadRequestedWhileRunning = false
	private isScanningCommitUploads = false
	private commitUploadScanTimer: NodeJS.Timeout | undefined

	private constructor(
		private readonly globalStoragePath: string,
		private readonly getUploadSettings: () => Promise<AiCodeStatsUploadSettings>,
	) {
		this.store = new AiCodeStatsStore(globalStoragePath)
		this.uploader = new AiCodeStatsUploader(this.store)
		this.extractor = new AiCodeDiffExtractor()
		this.commitAttributionService = new AiCodeCommitAttributionService(this.store, {
			onCommitCollected: async (payload) => {
				await this.handleCommitCollected(payload)
			},
			onCommitLifecycleObserved: async (payload) => {
				await this.handleCommitLifecycleObserved(payload)
			},
		})
		// kilocode_change start
		this.metadataResolver = new AiCodeStatsMetadataResolver()
		// kilocode_change end
		this.ide = detectIde()
	}

	static initialize(
		globalStoragePath: string,
		getUploadSettings: () => Promise<AiCodeStatsUploadSettings>,
	): AiCodeStatsService {
		if (!AiCodeStatsService.instance) {
			AiCodeStatsService.instance = new AiCodeStatsService(globalStoragePath, getUploadSettings)
		}
		return AiCodeStatsService.instance
	}

	static getInstance(): AiCodeStatsService | null {
		return AiCodeStatsService.instance
	}

	static disposeInstance(): void {
		AiCodeStatsService.instance?.stop()
		AiCodeStatsService.instance = null
	}

	recordTaskModelUsage(taskId: string | undefined, modelContext: AiCodeModelContext | undefined): void {
		const normalizedTaskId = taskId?.trim()
		const normalizedModelContext = normalizeModelContext(modelContext)
		if (!normalizedTaskId || !normalizedModelContext) {
			return
		}
		this.taskModelContexts.set(normalizedTaskId, normalizedModelContext)
		if (this.taskModelContexts.size > 500) {
			const oldestKey = this.taskModelContexts.keys().next().value
			if (oldestKey) {
				this.taskModelContexts.delete(oldestKey)
			}
		}
	}

	start(): void {
		void this.commitAttributionService.start().catch((error) => {
			console.error("[AiCodeStats] Failed to start commit attribution service:", error)
		})
		void this.refreshCommitUploadStatus().catch((error) => {
			console.error("[AiCodeStats] Failed to scan commit upload status on startup:", error)
		})
		this.commitUploadScanTimer ??= setInterval(() => {
			void this.refreshCommitUploadStatus().catch((error) => {
				console.error("[AiCodeStats] Failed to scan commit upload status:", error)
			})
		}, COMMIT_UPLOAD_SCAN_INTERVAL_MS)
	}

	stop(): void {
		this.commitAttributionService.stop()
		if (this.commitUploadScanTimer) {
			clearInterval(this.commitUploadScanTimer)
			this.commitUploadScanTimer = undefined
		}
	}

	private resolveModelContext(taskId?: string, fallback?: AiCodeModelContext): AiCodeModelContext | undefined {
		const fallbackContext = normalizeModelContext(fallback)
		const taskContext = taskId?.trim() ? this.taskModelContexts.get(taskId.trim()) : undefined
		return normalizeModelContext(taskContext) ?? fallbackContext
	}

	async recordAgentFileWrite(record: AgentFileWriteRecord): Promise<void> {
		const context = await this.resolveFileContext(record.cwd, record.filePath, record.relativePath)
		if (!context) {
			return
		}
		const proposedContent = record.proposedContent ?? record.newContent

		const blockAnalysis = this.analyzeAgentWriteBlocks({
			originalContent: record.originalContent,
			proposedContent,
			finalAcceptedContent: record.newContent,
			filePath: context.repoRelativePath,
		})
		if (blockAnalysis.acceptedBlocks.length === 0 && blockAnalysis.acceptedDeletedBlocks.length === 0) {
			return
		}
		const timestamp = Date.now()

		// kilocode_change start
		const settings = await this.getUploadSettings()
		const metadata = await this.metadataResolver.resolve(context.repoRoot, context.filePath, settings)
		const modelContext = this.resolveModelContext(record.taskId, record.modelContext)
		try {
			await AiTokenUsageService.getInstance()?.trackRepositoryForCommitUpload(context.repoRoot)
		} catch (error) {
			console.error("[AiCodeStats] Failed to track token usage commit trigger repository:", error)
		}
		// kilocode_change end

		const existingPendingBlocks = await this.getPendingGeneratedBlocksForContext(
			context.filePath,
			record.taskId,
			"agent_insert",
		)
		const existingAdditionBlocks = existingPendingBlocks.filter(
			(block) => (block.changeType ?? "addition") === "addition",
		)
		const existingDeletionBlocks = existingPendingBlocks.filter((block) => block.changeType === "deletion")
		const patchHunks = this.extractor.extractPatchHunks(
			record.originalContent,
			record.newContent,
			context.repoRelativePath,
		)
		const nextBlocks = this.buildGeneratedBlocksForSnapshot({
			existingPendingBlocks: existingAdditionBlocks,
			addedBlocks: blockAnalysis.acceptedBlocks,
			patchHunks,
			timestamp,
			finalContent: record.newContent,
			repoRoot: context.repoRoot,
			repoRelativePath: context.repoRelativePath,
			filePath: context.filePath,
			taskId: record.taskId,
			metadata,
			modelContext,
		})

		const deletionBlockStates = blockAnalysis.acceptedDeletedBlocks
			.filter((deletedBlock) => deletedBlock.codeSnippet.trim().length > 0)
			.map((deletedBlock) =>
				this.createDeletionBlockState({
					timestamp,
					filePath: context.filePath,
					repoRoot: context.repoRoot,
					repoRelativePath: context.repoRelativePath,
					taskId: record.taskId,
					metadata,
					modelContext,
					originalContent: record.originalContent,
					deletedBlock,
				}),
			)
		const deletionMetricBlocks = deletionBlockStates.map((block) =>
			this.createGeneratedMetricBlock({
				generatedBlockId: block.generatedBlockId,
				timestamp,
				sourceType: block.sourceType,
				filePath: block.filePath,
				repoRoot: block.repoRoot || context.repoRoot,
				repoRelativePath: block.repoRelativePath || context.repoRelativePath,
				taskId: block.taskId,
				metadata,
				modelContext,
				fileSnapshotContent: record.originalContent,
				lineStart: block.lineStart,
				lineEnd: block.lineEnd,
				codeSnippet: block.codeSnippet,
				changeType: "deletion",
			}),
		)
		await this.store.addPendingCommitMetricBlocks([...nextBlocks.metricBlocks, ...deletionMetricBlocks])

		const lineOccurrenceIndexes = buildLineOccurrenceIndexes(record.newContent)
		const pendingLineAttributions = nextBlocks.nextBlocks.flatMap((block) =>
			this.buildPendingLineAttributions(block, lineOccurrenceIndexes),
		)
		const originalLineOccurrenceIndexes =
			deletionBlockStates.length > 0 ? buildLineOccurrenceIndexes(record.originalContent) : []
		const deletionPendingLines = deletionBlockStates.flatMap((block) =>
			this.buildDeletionPendingLineAttributions(block, originalLineOccurrenceIndexes),
		)
		const carriedDeletionPendingLines = await this.getPendingDeletionLinesForContext(
			context.repoRoot,
			context.filePath,
			record.taskId,
			"agent_insert",
		)

		await this.store.replaceGeneratedStateForContext({
			filePath: context.filePath,
			taskId: record.taskId,
			sourceType: "agent_insert",
			nextBlocks: [...nextBlocks.nextBlocks, ...existingDeletionBlocks, ...deletionBlockStates],
			nextPendingLines: [...pendingLineAttributions, ...carriedDeletionPendingLines, ...deletionPendingLines],
		})
		await this.commitAttributionService.refreshRepoTracking(context.repoRoot)
	}

	async recordRejectedAgentSuggestion(record: AgentFileWriteRecord): Promise<void> {
		const context = await this.resolveFileContext(record.cwd, record.filePath, record.relativePath)
		if (!context) {
			return
		}
		const blocks = this.extractor.extractAddedBlocks(
			record.originalContent,
			record.newContent,
			context.repoRelativePath,
		)
		if (blocks.length === 0) {
			return
		}

		const settings = await this.getUploadSettings()
		const metadata = await this.metadataResolver.resolve(context.repoRoot, context.filePath, settings)
		const modelContext = this.resolveModelContext(record.taskId, record.modelContext)
		const timestamp = Date.now()
		const events = blocks
			.filter((block) => block.codeSnippet.trim().length > 0)
			.map(
				(block): AiCodeStatsEvent => ({
					eventId: crypto.randomUUID(),
					timestamp,
					semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
					sourceType: "agent_insert",
					ide: this.ide,
					metricType: "generated",
					userName: metadata.userName,
					departmentName: metadata.departmentName,
					officeName: metadata.officeName,
					teamName: metadata.teamName,
					userEmail: metadata.userEmail,
					organizationId: metadata.organizationId,
					organizationName: metadata.organizationName,
					sourceIp: metadata.sourceIp,
					provider: modelContext?.provider,
					model: modelContext?.model,
					projectKey: metadata.projectKey,
					projectName: metadata.projectName,
					repoRoot: context.repoRoot,
					repoRelativePath: context.repoRelativePath,
					filePath: context.filePath,
					relativePath: context.repoRelativePath,
					language: metadata.language,
					gitRemoteUrl: metadata.gitRemoteUrl,
					gitBranch: metadata.gitBranch,
					lineStart: block.lineStart,
					lineEnd: block.lineEnd,
					lineCount: block.lineCount,
					codeSnippet: block.codeSnippet,
					fileSnapshotContent: record.newContent,
					taskId: record.taskId,
				}),
			)

		await this.appendPendingMetricEvents(events)
	}

	async getVisibleCommitUploadRecords(): Promise<AiCodeCommitUploadRecord[]> {
		return this.store.getVisibleCommitUploadRecords()
	}

	async refreshCommitUploadStatus(): Promise<AiCodeCommitUploadRecord[]> {
		if (this.isScanningCommitUploads) {
			return this.store.getVisibleCommitUploadRecords()
		}

		this.isScanningCommitUploads = true
		try {
			await this.scanCommitUploadStatus()
		} finally {
			this.isScanningCommitUploads = false
		}
		return this.store.getVisibleCommitUploadRecords()
	}

	async retryCommitUpload(recordId: string): Promise<AiCodeCommitUploadRecord[]> {
		const record = await this.findCommitUploadRecord(recordId)
		if (!record) {
			return this.store.getVisibleCommitUploadRecords()
		}

		await this.store.markCommitUploadRecordStatus({
			reportId: record.reportId,
			commitHash: record.commitHash,
			repoRoot: record.repoRoot,
			status: "processing",
			lastError: undefined,
		})
		await this.store.appendDiagnosticEvent({
			type: "upload_retry_requested",
			commitHash: record.commitHash,
			reportId: record.reportId,
			repoRoot: record.repoRoot,
			status: "processing",
			details: {
				action: "retry",
				selectedReportId: record.reportId,
			},
		})
		await this.requestCommitTriggeredUpload(record.reportId, "retry")
		return this.refreshCommitUploadStatus()
	}

	async reanalyzeCommitUpload(recordId: string): Promise<AiCodeCommitUploadRecord[]> {
		const record = await this.findCommitUploadRecord(recordId)
		if (!record) {
			return this.store.getVisibleCommitUploadRecords()
		}

		const reportId = record.reportId ?? this.buildReplayReportId(record.repoRoot, record.commitHash)
		await this.store.upsertCommitUploadRecord({
			id: record.id,
			reportId,
			commitHash: record.commitHash,
			repoRoot: record.repoRoot,
			gitRemoteUrl: record.gitRemoteUrl,
			gitBranch: record.gitBranch,
			commitOccurredAt: record.commitOccurredAt,
			status: "processing",
			lastError: undefined,
			rawPayloadBytes: record.rawPayloadBytes,
			compressedPayloadBytes: record.compressedPayloadBytes,
			candidateBlockCount: record.candidateBlockCount,
			changedFileCount: record.changedFileCount,
			addedLineCount: record.addedLineCount,
			repoName: record.repoName,
		})
		await this.store.appendDiagnosticEvent({
			type: "reanalysis_started",
			commitHash: record.commitHash,
			reportId,
			repoRoot: record.repoRoot,
			status: "processing",
			details: {
				gitBranch: record.gitBranch,
			},
		})

		try {
			const facts = await this.commitAttributionService.collectCommitFactsForReplay(
				record.repoRoot,
				record.commitHash,
				record.gitBranch,
			)
			await this.handleCommitCollected(facts, {
				reportId,
				includeUploadedBlocks: true,
				skipImmediateUpload: true,
			})
			const queuedReports = await this.store.getQueuedCommitReports()
			if (!queuedReports.some((queued) => queued.report.reportId === reportId)) {
				throw new Error("无法重新分析：本地候选数据不足或提交改动路径未命中")
			}
			await this.requestCommitTriggeredUpload(reportId, "reanalysis")
			const stillQueued = (await this.store.getQueuedCommitReports()).some(
				(queued) => queued.report.reportId === reportId,
			)
			if (stillQueued) {
				return this.store.getVisibleCommitUploadRecords()
			}
			await this.store.appendDiagnosticEvent({
				type: "reanalysis_uploaded",
				commitHash: record.commitHash,
				reportId,
				repoRoot: record.repoRoot,
				status: "uploaded",
			})
			await this.confirmSingleCommitStatus(record.repoRoot, record.commitHash, reportId)
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			await this.store.markCommitUploadRecordStatus({
				reportId,
				commitHash: record.commitHash,
				repoRoot: record.repoRoot,
				status: "reanalysis_failed",
				lastError: errorMessage,
			})
			await this.store.appendDiagnosticEvent({
				type: "reanalysis_failed",
				commitHash: record.commitHash,
				reportId,
				repoRoot: record.repoRoot,
				status: "reanalysis_failed",
				message: errorMessage,
			})
		}

		return this.refreshCommitUploadStatus()
	}

	async exportCommitUploadDiagnostics(recordId?: string): Promise<string> {
		const diagnostics = await this.store.getCommitUploadDiagnostics(recordId)
		const exportDir = path.join(this.globalStoragePath, "ai-code-stats", "diagnostics")
		await fs.mkdir(exportDir, { recursive: true })
		const outputPath = path.join(exportDir, `commit-upload-diagnostics-${Date.now()}.json`)
		await fs.writeFile(
			outputPath,
			JSON.stringify(
				{
					exportedAt: new Date().toISOString(),
					client: this.buildUploadClient(),
					records: diagnostics.records.map((record) => this.redactCommitUploadRecord(record)),
					events: diagnostics.events.map((event) => ({
						...event,
						repoRoot: event.repoRoot ? this.redactRepoRoot(event.repoRoot) : undefined,
					})),
				},
				null,
				2,
			),
			"utf8",
		)
		return outputPath
	}

	private async scanCommitUploadStatus(): Promise<void> {
		const settings = await this.getUploadSettings()
		if (!settings.webhookUrl?.trim() || !settings.userEmail?.trim()) {
			return
		}

		const [generatedBlocks, queuedReports, existingRecords] = await Promise.all([
			this.store.getGeneratedBlockStates(),
			this.store.getQueuedCommitReports(),
			this.store.getCommitUploadRecords(),
		])
		const candidateBlocks = generatedBlocks.filter(
			(block) => block.repoRoot && (block.uploadStatus === "pending" || block.uploadStatus === "uploaded"),
		)
		const repoRoots = new Set<string>()
		for (const block of candidateBlocks) {
			if (block.repoRoot) {
				repoRoots.add(normalizePath(block.repoRoot))
			}
		}
		for (const record of existingRecords) {
			if (
				[
					"upload_failed",
					"auto_reanalysis_pending",
					"reanalysis_failed",
					"processing",
					"server_failed",
				].includes(record.status)
			) {
				repoRoots.add(normalizePath(record.repoRoot))
			}
		}
		if (repoRoots.size === 0) {
			return
		}

		const queuedCommitKeys = new Set(
			queuedReports.map((queued) => `${normalizePath(queued.report.repoRoot)}::${queued.report.commitHash}`),
		)
		const client = this.buildUploadClient()
		const statusTargetDetails = this.buildUploadTargetDiagnostics(settings, "status")
		for (const repoRoot of repoRoots) {
			const blocksForRepo = candidateBlocks.filter((block) => block.repoRoot === repoRoot)
			const summaries = await this.listRecentCommitSummaries(repoRoot).catch(async (error) => {
				await this.store.appendDiagnosticEvent({
					type: "report_skipped",
					repoRoot,
					message: error instanceof Error ? error.message : String(error),
					details: {
						reason: "list_recent_commits_failed",
					},
				})
				return [] as LocalCommitSummary[]
			})
			const existingForRepo = existingRecords.filter((record) => normalizePath(record.repoRoot) === repoRoot)
			const summaryByHash = new Map(summaries.map((summary) => [summary.commitHash, summary]))
			const commitsToQuery = new Map<string, LocalCommitSummary>()
			for (const summary of summaries) {
				if (!this.hasRetainedCandidateForCommit(blocksForRepo, summary)) {
					continue
				}
				commitsToQuery.set(summary.commitHash, summary)
			}
			for (const record of existingForRepo) {
				if (!commitsToQuery.has(record.commitHash)) {
					commitsToQuery.set(
						record.commitHash,
						summaryByHash.get(record.commitHash) ?? {
							commitHash: record.commitHash,
							commitOccurredAt: record.commitOccurredAt,
							changedPaths: new Set<string>(),
							addedLineCount: record.addedLineCount,
							changedFileCount: record.changedFileCount,
						},
					)
				}
			}
			const limitedCommits = [...commitsToQuery.values()].slice(0, COMMIT_UPLOAD_SCAN_VISIBLE_LIMIT)
			if (limitedCommits.length === 0) {
				continue
			}

			let statuses: AiCodeCommitServerStatus[] = []
			try {
				statuses = await this.uploader.queryCommitStatuses(settings, {
					client,
					userEmail: settings.userEmail,
					commits: limitedCommits.map((summary) => ({
						commitHash: summary.commitHash,
						reportId: existingForRepo.find((record) => record.commitHash === summary.commitHash)?.reportId,
						gitRemoteUrl: blocksForRepo.find((block) => block.gitRemoteUrl)?.gitRemoteUrl,
						gitBranch: blocksForRepo.find((block) => block.gitBranch)?.gitBranch,
					})),
				})
				await this.store.appendDiagnosticEvent({
					type: "server_status_checked",
					repoRoot,
					details: {
						commitCount: limitedCommits.length,
						...statusTargetDetails,
						statuses: statuses.map((status) => ({
							commitHash: status.commitHash,
							status: status.status,
							reportId: status.reportId,
						})),
					},
				})
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				const failureDiagnostics = this.mergeFailureDiagnostics(
					buildUploadFailureDiagnostics(message),
					statusTargetDetails,
				)
				await this.store.appendDiagnosticEvent({
					type: "server_status_checked",
					repoRoot,
					message,
					details: {
						commitCount: limitedCommits.length,
						failed: true,
						...failureDiagnostics,
					},
				})
				continue
			}

			const statusByCommit = new Map(statuses.map((status) => [status.commitHash, status]))
			for (const summary of limitedCommits) {
				const serverStatus = statusByCommit.get(summary.commitHash)
				if (!serverStatus) {
					continue
				}
				await this.applyServerCommitStatus({
					repoRoot,
					summary,
					serverStatus,
					hasQueuedReport: queuedCommitKeys.has(`${repoRoot}::${summary.commitHash}`),
					existingRecord: existingForRepo.find((record) => record.commitHash === summary.commitHash),
					referenceBlock: blocksForRepo.find((block) => {
						const repoRelativePath = normalizePath(block.repoRelativePath || block.relativePath || "")
						return (
							this.hasRetainedCandidateForCommit([block], summary) &&
							(summary.changedPaths.size === 0 || summary.changedPaths.has(repoRelativePath))
						)
					}),
				})
			}
		}
	}

	private async applyServerCommitStatus(params: {
		repoRoot: string
		summary: LocalCommitSummary
		serverStatus: AiCodeCommitServerStatus
		hasQueuedReport: boolean
		existingRecord?: AiCodeCommitUploadRecord
		referenceBlock?: AiCodeGeneratedBlockState
	}): Promise<void> {
		const { repoRoot, summary, serverStatus, hasQueuedReport, existingRecord, referenceBlock } = params
		if (serverStatus.status === "NOT_RECEIVED") {
			if (hasQueuedReport && existingRecord?.status !== "auto_reanalysis_pending") {
				return
			}
			await this.runAutomaticCommitReanalysis({
				repoRoot,
				summary,
				existingRecord,
				referenceBlock,
			})
			return
		}

		if (serverStatus.status === "ATTRIBUTION_FAILED") {
			await this.store.upsertCommitUploadRecord({
				id: this.buildCommitUploadRecordId(repoRoot, summary.commitHash, serverStatus.reportId ?? undefined),
				commitHash: summary.commitHash,
				repoRoot,
				gitRemoteUrl: referenceBlock?.gitRemoteUrl,
				gitBranch: referenceBlock?.gitBranch,
				commitOccurredAt: summary.commitOccurredAt,
				status: "server_failed",
				reportId: serverStatus.reportId ?? undefined,
				lastError: serverStatus.message ?? "服务端归因失败",
				changedFileCount: summary.changedFileCount,
				addedLineCount: summary.addedLineCount,
				repoName: path.basename(repoRoot),
			})
			return
		}

		await this.store.markCommitUploadRecordStatus({
			reportId: serverStatus.reportId ?? undefined,
			commitHash: summary.commitHash,
			repoRoot,
			status: "uploaded",
			lastError: undefined,
		})
	}

	private async runAutomaticCommitReanalysis(params: {
		repoRoot: string
		summary: LocalCommitSummary
		existingRecord?: AiCodeCommitUploadRecord
		referenceBlock?: AiCodeGeneratedBlockState
	}): Promise<void> {
		const { repoRoot, summary, existingRecord, referenceBlock } = params
		const now = Date.now()
		const reportId = existingRecord?.reportId?.startsWith("replay-")
			? existingRecord.reportId
			: this.buildReplayReportId(repoRoot, summary.commitHash)
		const currentRetryCount = existingRecord?.autoRetryCount ?? 0
		if (existingRecord?.status === "reanalysis_failed" && currentRetryCount >= AUTO_REANALYSIS_MAX_ATTEMPTS) {
			return
		}
		if (existingRecord?.nextAutoRetryAt && existingRecord.nextAutoRetryAt > now) {
			await this.store.appendDiagnosticEvent({
				type: "auto_reanalysis_deferred",
				commitHash: summary.commitHash,
				reportId,
				repoRoot,
				status: "auto_reanalysis_pending",
				details: {
					nextAutoRetryAt: existingRecord.nextAutoRetryAt,
					autoRetryCount: currentRetryCount,
				},
			})
			return
		}

		const attempt = Math.min(currentRetryCount + 1, AUTO_REANALYSIS_MAX_ATTEMPTS)
		await this.store.upsertCommitUploadRecord({
			id: this.buildCommitUploadRecordId(repoRoot, summary.commitHash, reportId),
			commitHash: summary.commitHash,
			repoRoot,
			gitRemoteUrl: referenceBlock?.gitRemoteUrl ?? existingRecord?.gitRemoteUrl,
			gitBranch: referenceBlock?.gitBranch ?? existingRecord?.gitBranch,
			commitOccurredAt: summary.commitOccurredAt,
			status: "auto_reanalysis_pending",
			reportId,
			lastError: undefined,
			candidateBlockCount: existingRecord?.candidateBlockCount,
			changedFileCount: summary.changedFileCount,
			addedLineCount: summary.addedLineCount,
			repoName: path.basename(repoRoot),
			autoRetryCount: attempt,
			autoRetryStartedAt: existingRecord?.autoRetryStartedAt ?? now,
			nextAutoRetryAt: undefined,
			autoRetryExhaustedAt: undefined,
			lastAttemptAt: now,
		})
		await this.store.appendDiagnosticEvent({
			type: "auto_reanalysis_started",
			commitHash: summary.commitHash,
			reportId,
			repoRoot,
			status: "auto_reanalysis_pending",
			details: {
				autoRetryCount: attempt,
				addedLineCount: summary.addedLineCount,
				changedFileCount: summary.changedFileCount,
			},
		})

		try {
			const facts = await this.commitAttributionService.collectCommitFactsForReplay(
				repoRoot,
				summary.commitHash,
				referenceBlock?.gitBranch ?? existingRecord?.gitBranch,
			)
			await this.handleCommitCollected(facts, {
				reportId,
				includeUploadedBlocks: true,
				skipImmediateUpload: true,
			})
			const queuedReports = await this.store.getQueuedCommitReports()
			if (!queuedReports.some((queued) => queued.report.reportId === reportId)) {
				await this.store.markCommitUploadRecordStatus({
					reportId,
					commitHash: summary.commitHash,
					repoRoot,
					status: "needs_reanalysis",
					lastError: "本地候选数据不足或提交改动行未命中 AI 代码",
					autoRetryCount: attempt,
					autoRetryStartedAt: existingRecord?.autoRetryStartedAt ?? now,
				})
				await this.store.appendDiagnosticEvent({
					type: "auto_reanalysis_skipped",
					commitHash: summary.commitHash,
					reportId,
					repoRoot,
					status: "needs_reanalysis",
					details: {
						reason: "local_candidates_insufficient",
						addedLineCount: summary.addedLineCount,
						changedFileCount: summary.changedFileCount,
					},
				})
				return
			}

			await this.requestCommitTriggeredUpload(reportId, "reanalysis")
			const stillQueued = (await this.store.getQueuedCommitReports()).some(
				(queued) => queued.report.reportId === reportId,
			)
			if (stillQueued) {
				const failedRecord = (await this.store.getCommitUploadRecords()).find(
					(record) => record.reportId === reportId && record.commitHash === summary.commitHash,
				)
				await this.scheduleNextAutomaticReanalysisAttempt({
					repoRoot,
					commitHash: summary.commitHash,
					reportId,
					attempt,
					lastError: failedRecord?.lastError,
				})
				return
			}

			await this.store.appendDiagnosticEvent({
				type: "auto_reanalysis_uploaded",
				commitHash: summary.commitHash,
				reportId,
				repoRoot,
				status: "uploaded",
				details: {
					autoRetryCount: attempt,
				},
			})
			await this.confirmSingleCommitStatus(repoRoot, summary.commitHash, reportId)
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			await this.scheduleNextAutomaticReanalysisAttempt({
				repoRoot,
				commitHash: summary.commitHash,
				reportId,
				attempt,
				lastError: message,
			})
			await this.store.appendDiagnosticEvent({
				type: "auto_reanalysis_failed",
				commitHash: summary.commitHash,
				reportId,
				repoRoot,
				status: "auto_reanalysis_pending",
				message,
				details: {
					autoRetryCount: attempt,
				},
			})
		}
	}

	private async scheduleNextAutomaticReanalysisAttempt(params: {
		repoRoot: string
		commitHash: string
		reportId: string
		attempt: number
		lastError?: string
	}): Promise<void> {
		const now = Date.now()
		if (params.attempt >= AUTO_REANALYSIS_MAX_ATTEMPTS) {
			await this.store.markCommitUploadRecordStatus({
				reportId: params.reportId,
				commitHash: params.commitHash,
				repoRoot: params.repoRoot,
				status: "reanalysis_failed",
				lastError: params.lastError,
				autoRetryCount: params.attempt,
				nextAutoRetryAt: undefined,
				autoRetryExhaustedAt: now,
			})
			return
		}
		const nextDelayMs =
			AUTO_REANALYSIS_BACKOFF_MS[params.attempt] ??
			AUTO_REANALYSIS_BACKOFF_MS[AUTO_REANALYSIS_BACKOFF_MS.length - 1]
		await this.store.markCommitUploadRecordStatus({
			reportId: params.reportId,
			commitHash: params.commitHash,
			repoRoot: params.repoRoot,
			status: "auto_reanalysis_pending",
			lastError: params.lastError,
			autoRetryCount: params.attempt,
			nextAutoRetryAt: now + nextDelayMs,
		})
	}

	private async confirmSingleCommitStatus(repoRoot: string, commitHash: string, reportId?: string): Promise<void> {
		const settings = await this.getUploadSettings()
		if (!settings.webhookUrl?.trim() || !settings.userEmail?.trim()) {
			return
		}
		const statuses = await this.uploader.queryCommitStatuses(settings, {
			client: this.buildUploadClient(),
			userEmail: settings.userEmail,
			commits: [
				{
					commitHash,
					reportId,
				},
			],
		})
		const status = statuses.find((item) => item.commitHash === commitHash)
		if (!status || status.status === "NOT_RECEIVED") {
			return
		}
		if (status.status === "ATTRIBUTION_FAILED") {
			await this.store.markCommitUploadRecordStatus({
				reportId,
				commitHash,
				repoRoot,
				status: "server_failed",
				lastError: status.message ?? "服务端归因失败",
			})
			return
		}
		await this.store.markCommitUploadRecordStatus({
			reportId,
			commitHash,
			repoRoot,
			status: "uploaded",
			lastError: undefined,
		})
	}

	private async findCommitUploadRecord(recordId: string): Promise<AiCodeCommitUploadRecord | undefined> {
		return (await this.store.getCommitUploadRecords()).find((record) => record.id === recordId)
	}

	private buildReplayReportId(repoRoot: string, commitHash: string): string {
		const digest = crypto
			.createHash("sha256")
			.update(`${vscode.env.machineId}|${normalizePath(path.resolve(repoRoot))}|${commitHash}`)
			.digest("hex")
		return `replay-${digest}`.slice(0, 64)
	}

	private buildCommitUploadRecordId(repoRoot: string, commitHash: string, reportId?: string): string {
		return `${normalizePath(path.resolve(repoRoot))}::${commitHash.trim()}::${reportId?.trim() || "commit"}`
	}

	private redactCommitUploadRecord(record: AiCodeCommitUploadRecord): AiCodeCommitUploadRecord {
		return {
			...record,
			repoRoot: this.redactRepoRoot(record.repoRoot),
		}
	}

	private redactRepoRoot(repoRoot: string): string {
		return path.basename(normalizePath(repoRoot)) || "repo"
	}

	private async listRecentCommitSummaries(repoRoot: string): Promise<LocalCommitSummary[]> {
		const since = new Date(Date.now() - COMMIT_UPLOAD_SCAN_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString()
		const { stdout } = await execAsync(
			`git rev-list --max-count=${COMMIT_UPLOAD_SCAN_MAX_COMMITS} --since=${JSON.stringify(since)} HEAD`,
			{
				cwd: repoRoot,
				maxBuffer: EXEC_MAX_BUFFER_BYTES,
			},
		)
		const commitHashes = stdout
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean)
		const summaries: LocalCommitSummary[] = []
		for (const commitHash of commitHashes) {
			summaries.push(await this.loadCommitSummary(repoRoot, commitHash))
		}
		return summaries
	}

	private async loadCommitSummary(repoRoot: string, commitHash: string): Promise<LocalCommitSummary> {
		const { stdout } = await execAsync(`git show --format=%ct --numstat --find-renames ${commitHash}`, {
			cwd: repoRoot,
			maxBuffer: EXEC_MAX_BUFFER_BYTES,
		})
		const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0)
		const seconds = Number.parseInt(lines[0] ?? "", 10)
		const changedPaths = new Set<string>()
		let addedLineCount = 0
		let changedFileCount = 0
		for (const line of lines.slice(1)) {
			const parts = line.split("\t")
			if (parts.length < 3) {
				continue
			}
			const additions = Number.parseInt(parts[0], 10)
			if (Number.isFinite(additions)) {
				addedLineCount += additions
			}
			for (const changedPath of this.expandNumstatPath(parts.slice(2).join("\t"))) {
				changedPaths.add(changedPath)
			}
			changedFileCount += 1
		}
		return {
			commitHash,
			commitOccurredAt: Number.isFinite(seconds) ? seconds * 1000 : undefined,
			changedPaths,
			addedLineCount,
			changedFileCount,
		}
	}

	private expandNumstatPath(rawPath: string): string[] {
		const normalized = normalizePath(rawPath.trim())
		if (!normalized) {
			return []
		}
		if (!normalized.includes(" => ")) {
			return [normalized]
		}
		return [
			normalized,
			normalized.replace(/^.* => /, "").replace(/[{}]/g, ""),
			normalized.replace(/ => .*$/, "").replace(/[{}]/g, ""),
		].filter(Boolean)
	}

	private hasRetainedCandidateForCommit(blocks: AiCodeGeneratedBlockState[], summary: LocalCommitSummary): boolean {
		return blocks.some((block) => {
			if (this.isAfterCommitTimestamp(block.timestamp, summary.commitOccurredAt)) {
				return false
			}
			const repoRelativePath = normalizePath(block.repoRelativePath || block.relativePath || "")
			if (summary.changedPaths.size === 0) {
				return true
			}
			return Boolean(repoRelativePath && summary.changedPaths.has(repoRelativePath))
		})
	}

	private isAfterCommitTimestamp(timestamp: number | undefined, commitOccurredAt?: number): boolean {
		return (
			typeof timestamp === "number" &&
			typeof commitOccurredAt === "number" &&
			timestamp > commitOccurredAt + COMMIT_TIMESTAMP_MATCH_SKEW_MS
		)
	}

	private async resolveFileContext(
		cwd: string,
		filePath: string,
		_relativePath?: string,
	): Promise<ResolvedFileContext | undefined> {
		const resolvedInputPath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath)
		const resolvedFilePath = await resolveFilePathFromParent(resolvedInputPath)
		const repoRoot =
			(await resolveGitRepositoryRoot(path.dirname(resolvedFilePath))) ?? (await resolveGitRepositoryRoot(cwd))
		if (!repoRoot || !this.isPathInsideRepo(repoRoot, resolvedFilePath)) {
			return undefined
		}
		const repoRelativePath = normalizePath(path.relative(repoRoot, resolvedFilePath))
		return {
			filePath: resolvedFilePath,
			relativePath: repoRelativePath,
			repoRoot,
			repoRelativePath,
		}
	}

	private analyzeAgentWriteBlocks(params: {
		originalContent: string
		proposedContent: string
		finalAcceptedContent: string
		filePath: string
	}): AgentWriteBlockAnalysis {
		const proposedGeneratedBlocks = this.extractor.extractAddedBlocks(
			params.originalContent,
			params.proposedContent,
			params.filePath,
		)
		const proposedDeletedBlocks = this.extractor.extractDeletedBlocks(
			params.originalContent,
			params.proposedContent,
			params.filePath,
		)

		const acceptedBlocks =
			proposedGeneratedBlocks.length > 0
				? this.extractor.extractAddedBlocks(
						params.originalContent,
						params.finalAcceptedContent,
						params.filePath,
					)
				: []
		const acceptedDeletedBlocks =
			proposedDeletedBlocks.length > 0
				? this.extractor.extractDeletedBlocks(
						params.originalContent,
						params.finalAcceptedContent,
						params.filePath,
					)
				: []

		return {
			acceptedBlocks,
			acceptedDeletedBlocks,
		}
	}

	private createDeletionBlockState(params: {
		timestamp: number
		filePath: string
		repoRoot: string
		repoRelativePath: string
		taskId?: string
		metadata: Awaited<ReturnType<AiCodeStatsMetadataResolver["resolve"]>>
		modelContext?: AiCodeModelContext
		originalContent: string
		deletedBlock: AiCodeAddedCodeBlock
	}): AiCodeGeneratedBlockState {
		const generatedBlockId = crypto.randomUUID()
		const stateId = crypto.randomUUID()
		const codeSnippet = params.deletedBlock.codeSnippet
		return {
			stateId,
			eventId: stateId,
			generatedBlockId,
			timestamp: params.timestamp,
			semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
			sourceType: "agent_insert",
			ide: this.ide,
			changeType: "deletion",
			userName: params.metadata.userName,
			departmentName: params.metadata.departmentName,
			officeName: params.metadata.officeName,
			teamName: params.metadata.teamName,
			userEmail: params.metadata.userEmail,
			organizationId: params.metadata.organizationId,
			organizationName: params.metadata.organizationName,
			sourceIp: params.metadata.sourceIp,
			provider: params.modelContext?.provider,
			model: params.modelContext?.model,
			projectKey: params.metadata.projectKey,
			projectName: params.metadata.projectName,
			filePath: params.filePath,
			relativePath: params.repoRelativePath,
			repoRoot: params.repoRoot,
			repoRelativePath: params.repoRelativePath,
			language: params.metadata.language,
			gitRemoteUrl: params.metadata.gitRemoteUrl,
			gitBranch: params.metadata.gitBranch,
			lineStart: params.deletedBlock.lineStart,
			lineEnd: params.deletedBlock.lineEnd,
			lineCount: params.deletedBlock.lineCount,
			codeSnippet,
			fileSnapshotContent: params.originalContent,
			originEventId: `${stateId}:generated`,
			originTimestamp: params.timestamp,
			originLineStart: params.deletedBlock.lineStart,
			originLineEnd: params.deletedBlock.lineEnd,
			originLineCount: params.deletedBlock.lineCount,
			originCodeSnippet: codeSnippet,
			originFileSnapshotContent: params.originalContent,
			currentTimestamp: params.timestamp,
			currentLineStart: params.deletedBlock.lineStart,
			currentLineEnd: params.deletedBlock.lineEnd,
			currentLineCount: params.deletedBlock.lineCount,
			currentCodeSnippet: codeSnippet,
			currentFileSnapshotContent: params.originalContent,
			taskId: params.taskId,
			uploadStatus: "pending",
		}
	}

	private buildDeletionPendingLineAttributions(
		block: AiCodeGeneratedBlockState,
		originalLineOccurrenceIndexes: number[],
	): AiCodePendingLineAttribution[] {
		const lines = normalizeContentLines(block.codeSnippet)

		return lines.map((line, index) => {
			const lineNumber = block.lineStart + index
			const occurrenceIndex = originalLineOccurrenceIndexes[lineNumber - 1] ?? index + 1
			return {
				id: crypto.randomUUID(),
				generatedEventId: block.generatedBlockId,
				blockId: block.generatedBlockId,
				timestamp: block.timestamp,
				sourceType: block.sourceType,
				ide: block.ide,
				userName: block.userName,
				departmentName: block.departmentName,
				officeName: block.officeName,
				teamName: block.teamName,
				userEmail: block.userEmail,
				organizationId: block.organizationId,
				organizationName: block.organizationName,
				sourceIp: block.sourceIp,
				provider: block.provider,
				model: block.model,
				projectKey: block.projectKey,
				projectName: block.projectName,
				filePath: block.filePath,
				relativePath: block.relativePath,
				repoRoot: block.repoRoot || "",
				repoRelativePath: block.repoRelativePath || block.relativePath,
				language: block.language,
				gitRemoteUrl: block.gitRemoteUrl,
				gitBranch: block.gitBranch,
				taskId: block.taskId,
				rawLine: line,
				blockLineIndex: index + 1,
				blockLineCount: lines.length,
				lineHash: hashLineFingerprint(line),
				occurrenceIndex,
				changeType: "deletion",
				lineNumber,
			}
		})
	}

	private async getPendingDeletionLinesForContext(
		repoRoot: string,
		filePath: string,
		taskId: string | undefined,
		sourceType: AiCodePendingLineAttribution["sourceType"],
	): Promise<AiCodePendingLineAttribution[]> {
		const normalizedFilePath = normalizePath(path.resolve(filePath))
		const normalizedTaskId = taskId?.trim() || ""
		const pendingLines = await this.store.getPendingLineAttributions(repoRoot)
		return pendingLines.filter(
			(line) =>
				line.changeType === "deletion" &&
				normalizePath(path.resolve(line.filePath)) === normalizedFilePath &&
				(line.taskId?.trim() || "") === normalizedTaskId &&
				line.sourceType === sourceType,
		)
	}

	private buildPendingLineAttributions(
		block: AiCodeGeneratedBlockState,
		lineOccurrenceIndexes: number[],
	): AiCodePendingLineAttribution[] {
		const lines = normalizeContentLines(block.codeSnippet)

		return lines.map((line, index) => {
			const lineNumber = block.lineStart + index
			const occurrenceIndex = lineOccurrenceIndexes[lineNumber - 1] ?? index + 1
			return {
				id: crypto.randomUUID(),
				generatedEventId: block.generatedBlockId,
				blockId: block.generatedBlockId,
				timestamp: block.timestamp,
				sourceType: block.sourceType,
				ide: block.ide,
				userName: block.userName,
				departmentName: block.departmentName,
				officeName: block.officeName,
				teamName: block.teamName,
				userEmail: block.userEmail,
				organizationId: block.organizationId,
				organizationName: block.organizationName,
				sourceIp: block.sourceIp,
				provider: block.provider,
				model: block.model,
				projectKey: block.projectKey,
				projectName: block.projectName,
				filePath: block.filePath,
				relativePath: block.relativePath,
				repoRoot: block.repoRoot || "",
				repoRelativePath: block.repoRelativePath || block.relativePath,
				language: block.language,
				gitRemoteUrl: block.gitRemoteUrl,
				gitBranch: block.gitBranch,
				taskId: block.taskId,
				rawLine: line,
				blockLineIndex: index + 1,
				blockLineCount: lines.length,
				lineHash: hashLineFingerprint(line),
				occurrenceIndex,
			}
		})
	}

	private async handleCommitCollected(
		payload: AiCodeCommitFactsPayload,
		options: CommitReportBuildOptions = {},
	): Promise<void> {
		const selection = await this.selectCommitCandidateBlocks(payload)
		const changedPathSet = selection.changedPathSet
		const candidateGeneratedBlocks = selection.candidateBlocks
		if (candidateGeneratedBlocks.length === 0 && payload.changedFiles.length === 0) {
			return
		}

		const referenceBlock = candidateGeneratedBlocks[0]
		if (!referenceBlock) {
			return
		}
		const reportBranch = payload.branch || referenceBlock.gitBranch
		const reportBaselineBlocks = await this.buildCommitReportBaselineBlocks({
			pendingGeneratedBlocks: candidateGeneratedBlocks,
			commitOccurredAt: payload.commitOccurredAt,
			gitBranch: reportBranch,
			includeUploadedBlocks: Boolean(options.includeUploadedBlocks),
		})
		const reportAcceptedBlocks = reportBaselineBlocks.acceptedBlocks
		const candidateLines = await this.buildCommitReportCandidateLines({
			repoRoot: payload.repoRoot,
			changedPathSet,
			pendingGeneratedBlocks: candidateGeneratedBlocks,
			acceptedBlocks: reportAcceptedBlocks,
			generatedBlocks: reportBaselineBlocks.generatedBlocks,
			gitBranch: reportBranch,
			commitHash: payload.commitHash,
			addedLineHashesByPath: selection.addedLineHashesByPath,
			deletedLineHashesByPath: selection.deletedLineHashesByPath,
		})

		const reportGeneratedAt = Date.now()
		const report: AiCodeCommitReport = {
			version: "v2",
			source: "kilocode-ai-code-stats",
			mode: "commit_report",
			semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
			attributionInputVersion: 1,
			reportId: options.reportId ?? crypto.randomUUID(),
			reportGeneratedAt,
			client: this.buildUploadClient(),
			repoRoot: payload.repoRoot,
			projectKey: referenceBlock.projectKey,
			projectName: referenceBlock.projectName,
			gitRemoteUrl: referenceBlock.gitRemoteUrl,
			gitBranch: reportBranch,
			commitHash: payload.commitHash,
			previousCommitHash: payload.previousCommit || undefined,
			commitOccurredAt: payload.commitOccurredAt,
			authorName: payload.authorName,
			authorEmail: payload.authorEmail,
			committerName: payload.committerName,
			committerEmail: payload.committerEmail,
			generatedBlocks: reportBaselineBlocks.generatedBlocks,
			acceptedBlocks: reportAcceptedBlocks,
			changedFiles: payload.changedFiles.map((file) => ({
				...file,
				filePath: normalizePath(file.filePath),
				previousFilePath: file.previousFilePath ? normalizePath(file.previousFilePath) : undefined,
				relativePath: normalizePath(file.relativePath),
				changedBlocks: (file.changedBlocks || []).map((block) => ({
					startLine: block.startLine,
					endLine: block.endLine,
					lineCount: block.lineCount,
					codeSnippet: block.codeSnippet,
					displayOrder: block.displayOrder,
				})),
				addedLines: (file.addedLines || []).map((line) => ({
					addedIndex: line.addedIndex,
					lineNumber: line.lineNumber,
					content: line.content,
					lineHash: line.lineHash,
				})),
				deletedLines: (file.deletedLines || []).map((line) => ({
					deletedIndex: line.deletedIndex,
					lineNumber: line.lineNumber,
					content: line.content,
					lineHash: line.lineHash,
					occurrenceIndex: line.occurrenceIndex,
				})),
			})),
			candidateLines,
		}

		await this.store.appendDiagnosticEvent({
			type: "commit_detected",
			commitHash: payload.commitHash,
			reportId: report.reportId,
			repoRoot: payload.repoRoot,
			details: {
				changedFileCount: report.changedFiles.length,
				addedLineCount: report.changedFiles.reduce((total, file) => total + (file.addedLines?.length ?? 0), 0),
				deletedLineCount: report.changedFiles.reduce(
					(total, file) => total + (file.deletedLines?.length ?? 0),
					0,
				),
				candidateBlockCount: candidateGeneratedBlocks.length,
				candidateLineCount: candidateLines.length,
				replay: Boolean(options.includeUploadedBlocks),
			},
		})
		await this.store.queueCommitReport({
			report,
			createdAt: reportGeneratedAt,
			generatedBlockIds: candidateGeneratedBlocks.map((block) => block.generatedBlockId),
		})
		await this.store.appendDiagnosticEvent({
			type: "report_queued",
			commitHash: payload.commitHash,
			reportId: report.reportId,
			repoRoot: payload.repoRoot,
			status: "queued",
		})
		if (!options.skipImmediateUpload) {
			await this.requestCommitTriggeredUpload()
		}
	}

	private async handleCommitLifecycleObserved(payload: AiCodeCommitLifecycleReport): Promise<void> {
		const createdAt = Date.now()
		await this.store.queueCommitLifecycleReport({
			report: {
				...payload,
				client: payload.client ?? this.buildUploadClient(),
				reportedAt: payload.reportedAt || createdAt,
			},
			createdAt,
		})
		await this.store.appendDiagnosticEvent({
			type: "lifecycle_report_queued",
			commitHash: payload.oldCommitHash ?? payload.newCommitHash ?? payload.commitHashes?.[0],
			reportId: payload.reportId,
			repoRoot: payload.repoRoot,
			status: "queued",
			details: {
				eventId: payload.eventId,
				eventType: payload.eventType,
				reason: payload.reason,
				confidence: payload.confidence,
				commitHashes: payload.commitHashes,
				replacementCommitHashes: payload.replacementCommitHashes,
			},
		})
		await this.requestCommitTriggeredUpload()
	}

	private async selectCommitCandidateBlocks(payload: AiCodeCommitFactsPayload): Promise<CommitCandidateSelection> {
		const changedPathSet = this.buildCommitChangedPathSet(payload)
		const addedLineHashesByPath = this.buildChangedLineHashesByPath(payload, "addition")
		const deletedLineHashesByPath = this.buildChangedLineHashesByPath(payload, "deletion")
		const normalizedRepoRoot = normalizePath(payload.repoRoot)
		const allBlocks = (await this.store.getGeneratedBlockStates()).filter(
			(block) => block.repoRoot === normalizedRepoRoot || block.repoRoot === payload.repoRoot,
		)
		const pendingLines = await this.store.getPendingLineAttributions(payload.repoRoot)
		const uploadedBlockIdsWithAddedLineMatch = new Set<string>()
		for (const pendingLine of pendingLines) {
			if (this.isAfterCommitTimestamp(pendingLine.timestamp, payload.commitOccurredAt)) {
				continue
			}
			const generatedBlockId = normalizeGeneratedBlockId(pendingLine.generatedEventId || pendingLine.blockId)
			if (!generatedBlockId) {
				continue
			}
			const repoRelativePath = normalizePath(pendingLine.repoRelativePath || pendingLine.relativePath || "")
			if (!repoRelativePath || !changedPathSet.has(repoRelativePath)) {
				continue
			}
			const matchHashes =
				pendingLine.changeType === "deletion"
					? deletedLineHashesByPath.get(repoRelativePath)
					: addedLineHashesByPath.get(repoRelativePath)
			if (matchHashes?.has(pendingLine.lineHash)) {
				uploadedBlockIdsWithAddedLineMatch.add(generatedBlockId)
			}
		}

		const candidateBlocks = allBlocks.filter((block) => {
			if (block.uploadStatus !== "pending" && block.uploadStatus !== "uploaded") {
				return false
			}
			if (this.isAfterCommitTimestamp(block.timestamp, payload.commitOccurredAt)) {
				return false
			}
			const repoRelativePath = normalizePath(block.repoRelativePath || block.relativePath || "")
			const changedPathMatches =
				changedPathSet.size === 0 || Boolean(repoRelativePath && changedPathSet.has(repoRelativePath))
			if (block.uploadStatus === "pending") {
				return changedPathMatches
			}
			if (!repoRelativePath || !changedPathSet.has(repoRelativePath)) {
				return false
			}
			return (
				uploadedBlockIdsWithAddedLineMatch.has(block.generatedBlockId) ||
				this.generatedBlockHasChangedLineMatch(block, addedLineHashesByPath, deletedLineHashesByPath)
			)
		})

		return {
			changedPathSet,
			addedLineHashesByPath,
			deletedLineHashesByPath,
			candidateBlocks,
		}
	}

	private buildCommitChangedPathSet(payload: AiCodeCommitFactsPayload): Set<string> {
		return new Set(
			(payload.changedFiles || []).flatMap((file) => this.resolveChangedFileRepoPaths(payload.repoRoot, file)),
		)
	}

	private buildChangedLineHashesByPath(
		payload: AiCodeCommitFactsPayload,
		changeType: "addition" | "deletion",
	): Map<string, Set<string>> {
		const hashesByPath = new Map<string, Set<string>>()
		for (const file of payload.changedFiles || []) {
			const paths = this.resolveChangedFileRepoPaths(payload.repoRoot, file)
			const lines = changeType === "deletion" ? file.deletedLines : file.addedLines
			if (paths.length === 0 || !lines || lines.length === 0) {
				continue
			}
			for (const changedLine of lines) {
				const lineHash = changedLine.lineHash || hashLineFingerprint(changedLine.content ?? "")
				if (!lineHash) {
					continue
				}
				for (const repoPath of paths) {
					const bucket = hashesByPath.get(repoPath) ?? new Set<string>()
					bucket.add(lineHash)
					hashesByPath.set(repoPath, bucket)
				}
			}
		}
		return hashesByPath
	}

	private generatedBlockHasChangedLineMatch(
		block: AiCodeGeneratedBlockState,
		addedLineHashesByPath: Map<string, Set<string>>,
		deletedLineHashesByPath: Map<string, Set<string>>,
	): boolean {
		const repoRelativePath = normalizePath(block.repoRelativePath || block.relativePath || "")
		if (!repoRelativePath) {
			return false
		}
		const isDeletionBlock = block.changeType === "deletion"
		const matchHashes = isDeletionBlock
			? deletedLineHashesByPath.get(repoRelativePath)
			: addedLineHashesByPath.get(repoRelativePath)
		if (!matchHashes || matchHashes.size === 0) {
			return false
		}
		const content = block.currentCodeSnippet ?? block.codeSnippet ?? ""
		return normalizeContentLines(content).some((line) => matchHashes.has(hashLineFingerprint(line)))
	}

	private buildCommitCandidateLineId(parts: Array<string | number | undefined>): string {
		const rawId = parts
			.map((part) => (part === undefined ? "" : String(part)))
			.filter((part) => part.length > 0)
			.join(":")
		if (rawId.length <= COMMIT_CANDIDATE_CLIENT_LINE_ID_MAX_LENGTH) {
			return rawId
		}

		const digest = crypto.createHash("sha1").update(rawId, "utf8").digest("hex")
		const prefixLength = COMMIT_CANDIDATE_CLIENT_LINE_ID_MAX_LENGTH - digest.length - 1
		return `${rawId.slice(0, prefixLength)}:${digest}`
	}

	private resolveChangedFileRepoPaths(
		repoRoot: string,
		file: NonNullable<AiCodeCommitFactsPayload["changedFiles"]>[number],
	): string[] {
		return [
			file.relativePath,
			file.previousFilePath,
			file.filePath && path.isAbsolute(file.filePath) ? file.filePath : undefined,
		]
			.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
			.map((value) =>
				path.isAbsolute(value) ? normalizePath(path.relative(repoRoot, value)) : normalizePath(value),
			)
			.map((value) => value.replace(/^(\.\.\/)+/, ""))
			.filter(Boolean)
	}

	private async buildCommitReportCandidateLines(params: {
		repoRoot: string
		changedPathSet: Set<string>
		pendingGeneratedBlocks: AiCodeGeneratedBlockState[]
		acceptedBlocks: AiCodeGeneratedBlock[]
		generatedBlocks: AiCodeGeneratedBlock[]
		gitBranch?: string
		commitHash: string
		addedLineHashesByPath: Map<string, Set<string>>
		deletedLineHashesByPath: Map<string, Set<string>>
	}): Promise<AiCodeCommitCandidateLine[]> {
		const pendingBlockIds = new Set(params.pendingGeneratedBlocks.map((block) => block.generatedBlockId))
		if (pendingBlockIds.size === 0) {
			return []
		}
		const uploadedBlockIds = new Set(
			params.pendingGeneratedBlocks
				.filter((block) => block.uploadStatus === "uploaded")
				.map((block) => block.generatedBlockId),
		)

		const baselineMetricType = params.acceptedBlocks.length > 0 ? "accepted" : "generated"
		const baselineBlocks = baselineMetricType === "accepted" ? params.acceptedBlocks : params.generatedBlocks
		const baselineEventIdsByBlockId = new Map<string, string>()
		for (const block of baselineBlocks) {
			const generatedBlockId = normalizeGeneratedBlockId(block.generatedBlockId)
			if (generatedBlockId && !baselineEventIdsByBlockId.has(generatedBlockId)) {
				baselineEventIdsByBlockId.set(generatedBlockId, block.eventId)
			}
		}

		const lineStartsByBlockId = new Map<string, number>()
		for (const block of params.pendingGeneratedBlocks) {
			const generatedBlockId = normalizeGeneratedBlockId(block.generatedBlockId)
			if (generatedBlockId && !lineStartsByBlockId.has(generatedBlockId)) {
				lineStartsByBlockId.set(generatedBlockId, block.currentLineStart ?? block.lineStart)
			}
		}

		const pendingLines = await this.store.getPendingLineAttributions(params.repoRoot)
		const candidateLines: AiCodeCommitCandidateLine[] = []
		for (const pendingLine of pendingLines) {
			const generatedBlockId = normalizeGeneratedBlockId(pendingLine.generatedEventId || pendingLine.blockId)
			if (!generatedBlockId || !pendingBlockIds.has(generatedBlockId)) {
				continue
			}
			const repoRelativePath = normalizePath(pendingLine.repoRelativePath || pendingLine.relativePath || "")
			if (params.changedPathSet.size > 0 && (!repoRelativePath || !params.changedPathSet.has(repoRelativePath))) {
				continue
			}
			const isDeletionLine = pendingLine.changeType === "deletion"
			if (uploadedBlockIds.has(generatedBlockId)) {
				const matchHashes = isDeletionLine
					? params.deletedLineHashesByPath.get(repoRelativePath)
					: params.addedLineHashesByPath.get(repoRelativePath)
				if (!matchHashes?.has(pendingLine.lineHash)) {
					continue
				}
			}

			const lineStart = lineStartsByBlockId.get(generatedBlockId)
			const lineNumber = isDeletionLine
				? (pendingLine.lineNumber ?? pendingLine.blockLineIndex)
				: typeof lineStart === "number"
					? lineStart + pendingLine.blockLineIndex - 1
					: pendingLine.blockLineIndex
			candidateLines.push({
				clientLineId: this.buildCommitCandidateLineId([
					params.commitHash,
					pendingLine.id,
					pendingLine.lineHash,
				]),
				generatedBlockId,
				baselineEventId:
					baselineEventIdsByBlockId.get(generatedBlockId) ?? `${generatedBlockId}:${baselineMetricType}`,
				baselineMetricType,
				sourceTimestamp: pendingLine.timestamp,
				sourceType: pendingLine.sourceType,
				ide: pendingLine.ide,
				userName: pendingLine.userName,
				departmentName: pendingLine.departmentName,
				officeName: pendingLine.officeName,
				teamName: pendingLine.teamName,
				userEmail: pendingLine.userEmail,
				organizationId: pendingLine.organizationId,
				organizationName: pendingLine.organizationName,
				sourceIp: pendingLine.sourceIp,
				provider: pendingLine.provider,
				model: pendingLine.model,
				projectKey: pendingLine.projectKey,
				projectName: pendingLine.projectName,
				filePath: normalizePath(pendingLine.filePath),
				relativePath: normalizePath(pendingLine.relativePath),
				repoRoot: normalizePath(pendingLine.repoRoot || params.repoRoot),
				repoRelativePath,
				language: pendingLine.language,
				gitRemoteUrl: pendingLine.gitRemoteUrl,
				gitBranch: params.gitBranch || pendingLine.gitBranch,
				taskId: pendingLine.taskId,
				lineNumber,
				rawLine: pendingLine.rawLine,
				blockLineIndex: pendingLine.blockLineIndex,
				blockLineCount: pendingLine.blockLineCount,
				lineHash: pendingLine.lineHash,
				occurrenceIndex: pendingLine.occurrenceIndex,
				changeType: pendingLine.changeType,
			})
		}

		const candidateLineKeys = new Set(
			candidateLines.map(
				(line) => `${line.generatedBlockId}:${line.lineHash}:${line.occurrenceIndex ?? line.blockLineIndex}`,
			),
		)
		for (const block of params.pendingGeneratedBlocks) {
			const generatedBlockId = normalizeGeneratedBlockId(block.generatedBlockId)
			if (!generatedBlockId || !uploadedBlockIds.has(generatedBlockId)) {
				continue
			}
			const repoRelativePath = normalizePath(block.repoRelativePath || block.relativePath || "")
			if (params.changedPathSet.size > 0 && (!repoRelativePath || !params.changedPathSet.has(repoRelativePath))) {
				continue
			}
			const isDeletionBlock = block.changeType === "deletion"
			const matchHashes = isDeletionBlock
				? params.deletedLineHashesByPath.get(repoRelativePath)
				: params.addedLineHashesByPath.get(repoRelativePath)
			if (!matchHashes || matchHashes.size === 0) {
				continue
			}
			const content = block.currentCodeSnippet ?? block.codeSnippet ?? ""
			const contentLines = normalizeContentLines(content)
			const lineStart = lineStartsByBlockId.get(generatedBlockId)
			const occurrenceCounts = new Map<string, number>()
			for (let index = 0; index < contentLines.length; index += 1) {
				const rawLine = contentLines[index]
				const lineHash = hashLineFingerprint(rawLine)
				const occurrenceIndex = (occurrenceCounts.get(lineHash) ?? 0) + 1
				occurrenceCounts.set(lineHash, occurrenceIndex)
				if (!matchHashes.has(lineHash)) {
					continue
				}
				const candidateLineKey = `${generatedBlockId}:${lineHash}:${occurrenceIndex}`
				if (candidateLineKeys.has(candidateLineKey)) {
					continue
				}
				candidateLineKeys.add(candidateLineKey)
				const blockLineIndex = index + 1
				const lineNumber = isDeletionBlock
					? blockLineIndex
					: typeof lineStart === "number"
						? lineStart + blockLineIndex - 1
						: blockLineIndex
				candidateLines.push({
					clientLineId: this.buildCommitCandidateLineId([
						params.commitHash,
						generatedBlockId,
						"uploaded",
						lineHash,
						blockLineIndex,
					]),
					generatedBlockId,
					baselineEventId:
						baselineEventIdsByBlockId.get(generatedBlockId) ?? `${generatedBlockId}:${baselineMetricType}`,
					baselineMetricType,
					sourceTimestamp: block.currentTimestamp ?? block.timestamp,
					sourceType: block.sourceType,
					ide: block.ide,
					userName: block.userName,
					departmentName: block.departmentName,
					officeName: block.officeName,
					teamName: block.teamName,
					userEmail: block.userEmail,
					organizationId: block.organizationId,
					organizationName: block.organizationName,
					sourceIp: block.sourceIp,
					provider: block.provider,
					model: block.model,
					projectKey: block.projectKey,
					projectName: block.projectName,
					filePath: normalizePath(block.filePath),
					relativePath: normalizePath(block.relativePath),
					repoRoot: normalizePath(block.repoRoot || params.repoRoot),
					repoRelativePath,
					language: block.language,
					gitRemoteUrl: block.gitRemoteUrl,
					gitBranch: params.gitBranch || block.gitBranch,
					taskId: block.taskId,
					lineNumber,
					rawLine,
					blockLineIndex,
					blockLineCount: contentLines.length,
					lineHash,
					occurrenceIndex,
					changeType: block.changeType,
				})
			}
		}

		return candidateLines.sort(
			(left, right) =>
				left.repoRelativePath.localeCompare(right.repoRelativePath) ||
				left.generatedBlockId.localeCompare(right.generatedBlockId) ||
				left.blockLineIndex - right.blockLineIndex ||
				left.clientLineId.localeCompare(right.clientLineId),
		)
	}

	private async buildCommitReportBaselineBlocks(params: {
		pendingGeneratedBlocks: AiCodeGeneratedBlockState[]
		commitOccurredAt: number
		gitBranch?: string
		includeUploadedBlocks?: boolean
	}): Promise<{ generatedBlocks: AiCodeGeneratedBlock[]; acceptedBlocks: AiCodeGeneratedBlock[] }> {
		if (params.pendingGeneratedBlocks.length === 0) {
			return {
				generatedBlocks: [],
				acceptedBlocks: [],
			}
		}

		const generatedBlockIds = [...new Set(params.pendingGeneratedBlocks.map((block) => block.generatedBlockId))]
		const pendingCommitMetricBlocks = await this.store.getPendingCommitMetricBlocks(generatedBlockIds)
		const pendingCommitMetricBlocksById = new Map<string, AiCodeGeneratedBlock[]>()
		for (const block of pendingCommitMetricBlocks) {
			const generatedBlockId = normalizeGeneratedBlockId(block.generatedBlockId)
			if (!generatedBlockId) {
				continue
			}
			const bucket = pendingCommitMetricBlocksById.get(generatedBlockId) ?? []
			bucket.push({ ...block })
			pendingCommitMetricBlocksById.set(generatedBlockId, bucket)
		}
		for (const blocks of pendingCommitMetricBlocksById.values()) {
			blocks.sort(
				(left, right) =>
					left.timestamp - right.timestamp ||
					left.lineStart - right.lineStart ||
					left.eventId.localeCompare(right.eventId),
			)
		}

		const generatedBlocks: AiCodeGeneratedBlock[] = []
		const acceptedBlocks: AiCodeGeneratedBlock[] = []

		for (const block of params.pendingGeneratedBlocks) {
			const generatedBlockId = normalizeGeneratedBlockId(block.generatedBlockId)
			const baselineBlocks = generatedBlockId ? (pendingCommitMetricBlocksById.get(generatedBlockId) ?? []) : []
			if (baselineBlocks.length === 0) {
				if (!params.includeUploadedBlocks && block.uploadStatus !== "uploaded") {
					throw new Error(
						`Missing pending commit metric baseline for generated block ${generatedBlockId ?? block.eventId}`,
					)
				}
				generatedBlocks.push(
					this.prepareGeneratedBlockForReport(
						{
							...this.toGeneratedBlock(block, "origin"),
							gitBranch: params.gitBranch || block.gitBranch,
						},
						params.commitOccurredAt,
					),
				)
				acceptedBlocks.push(
					this.prepareGeneratedBlockForReport(
						{
							...this.toGeneratedBlock(block, "current"),
							eventId: `${block.eventId}:accepted`,
							gitBranch: params.gitBranch || block.gitBranch,
						},
						params.commitOccurredAt,
					),
				)
				continue
			}

			generatedBlocks.push(
				...baselineBlocks.map((baselineBlock) =>
					this.preparePendingCommitMetricBlockForReport(
						baselineBlock,
						"generated",
						params.commitOccurredAt,
						params.gitBranch,
					),
				),
			)
			acceptedBlocks.push(
				...baselineBlocks.map((baselineBlock) =>
					this.preparePendingCommitMetricBlockForReport(
						baselineBlock,
						"accepted",
						params.commitOccurredAt,
						params.gitBranch,
					),
				),
			)
		}

		return {
			generatedBlocks: generatedBlocks.sort(this.compareGeneratedBlocksForReport),
			acceptedBlocks: acceptedBlocks.sort(this.compareGeneratedBlocksForReport),
		}
	}

	private preparePendingCommitMetricBlockForReport(
		block: AiCodeGeneratedBlock,
		metricType: "generated" | "accepted",
		commitOccurredAt: number,
		gitBranch?: string,
	): AiCodeGeneratedBlock {
		return this.prepareGeneratedBlockForReport(
			{
				...block,
				eventId: `${block.eventId}:${metricType}`,
				gitBranch: gitBranch || block.gitBranch,
			},
			commitOccurredAt,
		)
	}

	private prepareGeneratedBlockForReport(
		block: AiCodeGeneratedBlock,
		commitOccurredAt: number,
	): AiCodeGeneratedBlock {
		return {
			...block,
			timestamp: commitOccurredAt,
			semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
		}
	}

	private compareGeneratedBlocksForReport(left: AiCodeGeneratedBlock, right: AiCodeGeneratedBlock): number {
		return (
			left.relativePath.localeCompare(right.relativePath) ||
			left.lineStart - right.lineStart ||
			left.timestamp - right.timestamp ||
			left.eventId.localeCompare(right.eventId)
		)
	}

	private async getPendingGeneratedBlocksForContext(
		filePath: string,
		taskId: string | undefined,
		sourceType: AiCodeGeneratedBlockState["sourceType"],
	): Promise<AiCodeGeneratedBlockState[]> {
		const normalizedFilePath = normalizePath(path.resolve(filePath))
		const normalizedTaskId = taskId?.trim() || ""
		const generatedBlocks = await this.store.getGeneratedBlockStates()
		return generatedBlocks.filter(
			(block) =>
				block.uploadStatus === "pending" &&
				normalizePath(path.resolve(block.filePath)) === normalizedFilePath &&
				(block.taskId?.trim() || "") === normalizedTaskId &&
				block.sourceType === sourceType,
		)
	}

	private buildGeneratedBlocksForSnapshot(params: {
		existingPendingBlocks: AiCodeGeneratedBlockState[]
		addedBlocks: Array<{ lineStart: number; lineEnd: number; lineCount: number; codeSnippet: string }>
		patchHunks: AiCodePatchHunk[]
		timestamp: number
		finalContent: string
		repoRoot: string
		repoRelativePath: string
		filePath: string
		taskId?: string
		metadata: Awaited<ReturnType<AiCodeStatsMetadataResolver["resolve"]>>
		modelContext?: AiCodeModelContext
	}): GeneratedStateBuildResult {
		const finalLines = normalizeContentLines(params.finalContent)
		let nextBlocks = this.buildPreservedGeneratedBlocks({
			existingPendingBlocks: params.existingPendingBlocks,
			patchHunks: params.patchHunks,
			finalLines,
			finalContent: params.finalContent,
			timestamp: params.timestamp,
		})
		const metricBlocks: AiCodeGeneratedBlock[] = []

		for (const addedBlock of params.addedBlocks) {
			const codeSnippet = finalLines.slice(addedBlock.lineStart - 1, addedBlock.lineEnd).join("\n")
			if (!codeSnippet.trim()) {
				continue
			}

			const touchingIndexes = this.findTouchingGeneratedBlockIndexes(nextBlocks, {
				lineStart: addedBlock.lineStart,
				lineEnd: addedBlock.lineEnd,
			})
			const touchingGeneratedBlockIds = [
				...new Set(touchingIndexes.map((index) => nextBlocks[index].generatedBlockId)),
			]

			if (touchingGeneratedBlockIds.length === 1) {
				const touchedBlocks = touchingIndexes
					.map((index) => nextBlocks[index])
					.sort((left, right) => left.lineStart - right.lineStart || left.lineEnd - right.lineEnd)
				const baseBlock = touchedBlocks[0]
				const mergedBlock = this.createCurrentGeneratedBlockState({
					sourceBlock: baseBlock,
					timestamp: params.timestamp,
					finalLines,
					finalContent: params.finalContent,
					lineStart: Math.min(addedBlock.lineStart, ...touchedBlocks.map((block) => block.lineStart)),
					lineEnd: Math.max(addedBlock.lineEnd, ...touchedBlocks.map((block) => block.lineEnd)),
				})
				nextBlocks = nextBlocks.filter((_, index) => !touchingIndexes.includes(index)).concat(mergedBlock)
				metricBlocks.push(
					this.createGeneratedMetricBlock({
						generatedBlockId: baseBlock.generatedBlockId,
						timestamp: params.timestamp,
						sourceType: baseBlock.sourceType,
						filePath: baseBlock.filePath,
						repoRoot: baseBlock.repoRoot || params.repoRoot,
						repoRelativePath:
							baseBlock.repoRelativePath || baseBlock.relativePath || params.repoRelativePath,
						taskId: baseBlock.taskId,
						metadata: params.metadata,
						modelContext: params.modelContext,
						fileSnapshotContent: params.finalContent,
						lineStart: addedBlock.lineStart,
						lineEnd: addedBlock.lineEnd,
						codeSnippet,
					}),
				)
				continue
			}

			const nextBlock = this.createNewGeneratedBlockState({
				timestamp: params.timestamp,
				sourceType: "agent_insert",
				filePath: params.filePath,
				repoRoot: params.repoRoot,
				repoRelativePath: params.repoRelativePath,
				taskId: params.taskId,
				metadata: params.metadata,
				modelContext: params.modelContext,
				finalLines,
				finalContent: params.finalContent,
				lineStart: addedBlock.lineStart,
				lineEnd: addedBlock.lineEnd,
			})
			nextBlocks.push(nextBlock)
			metricBlocks.push(
				this.createGeneratedMetricBlock({
					generatedBlockId: nextBlock.generatedBlockId,
					timestamp: params.timestamp,
					sourceType: nextBlock.sourceType,
					filePath: nextBlock.filePath,
					repoRoot: nextBlock.repoRoot || params.repoRoot,
					repoRelativePath: nextBlock.repoRelativePath || params.repoRelativePath,
					taskId: nextBlock.taskId,
					metadata: params.metadata,
					modelContext: params.modelContext,
					fileSnapshotContent: params.finalContent,
					lineStart: addedBlock.lineStart,
					lineEnd: addedBlock.lineEnd,
					codeSnippet,
				}),
			)
		}

		return {
			nextBlocks: this.mergeAdjacentGeneratedBlocksByLineage({
				blocks: nextBlocks,
				finalLines,
				finalContent: params.finalContent,
				timestamp: params.timestamp,
			}),
			metricBlocks,
		}
	}

	private buildPreservedGeneratedBlocks(params: {
		existingPendingBlocks: AiCodeGeneratedBlockState[]
		patchHunks: AiCodePatchHunk[]
		finalLines: string[]
		finalContent: string
		timestamp: number
	}): AiCodeGeneratedBlockState[] {
		if (params.existingPendingBlocks.length === 0) {
			return []
		}

		const sortedHunks = params.patchHunks.slice().sort((left, right) => left.oldStart - right.oldStart)
		const preservedBlocks: AiCodeGeneratedBlockState[] = []

		for (const block of params.existingPendingBlocks) {
			let segmentStart: number | undefined
			let previousMappedLine: number | undefined
			for (let lineNumber = block.lineStart; lineNumber <= block.lineEnd; lineNumber += 1) {
				if (this.isLineInsideChangedHunk(lineNumber, sortedHunks)) {
					if (segmentStart !== undefined && previousMappedLine !== undefined) {
						preservedBlocks.push(
							this.createCurrentGeneratedBlockState({
								sourceBlock: block,
								timestamp: params.timestamp,
								finalLines: params.finalLines,
								finalContent: params.finalContent,
								lineStart: segmentStart,
								lineEnd: previousMappedLine,
							}),
						)
					}
					segmentStart = undefined
					previousMappedLine = undefined
					continue
				}

				const mappedLineNumber = lineNumber + this.computeLineShift(lineNumber, sortedHunks)
				if (segmentStart === undefined || previousMappedLine === undefined) {
					segmentStart = mappedLineNumber
					previousMappedLine = mappedLineNumber
					continue
				}
				if (mappedLineNumber === previousMappedLine + 1) {
					previousMappedLine = mappedLineNumber
					continue
				}
				preservedBlocks.push(
					this.createCurrentGeneratedBlockState({
						sourceBlock: block,
						timestamp: params.timestamp,
						finalLines: params.finalLines,
						finalContent: params.finalContent,
						lineStart: segmentStart,
						lineEnd: previousMappedLine,
					}),
				)
				segmentStart = mappedLineNumber
				previousMappedLine = mappedLineNumber
			}

			if (segmentStart !== undefined && previousMappedLine !== undefined) {
				preservedBlocks.push(
					this.createCurrentGeneratedBlockState({
						sourceBlock: block,
						timestamp: params.timestamp,
						finalLines: params.finalLines,
						finalContent: params.finalContent,
						lineStart: segmentStart,
						lineEnd: previousMappedLine,
					}),
				)
			}
		}

		return this.mergeAdjacentGeneratedBlocksByLineage({
			blocks: preservedBlocks,
			finalLines: params.finalLines,
			finalContent: params.finalContent,
			timestamp: params.timestamp,
		})
	}

	private computeLineShift(oldLineNumber: number, patchHunks: AiCodePatchHunk[]): number {
		let shift = 0
		for (const hunk of patchHunks) {
			if (!this.isHunkBeforeLine(oldLineNumber, hunk)) {
				continue
			}
			shift += hunk.newLines - hunk.oldLines
		}
		return shift
	}

	private isLineInsideChangedHunk(oldLineNumber: number, patchHunks: AiCodePatchHunk[]): boolean {
		return patchHunks.some((hunk) => {
			if (hunk.oldLines <= 0) {
				return false
			}
			const oldEnd = hunk.oldStart + hunk.oldLines - 1
			return oldLineNumber >= hunk.oldStart && oldLineNumber <= oldEnd
		})
	}

	private isHunkBeforeLine(oldLineNumber: number, hunk: AiCodePatchHunk): boolean {
		if (hunk.oldLines <= 0) {
			return oldLineNumber > hunk.oldStart
		}
		return oldLineNumber > hunk.oldStart + hunk.oldLines - 1
	}

	private createGeneratedMetricBlock(params: {
		generatedBlockId: string
		timestamp: number
		sourceType: AiCodeGeneratedBlock["sourceType"]
		filePath: string
		repoRoot: string
		repoRelativePath: string
		taskId?: string
		metadata: Awaited<ReturnType<AiCodeStatsMetadataResolver["resolve"]>>
		modelContext?: AiCodeModelContext
		fileSnapshotContent: string
		lineStart: number
		lineEnd: number
		codeSnippet: string
		changeType?: AiCodeGeneratedBlock["changeType"]
	}): AiCodeGeneratedBlock {
		const eventId = crypto.randomUUID()
		return {
			eventId,
			generatedBlockId: params.generatedBlockId,
			timestamp: params.timestamp,
			semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
			sourceType: params.sourceType,
			ide: this.ide,
			changeType: params.changeType,
			userName: params.metadata.userName,
			departmentName: params.metadata.departmentName,
			officeName: params.metadata.officeName,
			teamName: params.metadata.teamName,
			userEmail: params.metadata.userEmail,
			organizationId: params.metadata.organizationId,
			organizationName: params.metadata.organizationName,
			sourceIp: params.metadata.sourceIp,
			provider: params.modelContext?.provider,
			model: params.modelContext?.model,
			projectKey: params.metadata.projectKey,
			projectName: params.metadata.projectName,
			repoRoot: params.repoRoot,
			repoRelativePath: params.repoRelativePath,
			filePath: params.filePath,
			relativePath: params.repoRelativePath,
			language: params.metadata.language,
			gitRemoteUrl: params.metadata.gitRemoteUrl,
			gitBranch: params.metadata.gitBranch,
			lineStart: params.lineStart,
			lineEnd: params.lineEnd,
			lineCount: params.lineEnd - params.lineStart + 1,
			codeSnippet: params.codeSnippet,
			fileSnapshotContent: params.fileSnapshotContent,
			taskId: params.taskId,
		}
	}

	private createNewGeneratedBlockState(params: {
		timestamp: number
		sourceType: "agent_insert"
		filePath: string
		repoRoot: string
		repoRelativePath: string
		taskId?: string
		metadata: Awaited<ReturnType<AiCodeStatsMetadataResolver["resolve"]>>
		modelContext?: AiCodeModelContext
		finalLines: string[]
		finalContent: string
		lineStart: number
		lineEnd: number
	}): AiCodeGeneratedBlockState {
		const generatedBlockId = crypto.randomUUID()
		const stateId = crypto.randomUUID()
		const codeSnippet = params.finalLines.slice(params.lineStart - 1, params.lineEnd).join("\n")
		return {
			stateId,
			eventId: stateId,
			generatedBlockId,
			timestamp: params.timestamp,
			semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
			sourceType: params.sourceType,
			ide: this.ide,
			userName: params.metadata.userName,
			departmentName: params.metadata.departmentName,
			officeName: params.metadata.officeName,
			teamName: params.metadata.teamName,
			userEmail: params.metadata.userEmail,
			organizationId: params.metadata.organizationId,
			organizationName: params.metadata.organizationName,
			sourceIp: params.metadata.sourceIp,
			provider: params.modelContext?.provider,
			model: params.modelContext?.model,
			projectKey: params.metadata.projectKey,
			projectName: params.metadata.projectName,
			filePath: params.filePath,
			relativePath: params.repoRelativePath,
			repoRoot: params.repoRoot,
			repoRelativePath: params.repoRelativePath,
			language: params.metadata.language,
			gitRemoteUrl: params.metadata.gitRemoteUrl,
			gitBranch: params.metadata.gitBranch,
			lineStart: params.lineStart,
			lineEnd: params.lineEnd,
			lineCount: params.lineEnd - params.lineStart + 1,
			codeSnippet,
			fileSnapshotContent: params.finalContent,
			originEventId: `${stateId}:generated`,
			originTimestamp: params.timestamp,
			originLineStart: params.lineStart,
			originLineEnd: params.lineEnd,
			originLineCount: params.lineEnd - params.lineStart + 1,
			originCodeSnippet: codeSnippet,
			originFileSnapshotContent: params.finalContent,
			currentTimestamp: params.timestamp,
			currentLineStart: params.lineStart,
			currentLineEnd: params.lineEnd,
			currentLineCount: params.lineEnd - params.lineStart + 1,
			currentCodeSnippet: codeSnippet,
			currentFileSnapshotContent: params.finalContent,
			taskId: params.taskId,
			uploadStatus: "pending",
		}
	}

	private createCurrentGeneratedBlockState(params: {
		sourceBlock: AiCodeGeneratedBlockState
		timestamp: number
		finalLines: string[]
		finalContent: string
		lineStart: number
		lineEnd: number
	}): AiCodeGeneratedBlockState {
		const stateId = crypto.randomUUID()
		const codeSnippet = params.finalLines.slice(params.lineStart - 1, params.lineEnd).join("\n")
		return {
			...params.sourceBlock,
			stateId,
			eventId: stateId,
			timestamp: params.timestamp,
			lineStart: params.lineStart,
			lineEnd: params.lineEnd,
			lineCount: params.lineEnd - params.lineStart + 1,
			codeSnippet,
			fileSnapshotContent: params.finalContent,
			currentTimestamp: params.timestamp,
			currentLineStart: params.lineStart,
			currentLineEnd: params.lineEnd,
			currentLineCount: params.lineEnd - params.lineStart + 1,
			currentCodeSnippet: codeSnippet,
			currentFileSnapshotContent: params.finalContent,
			uploadStatus: "pending",
			queuedReportId: undefined,
		}
	}

	private findTouchingGeneratedBlockIndexes(
		blocks: AiCodeGeneratedBlockState[],
		range: GeneratedLineRange,
	): number[] {
		return blocks
			.map((block, index) => ({ block, index }))
			.filter(({ block }) => range.lineStart <= block.lineEnd + 1 && range.lineEnd >= block.lineStart - 1)
			.map(({ index }) => index)
	}

	private mergeAdjacentGeneratedBlocksByLineage(params: {
		blocks: AiCodeGeneratedBlockState[]
		finalLines: string[]
		finalContent: string
		timestamp: number
	}): AiCodeGeneratedBlockState[] {
		const sortedBlocks = params.blocks
			.filter((block) => block.lineStart > 0 && block.lineEnd >= block.lineStart)
			.sort((left, right) => left.lineStart - right.lineStart || left.lineEnd - right.lineEnd)
		if (sortedBlocks.length === 0) {
			return []
		}

		const merged: AiCodeGeneratedBlockState[] = []
		for (const block of sortedBlocks) {
			const current = merged[merged.length - 1]
			if (
				current &&
				current.generatedBlockId === block.generatedBlockId &&
				block.lineStart <= current.lineEnd + 1
			) {
				merged[merged.length - 1] = this.createCurrentGeneratedBlockState({
					sourceBlock: current,
					timestamp: params.timestamp,
					finalLines: params.finalLines,
					finalContent: params.finalContent,
					lineStart: Math.min(current.lineStart, block.lineStart),
					lineEnd: Math.max(current.lineEnd, block.lineEnd),
				})
				continue
			}
			merged.push(block)
		}

		return merged
	}

	private toGeneratedBlock(block: AiCodeGeneratedBlockState, view: "origin" | "current"): AiCodeGeneratedBlock {
		const isOrigin = view === "origin"
		return {
			eventId: isOrigin ? block.originEventId || `${block.generatedBlockId}:generated` : block.eventId,
			generatedBlockId: block.generatedBlockId,
			timestamp: isOrigin ? (block.originTimestamp ?? block.timestamp) : block.timestamp,
			semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
			sourceType: block.sourceType,
			ide: block.ide,
			changeType: block.changeType,
			userName: block.userName,
			departmentName: block.departmentName,
			officeName: block.officeName,
			teamName: block.teamName,
			userEmail: block.userEmail,
			organizationId: block.organizationId,
			organizationName: block.organizationName,
			sourceIp: block.sourceIp,
			provider: block.provider,
			model: block.model,
			projectKey: block.projectKey,
			projectName: block.projectName,
			repoRoot: block.repoRoot,
			repoRelativePath: block.repoRelativePath,
			filePath: block.filePath,
			relativePath: block.relativePath,
			language: block.language,
			gitRemoteUrl: block.gitRemoteUrl,
			gitBranch: block.gitBranch,
			lineStart: isOrigin ? (block.originLineStart ?? block.lineStart) : block.lineStart,
			lineEnd: isOrigin ? (block.originLineEnd ?? block.lineEnd) : block.lineEnd,
			lineCount: isOrigin ? (block.originLineCount ?? block.lineCount) : block.lineCount,
			codeSnippet: isOrigin ? (block.originCodeSnippet ?? block.codeSnippet) : block.codeSnippet,
			fileSnapshotContent: isOrigin
				? (block.originFileSnapshotContent ?? block.fileSnapshotContent)
				: block.fileSnapshotContent,
			taskId: block.taskId,
		}
	}

	private isPathInsideRepo(repoRoot: string, filePath: string): boolean {
		const relative = path.relative(repoRoot, filePath)
		return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
	}

	private async appendPendingMetricEvents(events: AiCodeStatsEvent[]): Promise<void> {
		for (const event of events) {
			await this.store.appendEvent(event)
		}
	}

	private async requestCommitTriggeredUpload(
		reportId?: string,
		action: AiCodeUploadAction = "commit",
	): Promise<void> {
		if (this.isUploading) {
			this.uploadRequestedWhileRunning = true
			return
		}

		this.isUploading = true
		try {
			do {
				this.uploadRequestedWhileRunning = false
				await this.performIncrementalUpload("commit", reportId, action)
			} while (this.uploadRequestedWhileRunning)
		} finally {
			this.isUploading = false
		}
	}

	private async performIncrementalUpload(
		trigger: "commit",
		reportId?: string,
		action: AiCodeUploadAction = "commit",
	): Promise<void> {
		try {
			await this.store.pruneOldData(AI_CODE_STATS_RETENTION_DAYS)
			const settings = await this.getUploadSettings()
			if (!settings.webhookUrl?.trim()) {
				return
			}
			const uploadTargetDetails = this.buildUploadTargetDiagnostics(settings, "ingest")

			let reportUploadResult: AiCodeCommitReportUploadResult = {
				uploadedReports: 0,
				uploadedBlocks: 0,
				failedReports: 0,
				failedReportErrors: [],
				rawPayloadBytes: 0,
				compressedPayloadBytes: 0,
				timeoutMs: 0,
			}
			let reportUploadError: string | undefined
			const queuedReports = (await this.store.getQueuedCommitReports()).filter(
				(queued) => !reportId || queued.report.reportId === reportId,
			)
			for (const queued of queuedReports) {
				await this.store.appendDiagnosticEvent({
					type: "upload_started",
					commitHash: queued.report.commitHash,
					reportId: queued.report.reportId,
					repoRoot: queued.report.repoRoot,
					status: "queued",
					details: {
						trigger,
						action,
						selectedReportId: reportId,
						queuedReportCount: queuedReports.length,
						...uploadTargetDetails,
					},
				})
			}
			try {
				reportUploadResult = await this.uploader.uploadQueuedReports(settings, { reportId })
			} catch (error) {
				reportUploadError = error instanceof Error ? error.message : String(error)
			}
			await this.markFailedCommitReportUploads(
				reportUploadResult.failedReportErrors,
				reportUploadError,
				reportId,
				{
					action,
					targetDetails: uploadTargetDetails,
				},
			)

			let lifecycleUploadResult: AiCodeCommitLifecycleUploadResult = {
				uploadedReports: 0,
				failedReports: 0,
				failedReportErrors: [],
				rawPayloadBytes: 0,
				compressedPayloadBytes: 0,
				timeoutMs: 0,
			}
			let lifecycleUploadError: string | undefined
			const shouldDeferLifecycleUpload = Boolean(reportUploadError) || reportUploadResult.failedReports > 0
			if (shouldDeferLifecycleUpload) {
				const queuedLifecycleReports = await this.store.getQueuedCommitLifecycleReports()
				if (queuedLifecycleReports.length > 0) {
					await this.store.appendDiagnosticEvent({
						type: "lifecycle_upload_deferred",
						status: "queued",
						message: "commit lifecycle upload deferred until queued commit reports succeed",
						details: {
							trigger,
							action,
							queuedLifecycleReportCount: queuedLifecycleReports.length,
							failedCommitReports: reportUploadResult.failedReports + (reportUploadError ? 1 : 0),
							...uploadTargetDetails,
						},
					})
				}
			} else {
				try {
					lifecycleUploadResult = await this.uploader.uploadQueuedLifecycleReports(settings)
				} catch (error) {
					lifecycleUploadError = error instanceof Error ? error.message : String(error)
				}
			}
			if (lifecycleUploadError) {
				await this.store.appendDiagnosticEvent({
					type: "lifecycle_upload_failed",
					status: "upload_failed",
					message: lifecycleUploadError,
					details: {
						trigger,
						action,
						...this.mergeFailureDiagnostics(
							buildUploadFailureDiagnostics(lifecycleUploadError),
							uploadTargetDetails,
						),
					},
				})
			}
			for (const failure of lifecycleUploadResult.failedReportErrors) {
				const baseFailureDiagnostics = buildUploadFailureDiagnostics(failure.message)
				const failureDiagnostics = this.mergeFailureDiagnostics(
					{
						...baseFailureDiagnostics,
						errorCategory: failure.errorCategory ?? baseFailureDiagnostics.errorCategory,
						userMessage: failure.userMessage ?? baseFailureDiagnostics.userMessage,
						targetProtocol: failure.targetProtocol,
						targetHost: failure.targetHost,
						targetPath: failure.targetPath,
					},
					uploadTargetDetails,
				)
				await this.store.appendDiagnosticEvent({
					type: "lifecycle_upload_failed",
					commitHash: failure.commitHash,
					reportId: failure.reportId,
					status: "upload_failed",
					message: failure.message,
					details: {
						trigger,
						action,
						...failureDiagnostics,
					},
				})
			}

			let eventUploadResult: AiCodeStatsUploadResult = { uploaded: 0 }
			let eventUploadError: string | undefined
			try {
				eventUploadResult = await this.uploader.upload(settings, { client: this.buildUploadClient() })
			} catch (error) {
				eventUploadError = error instanceof Error ? error.message : String(error)
			}
			if (eventUploadError) {
				const failureDiagnostics = this.mergeFailureDiagnostics(
					buildUploadFailureDiagnostics(eventUploadError),
					uploadTargetDetails,
				)
				await this.store.appendDiagnosticEvent({
					type: "event_upload_failed",
					status: "upload_failed",
					message: eventUploadError,
					details: {
						trigger,
						action,
						...failureDiagnostics,
					},
				})
			}

			const failedReports =
				reportUploadResult.failedReports +
				lifecycleUploadResult.failedReports +
				(reportUploadError ? 1 : 0) +
				(lifecycleUploadError ? 1 : 0)
			const failureMessages = [
				reportUploadError,
				reportUploadResult.failedReportErrors.length > 0
					? `${reportUploadResult.failedReportErrors.length} queued commit report(s) failed`
					: undefined,
				lifecycleUploadError,
				lifecycleUploadResult.failedReportErrors.length > 0
					? `${lifecycleUploadResult.failedReportErrors.length} queued lifecycle report(s) failed`
					: undefined,
				eventUploadError ? `AI code stats upload failed: ${eventUploadError}` : undefined,
			].filter((message): message is string => Boolean(message))
			const lastUpload: AiCodeStatsLastUpload = {
				status: failureMessages.length > 0 ? "failed" : "success",
				timestamp: Date.now(),
				uploadedEvents: reportUploadResult.uploadedBlocks + eventUploadResult.uploaded,
				uploadedReports: reportUploadResult.uploadedReports + lifecycleUploadResult.uploadedReports,
				failedReports,
				failedReportErrors: [
					...reportUploadResult.failedReportErrors,
					...lifecycleUploadResult.failedReportErrors,
				],
				eventUploadFailed: Boolean(eventUploadError),
				eventUploadError,
				message: failureMessages.length > 0 ? failureMessages.join("; ") : undefined,
				rawPayloadBytes: reportUploadResult.rawPayloadBytes + lifecycleUploadResult.rawPayloadBytes,
				compressedPayloadBytes:
					reportUploadResult.compressedPayloadBytes + lifecycleUploadResult.compressedPayloadBytes,
				timeoutMs: Math.max(reportUploadResult.timeoutMs, lifecycleUploadResult.timeoutMs),
				mode: "incremental",
				trigger,
			}
			await this.store.setLastUploadStatus(lastUpload)
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			const lastUpload: AiCodeStatsLastUpload = {
				status: "failed",
				timestamp: Date.now(),
				message: errorMessage,
				mode: "incremental",
				trigger,
			}
			await this.store.setLastUploadStatus(lastUpload)
		}
	}

	private async markFailedCommitReportUploads(
		failedReportErrors: AiCodeStatsLastUpload["failedReportErrors"],
		batchError?: string,
		reportId?: string,
		context: {
			action: AiCodeUploadAction
			targetDetails: AiCodeUploadTargetDiagnostics
		} = {
			action: "commit",
			targetDetails: {},
		},
	): Promise<void> {
		if ((!failedReportErrors || failedReportErrors.length === 0) && !batchError) {
			return
		}
		const queuedReports = (await this.store.getQueuedCommitReports()).filter(
			(queued) => !reportId || queued.report.reportId === reportId,
		)
		const queuedByReportId = new Map(queuedReports.map((queued) => [queued.report.reportId, queued]))
		const queuedByCommitHash = new Map(queuedReports.map((queued) => [queued.report.commitHash, queued]))
		const failures: AiCodeStatsFailedReportUpload[] =
			failedReportErrors && failedReportErrors.length > 0
				? failedReportErrors
				: queuedReports.map(
						(queued): AiCodeStatsFailedReportUpload => ({
							reportId: queued.report.reportId,
							commitHash: queued.report.commitHash,
							message: batchError ?? "commit report upload failed",
						}),
					)
		for (const failure of failures) {
			const queued =
				(failure.reportId ? queuedByReportId.get(failure.reportId) : undefined) ??
				(failure.commitHash ? queuedByCommitHash.get(failure.commitHash) : undefined)
			if (!queued) {
				continue
			}
			const baseFailureDiagnostics = buildUploadFailureDiagnostics(failure.message)
			const failureDiagnostics = this.mergeFailureDiagnostics(
				{
					...baseFailureDiagnostics,
					errorCategory: (failure.errorCategory ??
						baseFailureDiagnostics.errorCategory) as AiCodeUploadFailureDiagnostics["errorCategory"],
					userMessage: failure.userMessage ?? baseFailureDiagnostics.userMessage,
					targetProtocol: failure.targetProtocol,
					targetHost: failure.targetHost,
					targetPath: failure.targetPath,
				},
				context.targetDetails,
			)
			await this.store.markCommitUploadRecordStatus({
				reportId: queued.report.reportId,
				commitHash: queued.report.commitHash,
				repoRoot: queued.report.repoRoot,
				status: "upload_failed",
				lastError: failure.message,
				lastErrorCategory: failureDiagnostics.errorCategory,
				lastUserMessage: failureDiagnostics.userMessage,
				rawPayloadBytes: failure.rawPayloadBytes,
				compressedPayloadBytes: failure.compressedPayloadBytes,
			})
			await this.store.appendDiagnosticEvent({
				type: "upload_failed",
				commitHash: queued.report.commitHash,
				reportId: queued.report.reportId,
				repoRoot: queued.report.repoRoot,
				status: "upload_failed",
				message: failure.message,
				details: {
					action: context.action,
					selectedReportId: reportId,
					rawPayloadBytes: failure.rawPayloadBytes,
					compressedPayloadBytes: failure.compressedPayloadBytes,
					timeoutMs: failure.timeoutMs,
					encoding: failure.encoding,
					...failureDiagnostics,
				},
			})
		}
	}

	private buildUploadTargetDiagnostics(
		settings: AiCodeStatsUploadSettings,
		kind: "ingest" | "status",
	): AiCodeUploadTargetDiagnostics {
		const rawUrl = settings.webhookUrl?.trim()
		if (!rawUrl) {
			return {}
		}
		try {
			const resolvedUrl =
				kind === "status" ? resolveAiCodeStatsCommitStatusUrl(rawUrl) : resolveAiCodeStatsWebhookUrl(rawUrl)
			return summarizeUploadTarget(resolvedUrl)
		} catch {
			return summarizeUploadTarget(rawUrl)
		}
	}

	private mergeFailureDiagnostics(
		diagnostics: AiCodeUploadFailureDiagnostics,
		fallbackTarget: AiCodeUploadTargetDiagnostics,
	): AiCodeUploadFailureDiagnostics {
		return {
			...diagnostics,
			targetProtocol: diagnostics.targetProtocol ?? fallbackTarget.targetProtocol,
			targetHost: diagnostics.targetHost ?? fallbackTarget.targetHost,
			targetPath: diagnostics.targetPath ?? fallbackTarget.targetPath,
		}
	}

	private buildUploadClient() {
		const wrapper = getKiloCodeWrapperProperties()
		return {
			ide: this.ide,
			wrapperName: wrapper.kiloCodeWrapper || undefined,
			wrapperVersion: wrapper.kiloCodeWrapperVersion || undefined,
			extensionVersion: AI_CODING_CLIENT_VERSION,
			machineId: vscode.env.machineId,
		}
	}
}
