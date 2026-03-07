import crypto from "crypto"
import * as path from "path"
import * as vscode from "vscode"

import { Package } from "../../shared/package"
import { getKiloCodeWrapperProperties } from "../../core/kilocode/wrapper"
import { AiCodeDiffExtractor } from "./AiCodeDiffExtractor"
// kilocode_change start
import { AiCodeStatsMetadataResolver } from "./AiCodeStatsMetadataResolver"
// kilocode_change end
import { AiCodeStatsScheduler } from "./AiCodeStatsScheduler"
import { AiCodeStatsStore } from "./AiCodeStatsStore"
import { AiCodeStatsUploader } from "./AiCodeStatsUploader"
import {
	AI_CODE_STATS_BACKFILL_DAYS,
	AI_CODE_STATS_RETENTION_DAYS,
	AI_CODE_STATS_THRESHOLD,
	normalizePath,
	type AiCodeIde,
	type AiCodeStatsEvent,
	type AiCodeStatsLastUpload,
	type AiCodeStatsRange,
	type AiCodeStatsSummary,
	type AiCodeStatsUploadSettings,
} from "./types"

const toRelativePath = (workspacePath: string, filePath: string): string => {
	const relative = path.relative(workspacePath, filePath)
	return normalizePath(relative || path.basename(filePath))
}

const detectIde = (): AiCodeIde => {
	const wrapper = getKiloCodeWrapperProperties()
	return wrapper.kiloCodeWrapped && wrapper.kiloCodeWrapperJetbrains ? "jetbrains" : "vscode"
}

export interface AgentFileWriteRecord {
	cwd: string
	filePath: string
	relativePath?: string
	originalContent: string
	newContent: string
	taskId?: string
}

export interface AiCodeStatsManualUploadResult {
	uploadedEvents: number
	timestamp: number
}

export class AiCodeStatsService {
	private static instance: AiCodeStatsService | null = null

	private readonly store: AiCodeStatsStore
	private readonly uploader: AiCodeStatsUploader
	private readonly scheduler: AiCodeStatsScheduler
	private readonly extractor: AiCodeDiffExtractor
	// kilocode_change start
	private readonly metadataResolver: AiCodeStatsMetadataResolver
	// kilocode_change end
	private readonly ide: AiCodeIde
	private isUploading = false

	private constructor(
		globalStoragePath: string,
		private readonly getUploadSettings: () => Promise<AiCodeStatsUploadSettings>,
	) {
		this.store = new AiCodeStatsStore(globalStoragePath)
		this.uploader = new AiCodeStatsUploader(this.store)
		this.scheduler = new AiCodeStatsScheduler(13)
		this.extractor = new AiCodeDiffExtractor()
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
		this.scheduler.start(async () => {
			await this.runUpload("daily")
		})
	}

	stop(): void {
		this.scheduler.stop()
	}

	async getSummary(): Promise<AiCodeStatsSummary> {
		await this.store.pruneOldData(AI_CODE_STATS_RETENTION_DAYS)
		return this.store.getSummary()
	}

	async getGeneratedLines(range: AiCodeStatsRange): Promise<number> {
		await this.store.pruneOldData(AI_CODE_STATS_RETENTION_DAYS)
		return this.store.getGeneratedLinesForRange(range)
	}

	async triggerManualUpload(): Promise<void> {
		await this.runUpload("manual")
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

		for (const block of blocks) {
			const event: AiCodeStatsEvent = {
				eventId: crypto.randomUUID(),
				timestamp: Date.now(),
				sourceType: "agent_insert",
				ide: this.ide,
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
			}
			await this.store.appendEvent(event)
		}

		await this.maybeTriggerThresholdUpload()
	}

	private async maybeTriggerThresholdUpload(): Promise<void> {
		const pendingCount = await this.store.getPendingEventCount()
		if (pendingCount < AI_CODE_STATS_THRESHOLD) {
			return
		}

		await this.runUpload("threshold")
	}

	private async runUpload(trigger: "daily" | "threshold" | "manual"): Promise<void> {
		if (this.isUploading) {
			return
		}

		this.isUploading = true
		try {
			await this.store.pruneOldData(AI_CODE_STATS_RETENTION_DAYS)
			const settings = await this.getUploadSettings()
			if (!settings.webhookUrl?.trim()) {
				return
			}

			const uploadResult = await this.uploader.upload(settings, {
				backfillDays: AI_CODE_STATS_BACKFILL_DAYS,
				client: this.buildUploadClient(),
			})

			const uploadedEvents = uploadResult.incrementalUploaded + uploadResult.backfillUploaded
			const message = uploadResult.backfillError
				? `Incremental upload succeeded; backfill failed: ${uploadResult.backfillError}`
				: undefined

			const lastUpload: AiCodeStatsLastUpload = {
				status: "success",
				timestamp: Date.now(),
				uploadedEvents,
				mode: "incremental",
				trigger,
				message,
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
		} finally {
			this.isUploading = false
		}
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
