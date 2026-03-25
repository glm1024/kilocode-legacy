import crypto from "crypto"
import { exec as execCallback } from "child_process"
import * as path from "path"
import { promisify } from "util"
import * as vscode from "vscode"

import { Package } from "../../shared/package"
import { getKiloCodeWrapperProperties } from "../../core/kilocode/wrapper"
import { AiCodeCommitAttributionService } from "./AiCodeCommitAttributionService"
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
	normalizePath,
	type AiCodeIde,
	type AiCodePendingLineAttribution,
	type AiCodeStatsEvent,
	type AiCodeStatsLastUpload,
	type AiCodeStatsRange,
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

const detectIde = (): AiCodeIde => {
	const wrapper = getKiloCodeWrapperProperties()
	return wrapper.kiloCodeWrapped && wrapper.kiloCodeWrapperJetbrains ? "jetbrains" : "vscode"
}

const resolveGitRepositoryRoot = async (cwd: string): Promise<string | undefined> => {
	try {
		const { stdout } = await execAsync("git rev-parse --show-toplevel", {
			cwd,
			maxBuffer: EXEC_MAX_BUFFER_BYTES,
		})
		const repoRoot = stdout.trim()
		return repoRoot ? normalizePath(path.resolve(repoRoot)) : undefined
	} catch {
		return undefined
	}
}

export interface AgentFileWriteRecord {
	cwd: string
	filePath: string
	relativePath?: string
	originalContent: string
	newContent: string
	taskId?: string
}

export interface AgentSuggestionRecord {
	originalContent: string
	newContent: string
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
			onCommitComparisonCompleted: async () => {
				await this.requestCommitTriggeredUpload()
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
		const filePath = normalizePath(path.resolve(record.filePath))
		const workspacePath = normalizePath(path.resolve(record.cwd))
		const workspaceName = path.basename(workspacePath)
		const relativePath = normalizePath(
			record.relativePath ? record.relativePath : toRelativePath(workspacePath, filePath),
		)
		// kilocode_change start
		const settings = await this.getUploadSettings()
		const metadata = await this.metadataResolver.resolve(workspacePath, filePath, settings)
		// kilocode_change end

		const blocks = this.extractor.extractAddedBlocks(record.originalContent, record.newContent, relativePath)
		if (blocks.length === 0) {
			return
		}

		const repoRoot = await resolveGitRepositoryRoot(path.dirname(filePath))
		const repoRelativePath =
			repoRoot && this.isPathInsideRepo(repoRoot, filePath)
				? normalizePath(path.relative(repoRoot, filePath))
				: undefined
		const lineOccurrenceIndexes = buildLineOccurrenceIndexes(record.newContent)
		const pendingLineAttributions: AiCodePendingLineAttribution[] = []

		for (const block of blocks) {
			const eventId = crypto.randomUUID()
			const timestamp = Date.now()
			const event: AiCodeStatsEvent = {
				eventId,
				timestamp,
				sourceType: "agent_insert",
				ide: this.ide,
				metricType: "generated",
				// kilocode_change start
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
				// kilocode_change end
				lineStart: block.lineStart,
				lineEnd: block.lineEnd,
				lineCount: block.lineCount,
				codeSnippet: block.codeSnippet,
				taskId: record.taskId,
				equivalentLineCount: block.lineCount,
			}
			await this.store.appendEvent(event)

			if (!repoRoot || !repoRelativePath) {
				continue
			}

			pendingLineAttributions.push(
				...this.buildPendingLineAttributions(
					event,
					repoRoot,
					repoRelativePath,
					block.lineStart,
					block.codeSnippet,
					lineOccurrenceIndexes,
				),
			)
		}

		if (pendingLineAttributions.length > 0) {
			await this.commitAttributionService.registerPendingLineAttributions(pendingLineAttributions)
		}
	}

	private buildPendingLineAttributions(
		event: AiCodeStatsEvent,
		repoRoot: string,
		repoRelativePath: string,
		lineStart: number,
		codeSnippet: string,
		lineOccurrenceIndexes: number[],
	): AiCodePendingLineAttribution[] {
		const lines = normalizeContentLines(codeSnippet)

		return lines.map((line, index) => {
			const lineNumber = lineStart + index
			const occurrenceIndex = lineOccurrenceIndexes[lineNumber - 1] ?? index + 1
			const lineFeatures = extractLineFeatures(line)
			return {
				id: crypto.randomUUID(),
				generatedEventId: event.eventId,
				blockId: event.eventId,
				timestamp: event.timestamp,
				sourceType: event.sourceType,
				ide: event.ide,
				userName: event.userName,
				userEmail: event.userEmail,
				organizationId: event.organizationId,
				organizationName: event.organizationName,
				sourceIp: event.sourceIp,
				workspaceName: event.workspaceName,
				workspacePath: event.workspacePath,
				projectKey: event.projectKey,
				filePath: event.filePath,
				relativePath: event.relativePath,
				repoRoot,
				repoRelativePath,
				language: event.language,
				gitRemoteUrl: event.gitRemoteUrl,
				gitBranch: event.gitBranch,
				taskId: event.taskId,
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

			const uploadResult = await this.uploader.upload(settings, {
				client: this.buildUploadClient(),
			})

			const lastUpload: AiCodeStatsLastUpload = {
				status: "success",
				timestamp: Date.now(),
				uploadedEvents: uploadResult.uploaded,
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
