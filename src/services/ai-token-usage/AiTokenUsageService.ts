import { exec as execCallback } from "child_process"
import * as path from "path"
import { promisify } from "util"
import * as vscode from "vscode"

import { Package } from "../../shared/package"
import { GitWatcher, type GitWatcherEvent } from "../../shared/GitWatcher"
import { getKiloCodeWrapperProperties } from "../../core/kilocode/wrapper"
import { AiTokenUsageMetadataResolver } from "./AiTokenUsageMetadataResolver"
import { AiTokenUsageStore } from "./AiTokenUsageStore"
import { AiTokenUsageUploader } from "./AiTokenUsageUploader"
import {
	buildUserKey,
	normalizeDimensionValue,
	normalizePath,
	type AiCodeStatsRange,
	type AiTokenUsageIde,
	type AiTokenUsageSummary,
	type AiTokenUsageUploadSettings,
} from "./types"

const execAsync = promisify(execCallback)
const EXEC_MAX_BUFFER_BYTES = 4 * 1024 * 1024

const detectIde = (): AiTokenUsageIde => {
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

export interface AiTokenUsageRequestRecord {
	workspacePath: string
	provider?: string
	model?: string
	inputTokens: number
	outputTokens: number
	cacheReadTokens?: number
	cacheWriteTokens?: number
	occurredAt?: number
}

export class AiTokenUsageService {
	private static instance: AiTokenUsageService | null = null

	private readonly store: AiTokenUsageStore
	private readonly uploader: AiTokenUsageUploader
	private readonly metadataResolver: AiTokenUsageMetadataResolver
	private readonly ide: AiTokenUsageIde
	private readonly watchers = new Map<string, GitWatcher>()
	private started = false
	private isUploading = false
	private uploadRequestedWhileRunning = false

	private constructor(
		globalStoragePath: string,
		private readonly getUploadSettings: () => Promise<AiTokenUsageUploadSettings>,
	) {
		this.store = new AiTokenUsageStore(globalStoragePath)
		this.uploader = new AiTokenUsageUploader(this.store)
		this.metadataResolver = new AiTokenUsageMetadataResolver()
		this.ide = detectIde()
	}

	static initialize(
		globalStoragePath: string,
		getUploadSettings: () => Promise<AiTokenUsageUploadSettings>,
	): AiTokenUsageService {
		if (!AiTokenUsageService.instance) {
			AiTokenUsageService.instance = new AiTokenUsageService(globalStoragePath, getUploadSettings)
		}
		return AiTokenUsageService.instance
	}

	static getInstance(): AiTokenUsageService | null {
		return AiTokenUsageService.instance
	}

	static disposeInstance(): void {
		AiTokenUsageService.instance?.stop()
		AiTokenUsageService.instance = null
	}

	start(): void {
		this.started = true
	}

	stop(): void {
		this.started = false
		for (const watcher of this.watchers.values()) {
			watcher.dispose()
		}
		this.watchers.clear()
	}

	async getSummary(range: AiCodeStatsRange): Promise<AiTokenUsageSummary> {
		return this.store.getSummaryForRange(range)
	}

	async recordRequestUsage(record: AiTokenUsageRequestRecord): Promise<void> {
		const inputTokens = Math.max(0, Math.trunc(record.inputTokens || 0))
		const outputTokens = Math.max(0, Math.trunc(record.outputTokens || 0))
		const cacheReadTokens = Math.max(0, Math.trunc(record.cacheReadTokens || 0))
		const cacheWriteTokens = Math.max(0, Math.trunc(record.cacheWriteTokens || 0))
		if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0 && cacheWriteTokens === 0) {
			return
		}

		const occurredAt = record.occurredAt ?? Date.now()
		const workspacePath = normalizePath(path.resolve(record.workspacePath))
		const workspaceName = path.basename(workspacePath)
		const settings = await this.getUploadSettings()
		const metadata = await this.metadataResolver.resolve(workspacePath, settings)
		const userName = normalizeDimensionValue(metadata.userName)
		const sourceIp = normalizeDimensionValue(metadata.sourceIp)
		const projectKey = normalizeDimensionValue(metadata.projectKey, "unknown-project")
		const provider = normalizeDimensionValue(record.provider)
		const model = normalizeDimensionValue(record.model)
		const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"

		await this.store.recordUsage({
			occurredAt,
			timezone,
			userName,
			sourceIp,
			userKey: buildUserKey(userName, sourceIp),
			organizationId: metadata.organizationId,
			organizationName: metadata.organizationName,
			workspaceName,
			projectKey,
			ide: this.ide,
			provider,
			model,
			requestCount: 1,
			inputTokens,
			outputTokens,
			cacheReadTokens,
			cacheWriteTokens,
			totalTokens: inputTokens + outputTokens,
		})

		if (!this.started) {
			return
		}

		const repoRoot = await resolveGitRepositoryRoot(workspacePath)
		if (repoRoot) {
			await this.ensureWatcher(repoRoot)
		}
	}

	private async ensureWatcher(repoRoot: string): Promise<void> {
		const normalizedRepoRoot = normalizePath(path.resolve(repoRoot))
		if (this.watchers.has(normalizedRepoRoot)) {
			return
		}

		const watcher = new GitWatcher({ cwd: normalizedRepoRoot })
		watcher.onEvent((event: GitWatcherEvent) => {
			if (event.type !== "commit") {
				return
			}
			void this.requestCommitTriggeredUpload().catch((error) => {
				console.error("[AiTokenUsage] Failed to upload token usage after commit:", error)
			})
		})
		await watcher.start()
		this.watchers.set(normalizedRepoRoot, watcher)
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
				await this.performIncrementalUpload()
			} while (this.uploadRequestedWhileRunning)
		} finally {
			this.isUploading = false
		}
	}

	private async performIncrementalUpload(): Promise<void> {
		const settings = await this.getUploadSettings()
		if (!settings.webhookUrl?.trim()) {
			return
		}

		await this.uploader.upload(settings, {
			client: this.buildUploadClient(),
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
