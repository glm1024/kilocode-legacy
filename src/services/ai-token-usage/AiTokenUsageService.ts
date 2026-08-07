import { exec as execCallback } from "child_process"
import * as path from "path"
import { promisify } from "util"
import * as vscode from "vscode"

import { GitWatcher, type GitWatcherEvent } from "../../shared/GitWatcher"
import { getKiloCodeWrapperProperties } from "../../core/kilocode/wrapper"
import { AI_CODING_CLIENT_VERSION } from "../ai-code-stats/AiCodingClientVersion"
import { AiTokenUsageMetadataResolver } from "./AiTokenUsageMetadataResolver"
import { AiTokenUsageStore } from "./AiTokenUsageStore"
import { AiTokenUsageUploader } from "./AiTokenUsageUploader"
import {
	AI_TOKEN_USAGE_MAX_DATABASE_TIMESTAMP_MILLIS,
	AI_TOKEN_USAGE_MIN_DATABASE_TIMESTAMP_MILLIS,
	buildAnonymousUserKey,
	buildUserKey,
	normalizeConfiguredUserEmail,
	normalizeDimensionValue,
	normalizePath,
	type AiTokenUsageIde,
	type AiTokenUsageRange,
	type AiTokenUsageSummary,
	type AiTokenUsageUploadSettings,
} from "./types"

const execAsync = promisify(execCallback)
const EXEC_MAX_BUFFER_BYTES = 4 * 1024 * 1024
const TOKEN_USAGE_UPLOAD_DEBOUNCE_MS = 5_000
const TOKEN_USAGE_UPLOAD_RETRY_INTERVAL_MS = 5 * 60 * 1_000

const normalizeUsageCount = (value: number | undefined): number => {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		return 0
	}
	return Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value))
}

const normalizeOccurredAt = (value: number | undefined): number => {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return Date.now()
	}

	const occurredAt = Math.trunc(value)
	if (
		!Number.isSafeInteger(occurredAt) ||
		occurredAt < AI_TOKEN_USAGE_MIN_DATABASE_TIMESTAMP_MILLIS ||
		occurredAt > AI_TOKEN_USAGE_MAX_DATABASE_TIMESTAMP_MILLIS
	) {
		return Date.now()
	}
	return occurredAt
}

const safeTokenTotal = (inputTokens: number, outputTokens: number): number =>
	inputTokens > Number.MAX_SAFE_INTEGER - outputTokens ? Number.MAX_SAFE_INTEGER : inputTokens + outputTokens

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
	taskId?: string
	cwd: string
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
	private uploadRunPromise: Promise<void> | undefined
	private usageUploadTimer: NodeJS.Timeout | undefined
	private usageRetryTimer: NodeJS.Timeout | undefined

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
		if (this.started) {
			return
		}
		this.started = true
		void this.trackWorkspaceRepositoriesForCommitUpload().catch((error) => {
			console.error("[AiTokenUsage] Failed to track workspace repositories:", error)
		})
		void this.requestUpload().catch((error) => {
			console.error("[AiTokenUsage] Failed to resume pending token usage upload:", error)
		})
		this.usageRetryTimer = setInterval(() => {
			void this.requestUpload().catch((error) => {
				console.error("[AiTokenUsage] Failed to retry pending token usage upload:", error)
			})
		}, TOKEN_USAGE_UPLOAD_RETRY_INTERVAL_MS)
		this.usageRetryTimer.unref?.()
	}

	stop(): void {
		this.started = false
		this.clearUsageUploadTimer()
		if (this.usageRetryTimer) {
			clearInterval(this.usageRetryTimer)
			this.usageRetryTimer = undefined
		}
		for (const watcher of this.watchers.values()) {
			watcher.dispose()
		}
		this.watchers.clear()
	}

	async getSummary(range: AiTokenUsageRange): Promise<AiTokenUsageSummary> {
		return this.store.getSummaryForRange(range)
	}

	async recordRequestUsage(record: AiTokenUsageRequestRecord): Promise<void> {
		const inputTokens = normalizeUsageCount(record.inputTokens)
		const outputTokens = normalizeUsageCount(record.outputTokens)
		const cacheReadTokens = normalizeUsageCount(record.cacheReadTokens)
		const cacheWriteTokens = normalizeUsageCount(record.cacheWriteTokens)
		if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0 && cacheWriteTokens === 0) {
			return
		}

		const occurredAt = normalizeOccurredAt(record.occurredAt)
		const settings = await this.getUploadSettings()
		const repoRoot = (await resolveGitRepositoryRoot(record.cwd)) ?? normalizePath(path.resolve(record.cwd))
		const metadata = await this.metadataResolver.resolve(repoRoot, settings)
		const userName = normalizeDimensionValue(metadata.userName)
		const userEmail = normalizeConfiguredUserEmail(metadata.userEmail)
		const userKey = userEmail ? buildUserKey(userEmail) : buildAnonymousUserKey(vscode.env.machineId)
		const sourceIp = normalizeDimensionValue(metadata.sourceIp)
		const provider = normalizeDimensionValue(record.provider, "unknown")
		const model = normalizeDimensionValue(record.model, "unknown")
		const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"

		await this.store.recordUsage({
			taskId: record.taskId,
			occurredAt,
			timezone,
			userName,
			userEmail,
			departmentName: metadata.departmentName,
			officeName: metadata.officeName,
			teamName: metadata.teamName,
			sourceIp,
			userKey,
			organizationId: metadata.organizationId,
			organizationName: metadata.organizationName,
			projectKey: metadata.projectKey,
			projectName: metadata.projectName,
			repoRoot: metadata.repoRoot,
			gitRemoteUrl: metadata.gitRemoteUrl,
			gitBranch: metadata.gitBranch,
			ide: this.ide,
			provider,
			model,
			requestCount: 1,
			inputTokens,
			outputTokens,
			cacheReadTokens,
			cacheWriteTokens,
			totalTokens: safeTokenTotal(inputTokens, outputTokens),
			identityKind: userEmail ? "configured" : "anonymous",
		})

		if (!this.started) {
			return
		}

		this.scheduleUsageTriggeredUpload()
	}

	async trackRepositoryForCommitUpload(repoRoot: string): Promise<void> {
		const normalizedRepoRoot = normalizePath(path.resolve(repoRoot))
		if (this.started) {
			await this.ensureWatcher(normalizedRepoRoot)
		}
	}

	private async trackWorkspaceRepositoriesForCommitUpload(): Promise<void> {
		const workspaceFolders = vscode.workspace.workspaceFolders ?? []
		for (const folder of workspaceFolders) {
			const repoRoot = await resolveGitRepositoryRoot(folder.uri.fsPath)
			if (repoRoot) {
				await this.ensureWatcher(repoRoot)
			}
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
		this.clearUsageUploadTimer()
		await this.requestUpload()
	}

	private scheduleUsageTriggeredUpload(): void {
		this.clearUsageUploadTimer()
		this.usageUploadTimer = setTimeout(() => {
			this.usageUploadTimer = undefined
			void this.requestUpload().catch((error) => {
				console.error("[AiTokenUsage] Failed to upload token usage after model request:", error)
			})
		}, TOKEN_USAGE_UPLOAD_DEBOUNCE_MS)
	}

	private clearUsageUploadTimer(): void {
		if (!this.usageUploadTimer) {
			return
		}
		clearTimeout(this.usageUploadTimer)
		this.usageUploadTimer = undefined
	}

	private async requestUpload(): Promise<void> {
		if (this.uploadRunPromise) {
			this.uploadRequestedWhileRunning = true
			return this.uploadRunPromise
		}

		this.isUploading = true
		const runPromise = this.runUploadLoop()
		this.uploadRunPromise = runPromise
		try {
			await runPromise
		} finally {
			if (this.uploadRunPromise === runPromise) {
				this.uploadRunPromise = undefined
				this.isUploading = false
			}
		}
	}

	private async runUploadLoop(): Promise<void> {
		do {
			this.uploadRequestedWhileRunning = false
			await this.performIncrementalUpload()
		} while (this.uploadRequestedWhileRunning)
	}

	private async performIncrementalUpload(): Promise<void> {
		const settings = await this.getUploadSettings()
		if (!settings.webhookUrl?.trim()) {
			return
		}

		const result = await this.uploader.upload(settings, {
			client: this.buildUploadClient(),
		})
		if (result.blocked > 0 || result.invalid > 0) {
			console.warn(
				`[AiTokenUsage] Retained ${result.blocked} blocked and ${result.invalid} invalid Token usage row(s); inspect the persisted uploadIssueReason diagnostics`,
			)
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
