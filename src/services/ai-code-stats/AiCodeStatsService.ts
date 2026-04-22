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
import { AiCodeStatsUploader } from "./AiCodeStatsUploader"
import {
	AI_CODE_STATS_RETENTION_DAYS,
	CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
	normalizePath,
	type AiCodeAddedCodeBlock,
	type AiCodeCommitCandidateLine,
	type AiCodeCommitReport,
	type AiCodeGeneratedBlock,
	type AiCodeGeneratedBlockState,
	type AiCodeIde,
	type AiCodePatchHunk,
	type AiCodePendingLineAttribution,
	type AiCodeStatsEvent,
	type AiCodeStatsLastUpload,
	type AiCodeStatsUploadSettings,
} from "./types"

const execAsync = promisify(execCallback)
const EXEC_MAX_BUFFER_BYTES = 4 * 1024 * 1024

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
			onCommitCollected: async (payload) => {
				await this.handleCommitCollected(payload)
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
		if (blockAnalysis.acceptedBlocks.length === 0) {
			return
		}
		const timestamp = Date.now()

		// kilocode_change start
		const settings = await this.getUploadSettings()
		const metadata = await this.metadataResolver.resolve(context.repoRoot, context.filePath, settings)
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
		const patchHunks = this.extractor.extractPatchHunks(
			record.originalContent,
			record.newContent,
			context.repoRelativePath,
		)
		const nextBlocks = this.buildGeneratedBlocksForSnapshot({
			existingPendingBlocks,
			addedBlocks: blockAnalysis.acceptedBlocks,
			patchHunks,
			timestamp,
			finalContent: record.newContent,
			repoRoot: context.repoRoot,
			repoRelativePath: context.repoRelativePath,
			filePath: context.filePath,
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
		if (proposedGeneratedBlocks.length === 0) {
			return {
				acceptedBlocks: [],
			}
		}

		const acceptedBlocks = this.extractor.extractAddedBlocks(
			params.originalContent,
			params.finalAcceptedContent,
			params.filePath,
		)

		return {
			acceptedBlocks,
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

	private async handleCommitCollected(payload: AiCodeCommitFactsPayload): Promise<void> {
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
		if (pendingGeneratedBlocks.length === 0 && payload.changedFiles.length === 0) {
			return
		}

		const referenceBlock = pendingGeneratedBlocks[0]
		if (!referenceBlock) {
			return
		}
		const reportBranch = payload.branch || referenceBlock.gitBranch
		const reportBaselineBlocks = await this.buildCommitReportBaselineBlocks({
			pendingGeneratedBlocks,
			commitOccurredAt: payload.commitOccurredAt,
			gitBranch: reportBranch,
		})
		const reportAcceptedBlocks = reportBaselineBlocks.acceptedBlocks
		const candidateLines = await this.buildCommitReportCandidateLines({
			repoRoot: payload.repoRoot,
			changedPathSet,
			pendingGeneratedBlocks,
			acceptedBlocks: reportAcceptedBlocks,
			generatedBlocks: reportBaselineBlocks.generatedBlocks,
			gitBranch: reportBranch,
		})

		const reportGeneratedAt = Date.now()
		const report: AiCodeCommitReport = {
			version: "v2",
			source: "kilocode-ai-code-stats",
			mode: "commit_report",
			semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
			attributionInputVersion: 1,
			reportId: crypto.randomUUID(),
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
			})),
			candidateLines,
		}

		await this.store.queueCommitReport({
			report,
			createdAt: reportGeneratedAt,
			generatedBlockIds: pendingGeneratedBlocks.map((block) => block.generatedBlockId),
		})
		await this.requestCommitTriggeredUpload()
	}

	private async buildCommitReportCandidateLines(params: {
		repoRoot: string
		changedPathSet: Set<string>
		pendingGeneratedBlocks: AiCodeGeneratedBlockState[]
		acceptedBlocks: AiCodeGeneratedBlock[]
		generatedBlocks: AiCodeGeneratedBlock[]
		gitBranch?: string
	}): Promise<AiCodeCommitCandidateLine[]> {
		const pendingBlockIds = new Set(params.pendingGeneratedBlocks.map((block) => block.generatedBlockId))
		if (pendingBlockIds.size === 0) {
			return []
		}

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

			const lineStart = lineStartsByBlockId.get(generatedBlockId)
			const lineNumber =
				typeof lineStart === "number" ? lineStart + pendingLine.blockLineIndex - 1 : pendingLine.blockLineIndex
			candidateLines.push({
				clientLineId: `${pendingLine.id}:${pendingLine.lineHash}`,
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
			})
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
			departmentName: params.metadata.departmentName,
			officeName: params.metadata.officeName,
			teamName: params.metadata.teamName,
			userEmail: params.metadata.userEmail,
			organizationId: params.metadata.organizationId,
			organizationName: params.metadata.organizationName,
			sourceIp: params.metadata.sourceIp,
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
			userName: block.userName,
			departmentName: block.departmentName,
			officeName: block.officeName,
			teamName: block.teamName,
			userEmail: block.userEmail,
			organizationId: block.organizationId,
			organizationName: block.organizationName,
			sourceIp: block.sourceIp,
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

	private async performIncrementalUpload(trigger: "commit"): Promise<void> {
		try {
			await this.store.pruneOldData(AI_CODE_STATS_RETENTION_DAYS)
			const settings = await this.getUploadSettings()
			if (!settings.webhookUrl?.trim()) {
				return
			}

			const reportUploadResult = await this.uploader.uploadQueuedReports(settings)
			const eventUploadResult = await this.uploader.upload(settings, { client: this.buildUploadClient() })

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
