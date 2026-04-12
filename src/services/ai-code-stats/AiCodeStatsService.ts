import crypto from "crypto"
import { exec as execCallback } from "child_process"
import * as fs from "fs/promises"
import * as path from "path"
import { promisify } from "util"
import * as vscode from "vscode"

import { Package } from "../../shared/package"
import { getKiloCodeWrapperProperties } from "../../core/kilocode/wrapper"
import { AiCodeCommitAttributionService, type AiCodeCommitMatchedPayload } from "./AiCodeCommitAttributionService"
import { AiCodeDiffExtractor } from "./AiCodeDiffExtractor"
import { extractLineFeatures } from "./AiCodeLineFeatures"
import { hashLineFingerprint } from "./AiCodeLineFingerprint"
// kilocode_change start
import { AiCodeStatsMetadataResolver } from "./AiCodeStatsMetadataResolver"
// kilocode_change end
import { AiCodeStatsStore } from "./AiCodeStatsStore"
import { AiCodeStatsUploader } from "./AiCodeStatsUploader"
import {
	AI_CODE_STATS_RETENTION_DAYS,
	CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
	normalizePath,
	type AiCodeAddedCodeBlock,
	type AiCodeCommittedBlock,
	type AiCodeCommitReport,
	type AiCodeGeneratedBlock,
	type AiCodeGeneratedBlockState,
	type AiCodeIde,
	type AiCodeMetricType,
	type AiCodePatchHunk,
	type AiCodePendingLineAttribution,
	type AiCodeStatsEvent,
	type AiCodeStatsLastUpload,
	type AiCodeStatsRange,
	type AiCodeStatsRangeSummary,
	type AiCodeStatsSummary,
	type AiCodeStatsUploadSettings,
} from "./types"

const execAsync = promisify(execCallback)
const EXEC_MAX_BUFFER_BYTES = 4 * 1024 * 1024

const toRelativePath = (workspacePath: string, filePath: string): string => {
	const relative = path.relative(workspacePath, filePath)
	return normalizePath(relative || path.basename(filePath))
}

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

const countTextLines = (content: string): number => {
	if (!content) {
		return 0
	}

	const normalized = content.replace(/\r\n/g, "\n")
	const lineBreakCount = (normalized.match(/\n/g) || []).length
	return lineBreakCount + 1 - (normalized.endsWith("\n") ? 1 : 0)
}

const splitBlockCodeLines = (codeSnippet: string, expectedLineCount?: number): string[] => {
	if (typeof expectedLineCount === "number" && expectedLineCount <= 0) {
		return []
	}

	const normalized = codeSnippet.replace(/\r\n/g, "\n")
	const lines = normalized.length > 0 ? normalized.split("\n") : [""]
	if (typeof expectedLineCount !== "number" || expectedLineCount <= 0) {
		return lines
	}
	if (lines.length < expectedLineCount) {
		return [...lines, ...Array.from({ length: expectedLineCount - lines.length }, () => "")]
	}
	return lines.slice(0, expectedLineCount)
}

const trimTrailingBlankLines = (lines: string[]): string[] => {
	let end = lines.length
	while (end > 0 && lines[end - 1].trim().length === 0) {
		end -= 1
	}
	return lines.slice(0, end)
}

const normalizeGeneratedBlockId = (generatedBlockId?: string): string =>
	typeof generatedBlockId === "string" ? generatedBlockId.trim() : ""

interface GeneratedLineRange {
	lineStart: number
	lineEnd: number
}

interface GeneratedStateBuildResult {
	nextBlocks: AiCodeGeneratedBlockState[]
	metricBlocks: AiCodeGeneratedBlock[]
}

interface AgentWriteBlockAnalysis {
	proposedGeneratedBlocks: AiCodeAddedCodeBlock[]
	acceptedBlocks: AiCodeAddedCodeBlock[]
	generatedOnlyBlocks: AiCodeAddedCodeBlock[]
}

const detectIde = (): AiCodeIde => {
	const wrapper = getKiloCodeWrapperProperties()
	return wrapper.kiloCodeWrapped && wrapper.kiloCodeWrapperJetbrains ? "jetbrains" : "vscode"
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
}

export interface AgentSuggestionRecord {
	originalContent: string
	newContent: string
	timestamp?: number
}

interface ResolvedFileContext {
	filePath: string
	workspacePath: string
	workspaceName: string
	relativePath: string
}

interface AutocompleteSuggestionRecord {
	suggestionId: string
	document: vscode.TextDocument
	position: vscode.Position
	suggestionText: string
	timestamp?: number
}

export interface AiCodeStatsManualUploadResult {
	uploadedEvents: number
	timestamp: number
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
	private isUploading = false
	private uploadRequestedWhileRunning = false

	private constructor(
		globalStoragePath: string,
		private readonly getUploadSettings: () => Promise<AiCodeStatsUploadSettings>,
	) {
		this.store = new AiCodeStatsStore(globalStoragePath)
		this.uploader = new AiCodeStatsUploader(this.store)
		this.extractor = new AiCodeDiffExtractor()
		this.commitAttributionService = new AiCodeCommitAttributionService(this.store, {
			onCommitMatched: async (payload) => {
				await this.handleCommitMatched(payload)
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

	start(): void {
		void this.commitAttributionService.start().catch((error) => {
			console.error("[AiCodeStats] Failed to start commit attribution service:", error)
		})
	}

	stop(): void {
		this.commitAttributionService.stop()
	}

	async getSummary(): Promise<AiCodeStatsSummary> {
		await this.store.pruneOldData(AI_CODE_STATS_RETENTION_DAYS)
		return this.store.getSummary()
	}

	async getGeneratedLines(range: AiCodeStatsRange): Promise<number> {
		await this.store.pruneOldData(AI_CODE_STATS_RETENTION_DAYS)
		return this.store.getGeneratedLinesForRange(range)
	}

	async getSuggestedLines(range: AiCodeStatsRange): Promise<number> {
		await this.store.pruneOldData(AI_CODE_STATS_RETENTION_DAYS)
		return this.store.getSuggestedLinesForRange(range)
	}

	async getCommittedLines(range: AiCodeStatsRange): Promise<number> {
		await this.store.pruneOldData(AI_CODE_STATS_RETENTION_DAYS)
		return this.store.getCommittedLinesForRange(range)
	}

	async getRangeSummary(range: AiCodeStatsRange): Promise<AiCodeStatsRangeSummary> {
		await this.store.pruneOldData(AI_CODE_STATS_RETENTION_DAYS)
		return this.store.getRangeSummary(range)
	}

	async recordAgentSuggestion(record: AgentSuggestionRecord): Promise<void> {
		const blocks = this.extractor.extractAddedBlocks(record.originalContent, record.newContent, "suggested")
		if (blocks.length === 0) {
			return
		}

		const suggestedLines = blocks.reduce((total, block) => total + block.lineCount, 0)
		if (suggestedLines === 0) {
			return
		}

		await this.store.addSuggestedLines(suggestedLines, record.timestamp)
	}

	async recordRejectedAgentSuggestion(record: AgentFileWriteRecord): Promise<void> {
		const context = await this.resolveFileContext(record.cwd, record.filePath, record.relativePath)
		const settings = await this.getUploadSettings()
		const metadata = await this.metadataResolver.resolve(context.workspacePath, context.filePath, settings)
		const blocks = this.extractor.extractAddedBlocks(
			record.originalContent,
			record.newContent,
			context.relativePath,
		)
		if (blocks.length === 0) {
			return
		}

		const timestamp = Date.now()
		const events = this.buildMetricEventsForGeneratedBlocks({
			metricTypes: ["generated"],
			blocks: blocks.map((block) =>
				this.createGeneratedMetricBlock({
					generatedBlockId: crypto.randomUUID(),
					timestamp,
					sourceType: "agent_insert",
					workspaceName: context.workspaceName,
					workspacePath: context.workspacePath,
					filePath: context.filePath,
					relativePath: context.relativePath,
					taskId: record.taskId,
					metadata,
					fileSnapshotContent: record.newContent,
					lineStart: block.lineStart,
					lineEnd: block.lineEnd,
					codeSnippet: block.codeSnippet,
				}),
			),
		})
		await this.appendPendingMetricEvents(events)
	}

	async recordAutocompleteSuggestionShown(record: AutocompleteSuggestionRecord): Promise<void> {
		const event = await this.buildAutocompleteMetricEvent(record, "generated")
		if (!event) {
			return
		}

		await this.store.appendEvent(event)
	}

	async recordAutocompleteSuggestionAccepted(record: AutocompleteSuggestionRecord): Promise<void> {
		const event = await this.buildAutocompleteMetricEvent(record, "accepted")
		if (!event) {
			return
		}

		await this.store.appendEvent(event)
	}

	async triggerManualUpload(): Promise<void> {
		if (this.isUploading) {
			throw new Error("Upload is already in progress.")
		}

		this.isUploading = true
		try {
			await this.performIncrementalUpload("manual")
		} finally {
			this.isUploading = false
			this.scheduleQueuedCommitUpload()
		}
	}

	async triggerManualRangeUpload(range: AiCodeStatsRange): Promise<AiCodeStatsManualUploadResult> {
		if (this.isUploading) {
			throw new Error("Upload is already in progress.")
		}

		this.isUploading = true
		try {
			await this.store.pruneOldData(AI_CODE_STATS_RETENTION_DAYS)
			const settings = await this.getUploadSettings()
			if (!settings.webhookUrl?.trim()) {
				throw new Error("Upload webhook URL is not configured.")
			}

			const uploadResult = await this.uploader.uploadRange(settings, {
				range,
				client: this.buildUploadClient(),
			})

			const timestamp = Date.now()
			await this.store.setLastUploadStatus({
				status: "success",
				timestamp,
				uploadedEvents: uploadResult.uploaded,
				mode: "backfill",
				trigger: "manual",
			})

			return {
				uploadedEvents: uploadResult.uploaded,
				timestamp,
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			await this.store.setLastUploadStatus({
				status: "failed",
				timestamp: Date.now(),
				message: errorMessage,
				mode: "backfill",
				trigger: "manual",
			})
			throw error
		} finally {
			this.isUploading = false
			this.scheduleQueuedCommitUpload()
		}
	}

	async recordAgentFileWrite(record: AgentFileWriteRecord): Promise<void> {
		const context = await this.resolveFileContext(record.cwd, record.filePath, record.relativePath)
		const proposedContent = record.proposedContent ?? record.newContent
		// kilocode_change start
		const settings = await this.getUploadSettings()
		const metadata = await this.metadataResolver.resolve(context.workspacePath, context.filePath, settings)
		// kilocode_change end

		const blockAnalysis = this.analyzeAgentWriteBlocks({
			originalContent: record.originalContent,
			proposedContent,
			finalAcceptedContent: record.newContent,
			filePath: context.relativePath,
		})
		if (
			blockAnalysis.proposedGeneratedBlocks.length === 0 &&
			blockAnalysis.acceptedBlocks.length === 0 &&
			blockAnalysis.generatedOnlyBlocks.length === 0
		) {
			return
		}
		const timestamp = Date.now()

		const repoRoot = await resolveGitRepositoryRoot(path.dirname(context.filePath))
		const repoRelativePath =
			repoRoot && this.isPathInsideRepo(repoRoot, context.filePath)
				? normalizePath(path.relative(repoRoot, context.filePath))
				: undefined

		if (!repoRoot || !repoRelativePath) {
			const metricEvents = [
				...this.buildMetricEventsForAddedBlocks({
					metricType: "generated",
					addedBlocks: blockAnalysis.proposedGeneratedBlocks,
					timestamp,
					workspaceName: context.workspaceName,
					workspacePath: context.workspacePath,
					filePath: context.filePath,
					relativePath: context.relativePath,
					taskId: record.taskId,
					metadata,
					fileSnapshotContent: proposedContent,
				}),
				...this.buildMetricEventsForAddedBlocks({
					metricType: "accepted",
					addedBlocks: blockAnalysis.acceptedBlocks,
					timestamp,
					workspaceName: context.workspaceName,
					workspacePath: context.workspacePath,
					filePath: context.filePath,
					relativePath: context.relativePath,
					taskId: record.taskId,
					metadata,
					fileSnapshotContent: record.newContent,
				}),
			]
			await this.appendPendingMetricEvents(metricEvents)
			return
		}

		if (blockAnalysis.generatedOnlyBlocks.length > 0) {
			await this.appendPendingMetricEvents(
				this.buildMetricEventsForAddedBlocks({
					metricType: "generated",
					addedBlocks: blockAnalysis.generatedOnlyBlocks,
					timestamp,
					workspaceName: context.workspaceName,
					workspacePath: context.workspacePath,
					filePath: context.filePath,
					relativePath: context.relativePath,
					taskId: record.taskId,
					metadata,
					fileSnapshotContent: proposedContent,
				}),
			)
		}

		const existingPendingBlocks = await this.getPendingGeneratedBlocksForContext(
			context.filePath,
			record.taskId,
			"agent_insert",
		)
		const patchHunks = this.extractor.extractPatchHunks(
			record.originalContent,
			record.newContent,
			context.relativePath,
		)
		const nextBlocks = this.buildGeneratedBlocksForSnapshot({
			existingPendingBlocks,
			addedBlocks: blockAnalysis.acceptedBlocks,
			patchHunks,
			timestamp,
			finalContent: record.newContent,
			repoRoot,
			repoRelativePath,
			workspaceName: context.workspaceName,
			workspacePath: context.workspacePath,
			filePath: context.filePath,
			relativePath: context.relativePath,
			taskId: record.taskId,
			metadata,
		})
		await this.store.addPendingCommitMetricBlocks(nextBlocks.metricBlocks)

		const lineOccurrenceIndexes = buildLineOccurrenceIndexes(record.newContent)
		const pendingLineAttributions = nextBlocks.nextBlocks.flatMap((block) =>
			this.buildPendingLineAttributions(block, lineOccurrenceIndexes),
		)

		await this.store.replaceGeneratedStateForContext({
			filePath: context.filePath,
			taskId: record.taskId,
			sourceType: "agent_insert",
			nextBlocks: nextBlocks.nextBlocks,
			nextPendingLines: pendingLineAttributions,
		})
		await this.commitAttributionService.refreshRepoTracking(repoRoot)
	}

	private async resolveFileContext(
		cwd: string,
		filePath: string,
		relativePath?: string,
	): Promise<ResolvedFileContext> {
		const resolvedInputPath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath)
		const resolvedFilePath = await resolveFilePathFromParent(resolvedInputPath)
		const workspacePath = await resolveRealPath(cwd)
		const workspaceName = path.basename(workspacePath)
		return {
			filePath: resolvedFilePath,
			workspacePath,
			workspaceName,
			relativePath: normalizePath(relativePath ? relativePath : toRelativePath(workspacePath, resolvedFilePath)),
		}
	}

	private async appendPendingMetricEvents(events: AiCodeStatsEvent[]): Promise<void> {
		for (const event of events) {
			await this.store.appendEvent(event)
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
		if (proposedGeneratedBlocks.length === 0) {
			return {
				proposedGeneratedBlocks: [],
				acceptedBlocks: [],
				generatedOnlyBlocks: [],
			}
		}

		const acceptedBlocks = this.extractor.extractAddedBlocks(
			params.originalContent,
			params.finalAcceptedContent,
			params.filePath,
		)
		const deletedProposalBlocks = this.extractor.extractDeletedBlocks(
			params.proposedContent,
			params.finalAcceptedContent,
			params.filePath,
		)
		const generatedOnlyBlocks = this.extractGeneratedOnlyBlocks({
			proposedGeneratedBlocks,
			deletedProposalBlocks,
		})

		return {
			proposedGeneratedBlocks,
			acceptedBlocks,
			generatedOnlyBlocks,
		}
	}

	private extractGeneratedOnlyBlocks(params: {
		proposedGeneratedBlocks: AiCodeAddedCodeBlock[]
		deletedProposalBlocks: AiCodeAddedCodeBlock[]
	}): AiCodeAddedCodeBlock[] {
		const generatedOnlyBlocks: AiCodeAddedCodeBlock[] = []

		for (const deletedBlock of params.deletedProposalBlocks) {
			const deletedLines = splitBlockCodeLines(deletedBlock.codeSnippet, deletedBlock.lineCount)
			for (const proposedBlock of params.proposedGeneratedBlocks) {
				const overlapStart = Math.max(deletedBlock.lineStart, proposedBlock.lineStart)
				const overlapEnd = Math.min(deletedBlock.lineEnd, proposedBlock.lineEnd)
				if (overlapStart > overlapEnd) {
					continue
				}

				const sliceStart = overlapStart - deletedBlock.lineStart
				const sliceEnd = overlapEnd - deletedBlock.lineStart + 1
				const overlapLines = deletedLines.slice(sliceStart, sliceEnd)
				if (overlapLines.length === 0) {
					continue
				}

				generatedOnlyBlocks.push({
					lineStart: overlapStart,
					lineEnd: overlapEnd,
					lineCount: overlapLines.length,
					codeSnippet: overlapLines.join("\n"),
				})
			}
		}

		return generatedOnlyBlocks.sort(
			(left, right) => left.lineStart - right.lineStart || left.lineEnd - right.lineEnd,
		)
	}

	private buildMetricEventsForAddedBlocks(params: {
		metricType: "generated" | "accepted"
		addedBlocks: AiCodeAddedCodeBlock[]
		timestamp: number
		workspaceName: string
		workspacePath: string
		filePath: string
		relativePath: string
		taskId?: string
		metadata: Awaited<ReturnType<AiCodeStatsMetadataResolver["resolve"]>>
		fileSnapshotContent: string
	}): AiCodeStatsEvent[] {
		if (params.addedBlocks.length === 0) {
			return []
		}

		return this.buildMetricEventsForGeneratedBlocks({
			metricTypes: [params.metricType],
			blocks: params.addedBlocks.map((block) =>
				this.createGeneratedMetricBlock({
					generatedBlockId: crypto.randomUUID(),
					timestamp: params.timestamp,
					sourceType: "agent_insert",
					workspaceName: params.workspaceName,
					workspacePath: params.workspacePath,
					filePath: params.filePath,
					relativePath: params.relativePath,
					taskId: params.taskId,
					metadata: params.metadata,
					fileSnapshotContent: params.fileSnapshotContent,
					lineStart: block.lineStart,
					lineEnd: block.lineEnd,
					codeSnippet: block.codeSnippet,
				}),
			),
		})
	}

	private buildMetricEventsForGeneratedBlocks(params: {
		metricTypes: AiCodeMetricType[]
		blocks: AiCodeGeneratedBlock[]
	}): AiCodeStatsEvent[] {
		const events: AiCodeStatsEvent[] = []

		for (const block of params.blocks) {
			if (!Number.isFinite(block.lineCount) || block.lineCount <= 0) {
				continue
			}

			for (const metricType of params.metricTypes) {
				events.push({
					eventId: `${block.eventId}:${metricType}`,
					generatedBlockId: block.generatedBlockId,
					timestamp: block.timestamp,
					semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
					sourceType: block.sourceType,
					ide: this.ide,
					metricType,
					userName: block.userName,
					userEmail: block.userEmail,
					organizationId: block.organizationId,
					organizationName: block.organizationName,
					sourceIp: block.sourceIp,
					workspaceName: block.workspaceName,
					workspacePath: block.workspacePath,
					projectKey: block.projectKey,
					filePath: block.filePath,
					relativePath: block.relativePath,
					language: block.language,
					gitRemoteUrl: block.gitRemoteUrl,
					gitBranch: block.gitBranch,
					lineStart: block.lineStart,
					lineEnd: block.lineEnd,
					lineCount: block.lineCount,
					codeSnippet: block.codeSnippet,
					fileSnapshotContent: block.fileSnapshotContent,
					taskId: block.taskId,
					equivalentLineCount: block.lineCount,
				})
			}
		}

		return events
	}

	private async buildAutocompleteMetricEvent(
		record: AutocompleteSuggestionRecord,
		metricType: Exclude<AiCodeMetricType, "committed">,
	): Promise<AiCodeStatsEvent | null> {
		if (!record.suggestionText || record.document.uri.scheme !== "file") {
			return null
		}

		const lineCount = countTextLines(record.suggestionText)
		if (lineCount <= 0) {
			return null
		}

		const filePath = normalizePath(path.resolve(record.document.uri.fsPath))
		const workspaceFolder = vscode.workspace.getWorkspaceFolder(record.document.uri)
		const workspacePath = normalizePath(workspaceFolder ? workspaceFolder.uri.fsPath : path.dirname(filePath))
		const workspaceName = workspaceFolder?.name || path.basename(workspacePath)
		const relativePath = normalizePath(
			workspaceFolder ? path.relative(workspacePath, filePath) : path.basename(filePath),
		)
		const settings = await this.getUploadSettings()
		const metadata = await this.metadataResolver.resolve(workspacePath, filePath, settings)
		const normalizedSnippet = normalizeContentLines(record.suggestionText).join("\n")
		const lineStart = record.position.line + 1
		const lineEnd = lineStart + lineCount - 1

		return {
			eventId: `${record.suggestionId}:${metricType}`,
			generatedBlockId: record.suggestionId,
			timestamp: record.timestamp ?? Date.now(),
			semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
			sourceType: "autocomplete",
			ide: this.ide,
			metricType,
			userName: metadata.userName,
			userEmail: metadata.userEmail,
			organizationId: metadata.organizationId,
			organizationName: metadata.organizationName,
			sourceIp: metadata.sourceIp,
			workspaceName,
			workspacePath,
			projectKey: metadata.projectKey,
			filePath,
			relativePath,
			language: metadata.language,
			gitRemoteUrl: metadata.gitRemoteUrl,
			gitBranch: metadata.gitBranch,
			lineStart,
			lineEnd,
			lineCount,
			codeSnippet: normalizedSnippet,
			fileSnapshotContent: undefined,
			equivalentLineCount: lineCount,
		}
	}

	private buildPendingLineAttributions(
		block: AiCodeGeneratedBlockState,
		lineOccurrenceIndexes: number[],
	): AiCodePendingLineAttribution[] {
		const lines = normalizeContentLines(block.codeSnippet)

		return lines.map((line, index) => {
			const lineNumber = block.lineStart + index
			const occurrenceIndex = lineOccurrenceIndexes[lineNumber - 1] ?? index + 1
			const lineFeatures = extractLineFeatures(line)
			return {
				id: crypto.randomUUID(),
				generatedEventId: block.generatedBlockId,
				blockId: block.generatedBlockId,
				timestamp: block.timestamp,
				sourceType: block.sourceType,
				ide: block.ide,
				userName: block.userName,
				userEmail: block.userEmail,
				organizationId: block.organizationId,
				organizationName: block.organizationName,
				sourceIp: block.sourceIp,
				workspaceName: block.workspaceName,
				workspacePath: block.workspacePath,
				projectKey: block.projectKey,
				filePath: block.filePath,
				relativePath: block.relativePath,
				repoRoot: block.repoRoot || block.workspacePath,
				repoRelativePath: block.repoRelativePath || block.relativePath,
				language: block.language,
				gitRemoteUrl: block.gitRemoteUrl,
				gitBranch: block.gitBranch,
				taskId: block.taskId,
				rawLine: lineFeatures.rawLine,
				blockLineIndex: index + 1,
				blockLineCount: lines.length,
				lineHash: hashLineFingerprint(line),
				occurrenceIndex,
				normalizedLine: lineFeatures.normalizedLine,
				normalizedTokenLine: lineFeatures.normalizedTokenLine,
				rareIdentifiers: lineFeatures.rareIdentifiers,
			}
		})
	}

	private async handleCommitMatched(payload: AiCodeCommitMatchedPayload): Promise<void> {
		const normalizeCommitFilePath = (value: string): string =>
			path.isAbsolute(value) ? normalizePath(path.relative(payload.repoRoot, value)) : normalizePath(value)
		const changedPathSet = new Set(
			(payload.changedFiles || []).flatMap((file) =>
				[file.relativePath, file.previousFilePath]
					.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
					.map((value) => normalizeCommitFilePath(value).replace(/^(\.\.\/)+/, "")),
			),
		)
		const pendingGeneratedBlocks = (await this.store.getPendingGeneratedBlockStates(payload.repoRoot)).filter(
			(block) => {
				if (changedPathSet.size === 0) {
					return true
				}
				const repoRelativePath = normalizePath(block.repoRelativePath || block.relativePath || "")
				return repoRelativePath && changedPathSet.has(repoRelativePath)
			},
		)
		if (
			pendingGeneratedBlocks.length === 0 &&
			payload.committedBlocks.length === 0 &&
			payload.changedFiles.length === 0
		) {
			return
		}

		const referenceBlock = pendingGeneratedBlocks[0] ?? payload.committedBlocks[0]
		if (!referenceBlock) {
			return
		}
		const reportBaselineBlocks = await this.buildCommitReportBaselineBlocks({
			pendingGeneratedBlocks,
			commitOccurredAt: payload.commitOccurredAt,
		})
		const reportAcceptedBlocks = reportBaselineBlocks.acceptedBlocks
		const committedBlocks = this.normalizeCommittedBlocksForTrailingBlankLines(
			payload.committedBlocks,
			reportAcceptedBlocks,
		)

		const reportGeneratedAt = Date.now()
		const report: AiCodeCommitReport = {
			version: "v2",
			source: "kilocode-ai-code-stats",
			mode: "commit_report",
			semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
			reportId: crypto.randomUUID(),
			reportGeneratedAt,
			client: this.buildUploadClient(),
			repoRoot: payload.repoRoot,
			workspaceName: referenceBlock.workspaceName,
			workspacePath: referenceBlock.workspacePath,
			projectKey: referenceBlock.projectKey,
			gitRemoteUrl: referenceBlock.gitRemoteUrl,
			gitBranch: payload.branch || referenceBlock.gitBranch,
			commitHash: payload.commitHash,
			previousCommitHash: payload.previousCommit || undefined,
			commitOccurredAt: payload.commitOccurredAt,
			generatedBlocks: reportBaselineBlocks.generatedBlocks,
			acceptedBlocks: reportAcceptedBlocks,
			committedBlocks,
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
			})),
		}

		await this.store.queueCommitReport({
			report,
			createdAt: reportGeneratedAt,
			generatedBlockIds: pendingGeneratedBlocks.map((block) => block.generatedBlockId),
			matchedPendingLineIds: payload.matchedPendingLineIds,
		})
		await this.requestCommitTriggeredUpload()
	}

	private async buildCommitReportBaselineBlocks(params: {
		pendingGeneratedBlocks: AiCodeGeneratedBlockState[]
		commitOccurredAt: number
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
				throw new Error(
					`Missing pending commit metric baseline for generated block ${generatedBlockId ?? block.eventId}`,
				)
			}

			generatedBlocks.push(
				...baselineBlocks.map((baselineBlock) =>
					this.preparePendingCommitMetricBlockForReport(baselineBlock, "generated", params.commitOccurredAt),
				),
			)
			acceptedBlocks.push(
				...baselineBlocks.map((baselineBlock) =>
					this.preparePendingCommitMetricBlockForReport(baselineBlock, "accepted", params.commitOccurredAt),
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
	): AiCodeGeneratedBlock {
		return this.prepareGeneratedBlockForReport(
			{
				...block,
				eventId: `${block.eventId}:${metricType}`,
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

	private normalizeCommittedBlocksForTrailingBlankLines(
		committedBlocks: AiCodeCommitMatchedPayload["committedBlocks"],
		acceptedBlocks: AiCodeGeneratedBlock[],
	): AiCodeCommittedBlock[] {
		if (committedBlocks.length === 0 || acceptedBlocks.length === 0) {
			return committedBlocks.map((block) => ({ ...block }))
		}

		const acceptedBlocksById = new Map<string, AiCodeGeneratedBlock>()
		for (const acceptedBlock of acceptedBlocks) {
			const generatedBlockId = normalizeGeneratedBlockId(acceptedBlock.generatedBlockId)
			if (!generatedBlockId || acceptedBlocksById.has(generatedBlockId)) {
				continue
			}
			acceptedBlocksById.set(generatedBlockId, acceptedBlock)
		}

		return committedBlocks.map((committedBlock) => {
			const normalizedGeneratedBlockId = normalizeGeneratedBlockId(committedBlock.generatedBlockId)
			const acceptedBlock =
				committedBlock.matchStrategy === "exact" && normalizedGeneratedBlockId
					? acceptedBlocksById.get(normalizedGeneratedBlockId)
					: undefined
			return this.normalizeCommittedBlockTrailingBlankLines(committedBlock, acceptedBlock)
		})
	}

	private normalizeCommittedBlockTrailingBlankLines(
		committedBlock: AiCodeCommittedBlock,
		acceptedBlock?: AiCodeGeneratedBlock,
	): AiCodeCommittedBlock {
		if (
			!acceptedBlock ||
			committedBlock.matchStrategy !== "exact" ||
			acceptedBlock.lineCount <= committedBlock.lineCount
		) {
			return { ...committedBlock }
		}

		const committedLines = splitBlockCodeLines(committedBlock.codeSnippet, committedBlock.lineCount)
		const acceptedLines = splitBlockCodeLines(acceptedBlock.codeSnippet, acceptedBlock.lineCount)
		const trimmedCommittedLines = trimTrailingBlankLines(committedLines)
		const trimmedAcceptedLines = trimTrailingBlankLines(acceptedLines)

		if (trimmedCommittedLines.length !== trimmedAcceptedLines.length) {
			return { ...committedBlock }
		}
		for (let index = 0; index < trimmedCommittedLines.length; index += 1) {
			if (trimmedCommittedLines[index] !== trimmedAcceptedLines[index]) {
				return { ...committedBlock }
			}
		}

		const committedTrailingBlankLines = committedLines.length - trimmedCommittedLines.length
		const acceptedTrailingBlankLines = acceptedLines.length - trimmedAcceptedLines.length
		if (acceptedTrailingBlankLines <= committedTrailingBlankLines) {
			return { ...committedBlock }
		}

		return {
			...committedBlock,
			lineEnd: acceptedBlock.lineEnd,
			lineCount: acceptedBlock.lineCount,
			codeSnippet: acceptedBlock.codeSnippet,
			equivalentLineCount: acceptedBlock.lineCount,
		}
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
		workspaceName: string
		workspacePath: string
		filePath: string
		relativePath: string
		taskId?: string
		metadata: Awaited<ReturnType<AiCodeStatsMetadataResolver["resolve"]>>
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
						workspaceName: baseBlock.workspaceName,
						workspacePath: baseBlock.workspacePath,
						filePath: baseBlock.filePath,
						relativePath: baseBlock.relativePath,
						taskId: baseBlock.taskId,
						metadata: params.metadata,
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
				workspaceName: params.workspaceName,
				workspacePath: params.workspacePath,
				filePath: params.filePath,
				relativePath: params.relativePath,
				repoRoot: params.repoRoot,
				repoRelativePath: params.repoRelativePath,
				taskId: params.taskId,
				metadata: params.metadata,
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
					workspaceName: nextBlock.workspaceName,
					workspacePath: nextBlock.workspacePath,
					filePath: nextBlock.filePath,
					relativePath: nextBlock.relativePath,
					taskId: nextBlock.taskId,
					metadata: params.metadata,
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
		workspaceName: string
		workspacePath: string
		filePath: string
		relativePath: string
		taskId?: string
		metadata: Awaited<ReturnType<AiCodeStatsMetadataResolver["resolve"]>>
		fileSnapshotContent: string
		lineStart: number
		lineEnd: number
		codeSnippet: string
	}): AiCodeGeneratedBlock {
		const eventId = crypto.randomUUID()
		return {
			eventId,
			generatedBlockId: params.generatedBlockId,
			timestamp: params.timestamp,
			semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
			sourceType: params.sourceType,
			ide: this.ide,
			userName: params.metadata.userName,
			userEmail: params.metadata.userEmail,
			organizationId: params.metadata.organizationId,
			organizationName: params.metadata.organizationName,
			sourceIp: params.metadata.sourceIp,
			workspaceName: params.workspaceName,
			workspacePath: params.workspacePath,
			projectKey: params.metadata.projectKey,
			filePath: params.filePath,
			relativePath: params.relativePath,
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
		workspaceName: string
		workspacePath: string
		filePath: string
		relativePath: string
		repoRoot: string
		repoRelativePath: string
		taskId?: string
		metadata: Awaited<ReturnType<AiCodeStatsMetadataResolver["resolve"]>>
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
			userEmail: params.metadata.userEmail,
			organizationId: params.metadata.organizationId,
			organizationName: params.metadata.organizationName,
			sourceIp: params.metadata.sourceIp,
			workspaceName: params.workspaceName,
			workspacePath: params.workspacePath,
			projectKey: params.metadata.projectKey,
			filePath: params.filePath,
			relativePath: params.relativePath,
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
			userName: block.userName,
			userEmail: block.userEmail,
			organizationId: block.organizationId,
			organizationName: block.organizationName,
			sourceIp: block.sourceIp,
			workspaceName: block.workspaceName,
			workspacePath: block.workspacePath,
			projectKey: block.projectKey,
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

	private async requestCommitTriggeredUpload(): Promise<void> {
		if (this.isUploading) {
			this.uploadRequestedWhileRunning = true
			return
		}

		this.isUploading = true
		try {
			do {
				this.uploadRequestedWhileRunning = false
				await this.performIncrementalUpload("commit")
			} while (this.uploadRequestedWhileRunning)
		} finally {
			this.isUploading = false
		}
	}

	private async performIncrementalUpload(trigger: "commit" | "manual"): Promise<void> {
		try {
			await this.store.pruneOldData(AI_CODE_STATS_RETENTION_DAYS)
			const settings = await this.getUploadSettings()
			if (!settings.webhookUrl?.trim()) {
				return
			}

			const reportUploadResult = await this.uploader.uploadQueuedReports(settings, {
				client: this.buildUploadClient(),
			})
			const eventUploadResult = await this.uploader.upload(settings, {
				client: this.buildUploadClient(),
			})

			const lastUpload: AiCodeStatsLastUpload = {
				status: "success",
				timestamp: Date.now(),
				uploadedEvents: reportUploadResult.uploadedBlocks + eventUploadResult.uploaded,
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

	private scheduleQueuedCommitUpload(): void {
		if (!this.uploadRequestedWhileRunning || this.isUploading) {
			return
		}

		void this.requestCommitTriggeredUpload().catch((error) => {
			console.error("[AiCodeStats] Failed to upload pending commit-triggered events:", error)
		})
	}

	private buildUploadClient() {
		const wrapper = getKiloCodeWrapperProperties()
		return {
			ide: this.ide,
			wrapperName: wrapper.kiloCodeWrapper || undefined,
			wrapperVersion: wrapper.kiloCodeWrapperVersion || undefined,
			extensionVersion: Package.version,
			machineId: vscode.env.machineId,
		}
	}
}
