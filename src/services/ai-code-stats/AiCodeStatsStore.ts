import * as fs from "fs/promises"
import * as path from "path"

import { safeWriteJson } from "../../utils/safeWriteJson"
import { hashLineFingerprint } from "./AiCodeLineFingerprint"
import { AiCodeUploadEventQueue } from "./AiCodeUploadEventQueue"
import {
	AI_CODE_STATS_VERSION,
	CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
	normalizePath,
	toLocalDateKey,
	type AiCodeGeneratedBlock,
	type AiCodePendingCommitMetricBlock,
	type AiCodeGeneratedBlockState,
	type AiCodePendingLineAttribution,
	type AiCodeQueuedCommitReport,
	type AiCodeStatsEvent,
	type AiCodeStatsLastUpload,
	type AiCodeStatsPersistedState,
} from "./types"

const STATE_FILE = "state.json"
const PENDING_LINES_FILE = "pending-lines.json"
const GENERATED_BLOCKS_FILE = "generated-blocks.json"
const QUEUED_REPORTS_FILE = "queued-reports.json"
const PENDING_COMMIT_METRIC_BLOCKS_FILE = "pending-commit-metric-blocks.json"

const createEmptyState = (): AiCodeStatsPersistedState => ({
	version: AI_CODE_STATS_VERSION,
	pendingEventIds: [],
	supersededEventIds: [],
	repoObservedCommits: {},
	lastUpload: { status: "idle" },
})

const isCurrentSemanticsVersion = (semanticsVersion?: number): boolean =>
	semanticsVersion === CURRENT_AI_CODE_STATS_SEMANTICS_VERSION

export class AiCodeStatsStore {
	private readonly baseDir: string
	private readonly uploadEventQueue: AiCodeUploadEventQueue
	private readonly statePath: string
	private readonly pendingLinesPath: string
	private readonly generatedBlocksPath: string
	private readonly queuedReportsPath: string
	private readonly pendingCommitMetricBlocksPath: string
	private state: AiCodeStatsPersistedState | null = null
	private pendingLines: AiCodePendingLineAttribution[] = []
	private generatedBlocks: AiCodeGeneratedBlockState[] = []
	private queuedReports: AiCodeQueuedCommitReport[] = []
	private pendingCommitMetricBlocks: AiCodePendingCommitMetricBlock[] = []
	private loadPromise: Promise<void> | null = null
	private operationQueue: Promise<void> = Promise.resolve()

	constructor(globalStoragePath: string) {
		this.baseDir = path.join(globalStoragePath, "ai-code-stats", "v1")
		this.uploadEventQueue = new AiCodeUploadEventQueue(this.baseDir)
		this.statePath = path.join(this.baseDir, STATE_FILE)
		this.pendingLinesPath = path.join(this.baseDir, PENDING_LINES_FILE)
		this.generatedBlocksPath = path.join(this.baseDir, GENERATED_BLOCKS_FILE)
		this.queuedReportsPath = path.join(this.baseDir, QUEUED_REPORTS_FILE)
		this.pendingCommitMetricBlocksPath = path.join(this.baseDir, PENDING_COMMIT_METRIC_BLOCKS_FILE)
	}

	async appendEvent(event: AiCodeStatsEvent): Promise<void> {
		await this.enqueue(async () => {
			await this.ensureLoaded()
			await this.appendUploadEventsToQueue([event], true)
		})
	}

	async queueCommitReport(report: AiCodeQueuedCommitReport): Promise<void> {
		await this.enqueue(async () => {
			await this.ensureLoaded()
			const normalizedReport = this.normalizeQueuedReport(report)
			if (this.queuedReports.some((item) => item.report.reportId === normalizedReport.report.reportId)) {
				return
			}

			const queuedGeneratedIds = new Set(normalizedReport.generatedBlockIds)
			this.generatedBlocks = this.generatedBlocks.map((block) => {
				if (!queuedGeneratedIds.has(block.generatedBlockId)) {
					return block
				}
				return {
					...block,
					uploadStatus: "queued",
					queuedReportId: normalizedReport.report.reportId,
				}
			})
			this.pendingCommitMetricBlocks = this.pendingCommitMetricBlocks.filter(
				(block) => !queuedGeneratedIds.has(block.generatedBlockId),
			)
			this.queuedReports.push(normalizedReport)
			await this.persistGeneratedBlocks()
			await this.persistPendingCommitMetricBlocks()
			await this.persistQueuedReports()
		})
	}

	async getQueuedCommitReports(): Promise<AiCodeQueuedCommitReport[]> {
		await this.ensureLoaded()
		return this.queuedReports
			.slice()
			.sort(
				(left, right) =>
					left.createdAt - right.createdAt ||
					left.report.commitOccurredAt - right.report.commitOccurredAt ||
					left.report.reportId.localeCompare(right.report.reportId),
			)
			.map((report) => this.normalizeQueuedReport(report))
	}

	async acknowledgeQueuedCommitReport(reportId: string): Promise<void> {
		await this.enqueue(async () => {
			await this.ensureLoaded()
			const target = this.queuedReports.find((report) => report.report.reportId === reportId)
			if (!target) {
				return
			}

			this.queuedReports = this.queuedReports.filter((report) => report.report.reportId !== reportId)
			const uploadedIds = new Set(target.generatedBlockIds)
			this.generatedBlocks = this.generatedBlocks.map((block) => {
				if (!uploadedIds.has(block.generatedBlockId)) {
					return block
				}
				if (block.queuedReportId && block.queuedReportId !== reportId) {
					return block
				}
				return {
					...block,
					uploadStatus: "uploaded",
					queuedReportId: undefined,
				}
			})
			if (this.pruneRepoObservedCommits(this.state!)) {
				await this.persistState()
			}
			this.pruneInactiveUploadedBlocks()
			await this.persistGeneratedBlocks()
			await this.persistPendingLines()
			await this.persistQueuedReports()
		})
	}

	async getGeneratedBlockStates(): Promise<AiCodeGeneratedBlockState[]> {
		await this.ensureLoaded()
		return this.generatedBlocks.map((block) => this.normalizeGeneratedBlockState(block))
	}

	async getPendingGeneratedBlockStates(repoRoot?: string): Promise<AiCodeGeneratedBlockState[]> {
		await this.ensureLoaded()
		const normalizedRepoRoot = repoRoot ? normalizePath(path.resolve(repoRoot)) : undefined
		return this.generatedBlocks
			.filter((block) => block.uploadStatus === "pending")
			.filter((block) => !normalizedRepoRoot || block.repoRoot === normalizedRepoRoot)
			.map((block) => this.normalizeGeneratedBlockState(block))
	}

	async addPendingCommitMetricBlocks(blocks: AiCodePendingCommitMetricBlock[]): Promise<void> {
		if (blocks.length === 0) {
			return
		}

		await this.enqueue(async () => {
			await this.ensureLoaded()
			const existingIds = new Set(this.pendingCommitMetricBlocks.map((block) => block.eventId))
			let changed = false
			for (const block of blocks) {
				const normalized = this.normalizePendingCommitMetricBlock(block)
				if (existingIds.has(normalized.eventId)) {
					continue
				}
				this.pendingCommitMetricBlocks.push(normalized)
				existingIds.add(normalized.eventId)
				changed = true
			}
			if (changed) {
				await this.persistPendingCommitMetricBlocks()
			}
		})
	}

	async getPendingCommitMetricBlocks(generatedBlockIds?: string[]): Promise<AiCodePendingCommitMetricBlock[]> {
		await this.ensureLoaded()
		const generatedIdSet =
			Array.isArray(generatedBlockIds) && generatedBlockIds.length > 0 ? new Set(generatedBlockIds) : undefined
		return this.pendingCommitMetricBlocks
			.filter((block) => !generatedIdSet || generatedIdSet.has(block.generatedBlockId))
			.sort(
				(left, right) =>
					left.timestamp - right.timestamp ||
					left.relativePath.localeCompare(right.relativePath) ||
					left.lineStart - right.lineStart ||
					left.eventId.localeCompare(right.eventId),
			)
			.map((block) => ({ ...block }))
	}

	async replaceGeneratedStateForContext(params: {
		filePath: string
		taskId?: string
		sourceType: AiCodeGeneratedBlockState["sourceType"]
		nextBlocks: AiCodeGeneratedBlockState[]
		nextPendingLines: AiCodePendingLineAttribution[]
	}): Promise<void> {
		await this.enqueue(async () => {
			await this.ensureLoaded()
			const normalizedFilePath = normalizePath(path.resolve(params.filePath))
			const contextTaskId = params.taskId?.trim() || ""
			const contextSourceType = params.sourceType

			this.generatedBlocks = this.generatedBlocks.filter(
				(block) =>
					!(
						normalizePath(path.resolve(block.filePath)) === normalizedFilePath &&
						(block.taskId?.trim() || "") === contextTaskId &&
						block.sourceType === contextSourceType &&
						block.uploadStatus === "pending"
					),
			)
			this.generatedBlocks.push(...params.nextBlocks.map((block) => this.normalizeGeneratedBlockState(block)))

			this.pendingLines = this.pendingLines.filter(
				(line) =>
					!(
						normalizePath(path.resolve(line.filePath)) === normalizedFilePath &&
						(line.taskId?.trim() || "") === contextTaskId &&
						line.sourceType === contextSourceType
					),
			)
			this.pendingLines.push(...params.nextPendingLines.map((line) => this.normalizePendingLine(line)))

			if (this.pruneRepoObservedCommits(this.state!)) {
				await this.persistState()
			}
			await this.persistGeneratedBlocks()
			await this.persistPendingLines()
		})
	}

	async getPendingEventCount(): Promise<number> {
		await this.ensureLoaded()
		const pendingStandaloneEvents = (await this.getPendingEvents()).length
		const pendingCommitMetricEvents = this.pendingCommitMetricBlocks.length * 2
		const pendingGeneratedBlocks = this.generatedBlocks.filter(
			(block) => block.uploadStatus === "pending" || block.uploadStatus === "queued",
		).length
		return pendingStandaloneEvents + pendingCommitMetricEvents + pendingGeneratedBlocks
	}

	async getPendingEvents(maxEvents?: number): Promise<AiCodeStatsEvent[]> {
		await this.ensureLoaded()
		return this.uploadEventQueue.getPendingEvents(
			new Set(this.state!.pendingEventIds),
			new Set(this.state!.supersededEventIds),
			maxEvents,
		)
	}

	async addPendingLineAttributions(lines: AiCodePendingLineAttribution[]): Promise<void> {
		if (lines.length === 0) {
			return
		}

		await this.enqueue(async () => {
			await this.ensureLoaded()
			const existingIds = new Set(this.pendingLines.map((line) => line.id))
			let changed = false
			for (const line of lines) {
				if (existingIds.has(line.id)) {
					continue
				}
				this.pendingLines.push(this.normalizePendingLine(line))
				existingIds.add(line.id)
				changed = true
			}
			if (changed) {
				await this.persistPendingLines()
			}
		})
	}

	async getPendingLineAttributions(repoRoot?: string): Promise<AiCodePendingLineAttribution[]> {
		await this.ensureLoaded()
		const normalizedRepoRoot = repoRoot ? normalizePath(path.resolve(repoRoot)) : undefined
		return this.pendingLines
			.filter((line) => !normalizedRepoRoot || line.repoRoot === normalizedRepoRoot)
			.map((line) => ({ ...line }))
	}

	async removePendingLineAttributions(ids: string[]): Promise<void> {
		if (ids.length === 0) {
			return
		}

		await this.enqueue(async () => {
			await this.ensureLoaded()
			const state = this.state!
			const removalIds = new Set(ids)
			const nextPendingLines = this.pendingLines.filter((line) => !removalIds.has(line.id))
			if (nextPendingLines.length === this.pendingLines.length) {
				return
			}

			this.pendingLines = nextPendingLines
			const repoObservedCommitsChanged = this.pruneRepoObservedCommits(state)
			if (repoObservedCommitsChanged) {
				await this.persistState()
			}
			this.pruneInactiveUploadedBlocks()
			await this.persistGeneratedBlocks()
			await this.persistPendingLines()
		})
	}

	async getRepoObservedCommit(repoRoot: string): Promise<string | undefined> {
		await this.ensureLoaded()
		const normalizedRepoRoot = normalizePath(path.resolve(repoRoot))
		return this.state!.repoObservedCommits[normalizedRepoRoot]
	}

	async setRepoObservedCommit(repoRoot: string, commitSha: string): Promise<void> {
		if (!commitSha.trim()) {
			return
		}

		await this.enqueue(async () => {
			await this.ensureLoaded()
			const state = this.state!
			const normalizedRepoRoot = normalizePath(path.resolve(repoRoot))
			if (state.repoObservedCommits[normalizedRepoRoot] === commitSha) {
				return
			}
			state.repoObservedCommits[normalizedRepoRoot] = commitSha
			await this.persistState()
		})
	}

	async removeRepoObservedCommit(repoRoot: string): Promise<void> {
		await this.enqueue(async () => {
			await this.ensureLoaded()
			const state = this.state!
			const normalizedRepoRoot = normalizePath(path.resolve(repoRoot))
			if (!(normalizedRepoRoot in state.repoObservedCommits)) {
				return
			}
			delete state.repoObservedCommits[normalizedRepoRoot]
			await this.persistState()
		})
	}

	async setLastUploadStatus(lastUpload: AiCodeStatsLastUpload): Promise<void> {
		await this.enqueue(async () => {
			await this.ensureLoaded()
			const state = this.state!
			state.lastUpload = lastUpload
			await this.persistState()
		})
	}

	async markEventsUploaded(eventIds: string[]): Promise<void> {
		if (eventIds.length === 0) {
			return
		}

		await this.enqueue(async () => {
			await this.ensureLoaded()
			const uploadedSet = new Set(eventIds)
			this.state!.pendingEventIds = this.state!.pendingEventIds.filter((id) => !uploadedSet.has(id))
			await this.persistState()
		})
	}

	async pruneOldData(retentionDays: number, nowTs: number = Date.now()): Promise<void> {
		if (retentionDays <= 0) {
			return
		}

		await this.enqueue(async () => {
			await this.ensureLoaded()
			const cutoff = new Date(nowTs)
			cutoff.setHours(0, 0, 0, 0)
			cutoff.setDate(cutoff.getDate() - (retentionDays - 1))
			const cutoffKey = toLocalDateKey(cutoff.getTime())
			const cutoffTimestamp = cutoff.getTime()

			const state = this.state!
			const pendingIds = new Set(state.pendingEventIds)
			const supersededIds = new Set(state.supersededEventIds)
			for (const eventId of await this.uploadEventQueue.pruneBefore(cutoffKey)) {
				pendingIds.delete(eventId)
				supersededIds.delete(eventId)
			}
			state.pendingEventIds = [...pendingIds]
			state.supersededEventIds = [...supersededIds]
			this.pendingLines = this.pendingLines.filter((line) => line.timestamp >= cutoffTimestamp)
			this.pendingCommitMetricBlocks = this.pendingCommitMetricBlocks.filter(
				(block) => block.timestamp >= cutoffTimestamp,
			)
			this.generatedBlocks = this.generatedBlocks.filter((block) => {
				if (block.uploadStatus !== "uploaded") {
					return true
				}
				return block.timestamp >= cutoffTimestamp
			})
			await this.persistState()
			await this.persistPendingLines()
			await this.persistPendingCommitMetricBlocks()
			await this.persistGeneratedBlocks()
		})
	}

	private async ensureLoaded(): Promise<void> {
		if (this.state) {
			return
		}
		if (!this.loadPromise) {
			this.loadPromise = this.load()
		}
		await this.loadPromise
	}

	private async load(): Promise<void> {
		await fs.mkdir(this.baseDir, { recursive: true })
		await this.uploadEventQueue.ensureReady()

		let shouldResetStorage = false
		try {
			const raw = await fs.readFile(this.statePath, "utf8")
			const parsed = JSON.parse(raw) as Partial<AiCodeStatsPersistedState>
			if (parsed.version !== AI_CODE_STATS_VERSION) {
				shouldResetStorage = true
			} else {
				this.state = {
					version: AI_CODE_STATS_VERSION,
					pendingEventIds: this.normalizeEventIds(parsed.pendingEventIds),
					supersededEventIds: this.normalizeEventIds(parsed.supersededEventIds),
					repoObservedCommits: this.normalizeRepoObservedCommits(parsed.repoObservedCommits),
					lastUpload: parsed.lastUpload ?? { status: "idle" },
				}
			}
		} catch (error) {
			const isMissingStateFile =
				typeof error === "object" &&
				error !== null &&
				"code" in error &&
				(error as NodeJS.ErrnoException).code === "ENOENT"
			if (!isMissingStateFile) {
				shouldResetStorage = true
			}
		}

		if (shouldResetStorage) {
			await fs.rm(this.baseDir, { recursive: true, force: true })
			await fs.mkdir(this.baseDir, { recursive: true })
			await this.uploadEventQueue.ensureReady()
			this.state = createEmptyState()
			this.pendingLines = []
			this.generatedBlocks = []
			this.queuedReports = []
			this.pendingCommitMetricBlocks = []
			await this.persistState()
			await this.persistPendingLines()
			await this.persistGeneratedBlocks()
			await this.persistPendingCommitMetricBlocks()
			await this.persistQueuedReports()
			return
		}

		if (!this.state) {
			this.state = createEmptyState()
			await this.persistState()
		}

		try {
			const raw = await fs.readFile(this.pendingLinesPath, "utf8")
			const parsed = JSON.parse(raw)
			this.pendingLines = Array.isArray(parsed)
				? parsed.map((line) => this.normalizePendingLine(line as AiCodePendingLineAttribution))
				: []
		} catch {
			this.pendingLines = []
			await this.persistPendingLines()
		}

		try {
			const raw = await fs.readFile(this.generatedBlocksPath, "utf8")
			const parsed = JSON.parse(raw)
			this.generatedBlocks = Array.isArray(parsed)
				? parsed
						.filter(
							(block): block is AiCodeGeneratedBlockState =>
								typeof block === "object" &&
								block !== null &&
								isCurrentSemanticsVersion((block as AiCodeGeneratedBlockState).semanticsVersion),
						)
						.map((block) => this.normalizeGeneratedBlockState(block))
				: []
		} catch {
			this.generatedBlocks = []
			await this.persistGeneratedBlocks()
		}

		try {
			const raw = await fs.readFile(this.queuedReportsPath, "utf8")
			const parsed = JSON.parse(raw)
			this.queuedReports = Array.isArray(parsed)
				? parsed
						.filter(
							(report): report is AiCodeQueuedCommitReport =>
								typeof report === "object" &&
								report !== null &&
								isCurrentSemanticsVersion(
									(report as AiCodeQueuedCommitReport).report?.semanticsVersion,
								),
						)
						.map((report) => this.normalizeQueuedReport(report))
				: []
		} catch {
			this.queuedReports = []
			await this.persistQueuedReports()
		}

		try {
			const raw = await fs.readFile(this.pendingCommitMetricBlocksPath, "utf8")
			const parsed = JSON.parse(raw)
			this.pendingCommitMetricBlocks = Array.isArray(parsed)
				? parsed
						.filter(
							(block): block is AiCodePendingCommitMetricBlock =>
								typeof block === "object" &&
								block !== null &&
								isCurrentSemanticsVersion((block as AiCodePendingCommitMetricBlock).semanticsVersion),
						)
						.map((block) => this.normalizePendingCommitMetricBlock(block))
				: []
		} catch {
			this.pendingCommitMetricBlocks = []
			await this.persistPendingCommitMetricBlocks()
		}

		if (this.pruneRepoObservedCommits(this.state!)) {
			await this.persistState()
		}
		this.pruneInactiveUploadedBlocks()
	}

	private async appendUploadEventsToQueue(events: AiCodeStatsEvent[], markPending: boolean): Promise<void> {
		const uploadableEvents = events.filter(
			(event) => event.metricType === "generated" || event.metricType === "accepted",
		)
		const state = this.state!
		let stateChanged = false
		for (const event of uploadableEvents) {
			if (markPending && !state.pendingEventIds.includes(event.eventId)) {
				state.pendingEventIds.push(event.eventId)
				stateChanged = true
			}
		}

		await this.uploadEventQueue.append(uploadableEvents)
		if (stateChanged) {
			await this.persistState()
		}
	}

	private async persistState(): Promise<void> {
		await safeWriteJson(this.statePath, this.state)
	}

	private async persistPendingLines(): Promise<void> {
		await safeWriteJson(this.pendingLinesPath, this.pendingLines)
	}

	private async persistGeneratedBlocks(): Promise<void> {
		await safeWriteJson(this.generatedBlocksPath, this.generatedBlocks)
	}

	private async persistPendingCommitMetricBlocks(): Promise<void> {
		await safeWriteJson(this.pendingCommitMetricBlocksPath, this.pendingCommitMetricBlocks)
	}

	private async persistQueuedReports(): Promise<void> {
		await safeWriteJson(this.queuedReportsPath, this.queuedReports)
	}

	private normalizePendingCommitMetricBlock(block: AiCodePendingCommitMetricBlock): AiCodePendingCommitMetricBlock {
		const lineStart = typeof block.lineStart === "number" && block.lineStart > 0 ? block.lineStart : 1
		const lineCount =
			typeof block.lineCount === "number" && block.lineCount > 0
				? block.lineCount
				: typeof block.codeSnippet === "string"
					? Math.max(1, block.codeSnippet.split(/\r?\n/).length)
					: 1
		const lineEnd =
			typeof block.lineEnd === "number" && block.lineEnd >= lineStart ? block.lineEnd : lineStart + lineCount - 1
		return {
			...block,
			eventId: block.eventId || block.generatedBlockId,
			generatedBlockId: block.generatedBlockId || block.eventId,
			timestamp: typeof block.timestamp === "number" ? block.timestamp : Date.now(),
			semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
			repoRoot: block.repoRoot ? normalizePath(block.repoRoot) : undefined,
			repoRelativePath: block.repoRelativePath ? normalizePath(block.repoRelativePath) : undefined,
			filePath: normalizePath(block.filePath),
			relativePath: normalizePath(block.relativePath),
			lineStart,
			lineEnd,
			lineCount,
			codeSnippet: typeof block.codeSnippet === "string" ? block.codeSnippet : "",
			fileSnapshotContent: typeof block.fileSnapshotContent === "string" ? block.fileSnapshotContent : undefined,
		}
	}

	private normalizeEventIds(eventIds: unknown): string[] {
		if (!Array.isArray(eventIds)) {
			return []
		}
		return [
			...new Set(
				eventIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0),
			),
		]
	}

	private normalizeRepoObservedCommits(
		repoObservedCommits: Partial<Record<string, unknown>> | undefined,
	): Record<string, string> {
		const normalized: Record<string, string> = {}
		for (const [repoRoot, commitSha] of Object.entries(repoObservedCommits ?? {})) {
			if (typeof commitSha !== "string" || !commitSha.trim()) {
				continue
			}
			normalized[normalizePath(path.resolve(repoRoot))] = commitSha
		}
		return normalized
	}

	private normalizeGeneratedBlockState(block: AiCodeGeneratedBlockState): AiCodeGeneratedBlockState {
		const currentLineStart =
			typeof block.currentLineStart === "number" && block.currentLineStart > 0
				? block.currentLineStart
				: typeof block.lineStart === "number" && block.lineStart > 0
					? block.lineStart
					: 1
		const currentCodeSnippet =
			typeof block.currentCodeSnippet === "string"
				? block.currentCodeSnippet
				: typeof block.codeSnippet === "string"
					? block.codeSnippet
					: ""
		const currentLineCount =
			typeof block.currentLineCount === "number" && block.currentLineCount > 0
				? block.currentLineCount
				: typeof block.lineCount === "number" && block.lineCount > 0
					? block.lineCount
					: Math.max(1, currentCodeSnippet.split(/\r?\n/).length)
		const currentLineEnd =
			typeof block.currentLineEnd === "number" && block.currentLineEnd >= currentLineStart
				? block.currentLineEnd
				: typeof block.lineEnd === "number" && block.lineEnd >= currentLineStart
					? block.lineEnd
					: currentLineStart + currentLineCount - 1
		const currentTimestamp =
			typeof block.currentTimestamp === "number"
				? block.currentTimestamp
				: typeof block.timestamp === "number"
					? block.timestamp
					: Date.now()
		const currentFileSnapshotContent =
			typeof block.currentFileSnapshotContent === "string"
				? block.currentFileSnapshotContent
				: typeof block.fileSnapshotContent === "string"
					? block.fileSnapshotContent
					: undefined
		const originLineStart =
			typeof block.originLineStart === "number" && block.originLineStart > 0
				? block.originLineStart
				: currentLineStart
		const originCodeSnippet =
			typeof block.originCodeSnippet === "string" ? block.originCodeSnippet : currentCodeSnippet
		const originLineCount =
			typeof block.originLineCount === "number" && block.originLineCount > 0
				? block.originLineCount
				: Math.max(1, originCodeSnippet.split(/\r?\n/).length)
		const originLineEnd =
			typeof block.originLineEnd === "number" && block.originLineEnd >= originLineStart
				? block.originLineEnd
				: originLineStart + originLineCount - 1
		const originTimestamp = typeof block.originTimestamp === "number" ? block.originTimestamp : currentTimestamp
		const originFileSnapshotContent =
			typeof block.originFileSnapshotContent === "string"
				? block.originFileSnapshotContent
				: currentFileSnapshotContent
		return {
			...block,
			stateId: block.stateId || block.generatedBlockId || block.eventId,
			generatedBlockId: block.generatedBlockId || block.eventId,
			eventId: block.eventId || block.generatedBlockId || block.stateId,
			semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
			filePath: normalizePath(block.filePath),
			relativePath: normalizePath(block.relativePath),
			repoRoot: block.repoRoot ? normalizePath(block.repoRoot) : undefined,
			repoRelativePath: block.repoRelativePath ? normalizePath(block.repoRelativePath) : undefined,
			originEventId: block.originEventId || `${block.generatedBlockId || block.eventId}:generated`,
			originTimestamp,
			originLineStart,
			originLineEnd,
			originLineCount,
			originCodeSnippet,
			originFileSnapshotContent,
			currentTimestamp,
			currentLineStart,
			currentLineEnd,
			currentLineCount,
			currentCodeSnippet,
			currentFileSnapshotContent,
			timestamp: currentTimestamp,
			lineStart: currentLineStart,
			lineCount: currentLineCount,
			lineEnd: currentLineEnd,
			codeSnippet: currentCodeSnippet,
			fileSnapshotContent: currentFileSnapshotContent,
			uploadStatus:
				block.uploadStatus === "queued" || block.uploadStatus === "uploaded" ? block.uploadStatus : "pending",
		}
	}

	private normalizeQueuedReport(report: AiCodeQueuedCommitReport): AiCodeQueuedCommitReport {
		return {
			createdAt: typeof report.createdAt === "number" ? report.createdAt : Date.now(),
			generatedBlockIds: Array.isArray(report.generatedBlockIds) ? [...new Set(report.generatedBlockIds)] : [],
			report: {
				version: "v2",
				source: "kilocode-ai-code-stats",
				mode: "commit_report",
				semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
				attributionInputVersion: 1,
				reportId: report.report.reportId,
				reportGeneratedAt:
					typeof report.report.reportGeneratedAt === "number" ? report.report.reportGeneratedAt : Date.now(),
				client: report.report.client,
				repoRoot: normalizePath(report.report.repoRoot),
				projectKey: report.report.projectKey,
				projectName: report.report.projectName,
				gitRemoteUrl: report.report.gitRemoteUrl,
				gitBranch: report.report.gitBranch,
				commitHash: report.report.commitHash,
				previousCommitHash: report.report.previousCommitHash,
				commitOccurredAt: report.report.commitOccurredAt,
				acceptedBlocks: (report.report.acceptedBlocks ?? []).map((block) =>
					this.normalizeGeneratedBlockState({
						...block,
						stateId: block.generatedBlockId,
						uploadStatus: "queued",
					}),
				),
				generatedBlocks: (report.report.generatedBlocks ?? []).map((block) =>
					this.normalizeGeneratedBlockState({
						...block,
						stateId: block.generatedBlockId,
						uploadStatus: "queued",
					}),
				),
				changedFiles: (report.report.changedFiles ?? []).map((file) => ({
					relativePath: normalizePath(file.relativePath),
					filePath: normalizePath(file.filePath),
					previousFilePath: file.previousFilePath ? normalizePath(file.previousFilePath) : undefined,
					language: typeof file.language === "string" ? file.language : undefined,
					committedSnapshotContent:
						typeof file.committedSnapshotContent === "string" ? file.committedSnapshotContent : undefined,
					changedBlocks: (file.changedBlocks ?? []).map((block, index) => {
						const startLine =
							typeof block.startLine === "number" && block.startLine > 0 ? block.startLine : 1
						const lineCount =
							typeof block.lineCount === "number" && block.lineCount > 0 ? block.lineCount : 1
						return {
							startLine,
							endLine:
								typeof block.endLine === "number" && block.endLine >= startLine
									? block.endLine
									: startLine + lineCount - 1,
							lineCount,
							codeSnippet: typeof block.codeSnippet === "string" ? block.codeSnippet : "",
							displayOrder:
								typeof block.displayOrder === "number" && block.displayOrder > 0
									? block.displayOrder
									: index + 1,
						}
					}),
					addedLines: (file.addedLines ?? []).map((line, index) => ({
						addedIndex:
							typeof line.addedIndex === "number" && line.addedIndex >= 0 ? line.addedIndex : index,
						lineNumber: typeof line.lineNumber === "number" && line.lineNumber > 0 ? line.lineNumber : 1,
						content: typeof line.content === "string" ? line.content : "",
						lineHash:
							typeof line.lineHash === "string" && line.lineHash.trim()
								? line.lineHash
								: hashLineFingerprint(typeof line.content === "string" ? line.content : ""),
					})),
				})),
				candidateLines: (report.report.candidateLines ?? []).map((line, index) => {
					const sourceTimestamp =
						typeof line.sourceTimestamp === "number" && Number.isFinite(line.sourceTimestamp)
							? line.sourceTimestamp
							: undefined
					if (sourceTimestamp === undefined) {
						throw new Error(
							`Queued commit report ${report.report.reportId} has candidate line ${index} without sourceTimestamp`,
						)
					}

					return {
						clientLineId:
							typeof line.clientLineId === "string" && line.clientLineId.trim()
								? line.clientLineId
								: `${report.report.reportId}:${index}`,
						generatedBlockId: line.generatedBlockId,
						baselineEventId: line.baselineEventId,
						baselineMetricType: line.baselineMetricType === "accepted" ? "accepted" : "generated",
						sourceTimestamp,
						sourceType: "agent_insert",
						ide: line.ide || report.report.client.ide,
						userName: line.userName,
						departmentName: line.departmentName,
						officeName: line.officeName,
						teamName: line.teamName,
						userEmail: line.userEmail,
						organizationId: line.organizationId,
						organizationName: line.organizationName,
						sourceIp: line.sourceIp,
						projectKey: line.projectKey,
						projectName: line.projectName,
						filePath: normalizePath(line.filePath),
						relativePath: normalizePath(line.relativePath),
						repoRoot: normalizePath(line.repoRoot),
						repoRelativePath: normalizePath(line.repoRelativePath),
						language: line.language,
						gitRemoteUrl: line.gitRemoteUrl,
						gitBranch: line.gitBranch,
						taskId: line.taskId,
						lineNumber: typeof line.lineNumber === "number" && line.lineNumber > 0 ? line.lineNumber : 1,
						rawLine: typeof line.rawLine === "string" ? line.rawLine : "",
						blockLineIndex:
							typeof line.blockLineIndex === "number" && line.blockLineIndex > 0
								? line.blockLineIndex
								: 1,
						blockLineCount:
							typeof line.blockLineCount === "number" && line.blockLineCount > 0
								? line.blockLineCount
								: 1,
						lineHash:
							typeof line.lineHash === "string" && line.lineHash.trim()
								? line.lineHash
								: hashLineFingerprint(typeof line.rawLine === "string" ? line.rawLine : ""),
						occurrenceIndex:
							typeof line.occurrenceIndex === "number" && line.occurrenceIndex > 0
								? line.occurrenceIndex
								: 1,
					}
				}),
			},
		}
	}

	private pruneRepoObservedCommits(state: AiCodeStatsPersistedState): boolean {
		const pendingRepoRoots = new Set(this.pendingLines.map((line) => line.repoRoot))
		let changed = false
		for (const repoRoot of Object.keys(state.repoObservedCommits)) {
			if (pendingRepoRoots.has(repoRoot)) {
				continue
			}
			delete state.repoObservedCommits[repoRoot]
			changed = true
		}
		return changed
	}

	private pruneInactiveUploadedBlocks(): void {
		const activeGeneratedIds = new Set(this.pendingLines.map((line) => line.generatedEventId))
		this.generatedBlocks = this.generatedBlocks.filter((block) => {
			if (block.uploadStatus !== "uploaded") {
				return true
			}
			return activeGeneratedIds.has(block.generatedBlockId)
		})
	}

	private normalizePendingLine(line: AiCodePendingLineAttribution): AiCodePendingLineAttribution {
		const rawLine = typeof line.rawLine === "string" ? line.rawLine : ""
		const lineHash =
			typeof line.lineHash === "string" && line.lineHash.trim() ? line.lineHash : hashLineFingerprint(rawLine)
		const blockId = typeof line.blockId === "string" && line.blockId.trim() ? line.blockId : line.generatedEventId
		const blockLineIndex =
			typeof line.blockLineIndex === "number" && line.blockLineIndex > 0
				? line.blockLineIndex
				: typeof line.occurrenceIndex === "number" && line.occurrenceIndex > 0
					? line.occurrenceIndex
					: 1
		const blockLineCount =
			typeof line.blockLineCount === "number" && line.blockLineCount > 0 ? line.blockLineCount : 1

		return {
			...line,
			blockId,
			filePath: normalizePath(line.filePath),
			relativePath: normalizePath(line.relativePath),
			repoRoot: normalizePath(line.repoRoot),
			repoRelativePath: normalizePath(line.repoRelativePath),
			rawLine,
			blockLineIndex,
			blockLineCount,
			lineHash,
		}
	}

	private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
		let resolveNext: (() => void) | undefined
		const next = new Promise<void>((resolve) => {
			resolveNext = resolve
		})

		const previous = this.operationQueue
		this.operationQueue = previous.then(
			() => next,
			() => next,
		)

		await previous
		try {
			return await operation()
		} finally {
			resolveNext?.()
		}
	}

	async clearForTests(): Promise<void> {
		await this.enqueue(async () => {
			this.state = {
				...createEmptyState(),
			}
			this.pendingLines = []
			this.generatedBlocks = []
			this.queuedReports = []
			this.pendingCommitMetricBlocks = []
			await fs.rm(this.baseDir, { recursive: true, force: true })
			await fs.mkdir(this.baseDir, { recursive: true })
			await this.uploadEventQueue.ensureReady()
			await this.persistState()
			await this.persistPendingLines()
			await this.persistGeneratedBlocks()
			await this.persistPendingCommitMetricBlocks()
			await this.persistQueuedReports()
		})
	}

	async getRawStateForTests(): Promise<AiCodeStatsPersistedState> {
		await this.ensureLoaded()
		return (
			this.state ?? {
				version: AI_CODE_STATS_VERSION,
				pendingEventIds: [],
				supersededEventIds: [],
				repoObservedCommits: {},
				lastUpload: { status: "idle" },
			}
		)
	}

	async getRawPendingLineAttributionsForTests(): Promise<AiCodePendingLineAttribution[]> {
		await this.ensureLoaded()
		return this.pendingLines.map((line) => ({ ...line }))
	}

	async getGeneratedBlocksForTests(): Promise<AiCodeGeneratedBlockState[]> {
		await this.ensureLoaded()
		return this.generatedBlocks.map((block) => ({ ...block }))
	}

	async getPendingCommitMetricBlocksForTests(): Promise<AiCodePendingCommitMetricBlock[]> {
		await this.ensureLoaded()
		return this.pendingCommitMetricBlocks.map((block) => ({ ...block }))
	}

	async getQueuedReportsForTests(): Promise<AiCodeQueuedCommitReport[]> {
		await this.ensureLoaded()
		return this.queuedReports.map((report) => this.normalizeQueuedReport(report))
	}
}
