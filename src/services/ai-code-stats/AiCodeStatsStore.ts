import * as fs from "fs/promises"
import * as path from "path"

import { safeWriteJson } from "../../utils/safeWriteJson"
import { extractLineFeatures, roundToFour } from "./AiCodeLineFeatures"
import { hashLineFingerprint } from "./AiCodeLineFingerprint"
import {
	AI_CODE_STATS_VERSION,
	CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
	emptyAggregate,
	emptySummary,
	normalizePath,
	toLocalDateKey,
	type AiCodeCommittedBlock,
	type AiCodePendingCommitMetricBlock,
	type AiCodeGeneratedBlockState,
	type AiCodeMetricType,
	type AiCodePendingLineAttribution,
	type AiCodeQueuedCommitReport,
	type AiCodeStatsDailyAggregate,
	type AiCodeStatsEvent,
	type AiCodeStatsLastUpload,
	type AiCodeStatsPersistedState,
	type AiCodeStatsRange,
	type AiCodeStatsRangeSummary,
	type AiCodeStatsSummary,
} from "./types"

const STATE_FILE = "state.json"
const PENDING_LINES_FILE = "pending-lines.json"
const GENERATED_BLOCKS_FILE = "generated-blocks.json"
const QUEUED_REPORTS_FILE = "queued-reports.json"
const PENDING_COMMIT_METRIC_BLOCKS_FILE = "pending-commit-metric-blocks.json"
const DATE_KEY_REGEX = /^\d{4}-\d{2}-\d{2}$/

const createEmptyState = (): AiCodeStatsPersistedState => ({
	version: AI_CODE_STATS_VERSION,
	dailyAggregates: {},
	pendingEventIds: [],
	supersededEventIds: [],
	repoObservedCommits: {},
	lastUpload: { status: "idle" },
})

const isCurrentSemanticsVersion = (semanticsVersion?: number): boolean =>
	semanticsVersion === CURRENT_AI_CODE_STATS_SEMANTICS_VERSION

const buildGeneratedMetricEvent = (block: AiCodeGeneratedBlockState): AiCodeStatsEvent => ({
	eventId: block.eventId,
	generatedBlockId: block.generatedBlockId,
	timestamp: block.timestamp,
	semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
	sourceType: block.sourceType,
	ide: block.ide,
	metricType: "generated",
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

const buildAcceptedMetricEvent = (block: AiCodeGeneratedBlockState): AiCodeStatsEvent => ({
	eventId: block.eventId,
	generatedBlockId: block.generatedBlockId,
	timestamp: block.timestamp,
	semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
	sourceType: block.sourceType,
	ide: block.ide,
	metricType: "accepted",
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

const buildCommittedMetricEvent = (block: AiCodeCommittedBlock): AiCodeStatsEvent => ({
	eventId: block.eventId,
	generatedBlockId: block.generatedBlockId,
	timestamp: block.timestamp,
	semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
	sourceType: block.sourceType,
	ide: block.ide,
	metricType: "committed",
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
	commitHash: block.commitHash,
	commitOccurredAt: block.commitOccurredAt,
	matchStrategy: block.matchStrategy,
	matchConfidence: block.matchConfidence,
	equivalentLineCount: block.equivalentLineCount,
})

const buildGeneratedMetricEventForCommitReport = (
	block: AiCodeGeneratedBlockState,
	commitOccurredAt: number,
): AiCodeStatsEvent => ({
	...buildGeneratedMetricEvent({
		...block,
		timestamp: commitOccurredAt,
	}),
	timestamp: commitOccurredAt,
	commitOccurredAt,
})

const buildAcceptedMetricEventForCommitReport = (
	block: AiCodeGeneratedBlockState,
	commitOccurredAt: number,
): AiCodeStatsEvent => ({
	...buildAcceptedMetricEvent({
		...block,
		timestamp: commitOccurredAt,
	}),
	timestamp: commitOccurredAt,
	commitOccurredAt,
})

export class AiCodeStatsStore {
	private readonly baseDir: string
	private readonly eventsDir: string
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
		this.eventsDir = path.join(this.baseDir, "events")
		this.statePath = path.join(this.baseDir, STATE_FILE)
		this.pendingLinesPath = path.join(this.baseDir, PENDING_LINES_FILE)
		this.generatedBlocksPath = path.join(this.baseDir, GENERATED_BLOCKS_FILE)
		this.queuedReportsPath = path.join(this.baseDir, QUEUED_REPORTS_FILE)
		this.pendingCommitMetricBlocksPath = path.join(this.baseDir, PENDING_COMMIT_METRIC_BLOCKS_FILE)
	}

	async appendEvent(event: AiCodeStatsEvent): Promise<void> {
		await this.enqueue(async () => {
			await this.ensureLoaded()
			await this.appendHistoryEventsInternal([event], true)
		})
	}

	async appendHistoryEvents(events: AiCodeStatsEvent[]): Promise<void> {
		if (events.length === 0) {
			return
		}
		await this.enqueue(async () => {
			await this.ensureLoaded()
			await this.appendHistoryEventsInternal(events, false)
		})
	}

	async queueCommitReport(report: AiCodeQueuedCommitReport): Promise<void> {
		await this.enqueue(async () => {
			await this.ensureLoaded()
			const normalizedReport = this.normalizeQueuedReport(report)
			if (this.queuedReports.some((item) => item.report.reportId === normalizedReport.report.reportId)) {
				return
			}

			await this.supersedePendingMetricEvents(normalizedReport.generatedBlockIds)

			await this.appendHistoryEventsInternal(
				[
					...normalizedReport.report.generatedBlocks.map((block) =>
						buildGeneratedMetricEventForCommitReport(block, normalizedReport.report.commitOccurredAt),
					),
					...normalizedReport.report.acceptedBlocks.map((block) =>
						buildAcceptedMetricEventForCommitReport(block, normalizedReport.report.commitOccurredAt),
					),
					...normalizedReport.report.committedBlocks.map((block) => buildCommittedMetricEvent(block)),
				],
				false,
			)

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
			if (target.matchedPendingLineIds.length > 0) {
				const matchedPendingLineIds = new Set(target.matchedPendingLineIds)
				this.pendingLines = this.pendingLines.filter((line) => !matchedPendingLineIds.has(line.id))
			}
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

	async getSummary(nowTs: number = Date.now()): Promise<AiCodeStatsSummary> {
		await this.ensureLoaded()
		const state = this.state!
		const todayKey = toLocalDateKey(nowTs)
		const todayAggregate = state.dailyAggregates[todayKey] ?? emptyAggregate()

		let totalSuggestedLines = 0
		let totalGeneratedLines = 0
		let totalAcceptedLines = 0
		let totalStrictCommittedLines = 0
		let totalEquivalentCommittedLines = 0
		for (const aggregate of Object.values(state.dailyAggregates)) {
			totalSuggestedLines += aggregate.suggestedLines
			totalGeneratedLines += aggregate.generatedLines
			totalAcceptedLines += aggregate.acceptedLines
			totalStrictCommittedLines += aggregate.committedLines
			totalEquivalentCommittedLines += aggregate.equivalentCommittedLines
		}

		const pendingEvents = await this.getPendingEventCount()
		const todayStrictAdoptionRate =
			todayAggregate.generatedLines > 0 ? todayAggregate.acceptedLines / todayAggregate.generatedLines : 0
		const todayEquivalentAdoptionRate =
			todayAggregate.generatedLines > 0
				? todayAggregate.equivalentCommittedLines / todayAggregate.generatedLines
				: 0
		const totalStrictAdoptionRate = totalGeneratedLines > 0 ? totalAcceptedLines / totalGeneratedLines : 0
		const totalEquivalentAdoptionRate =
			totalGeneratedLines > 0 ? totalEquivalentCommittedLines / totalGeneratedLines : 0

		return {
			today: {
				suggestedLines: todayAggregate.suggestedLines,
				generatedLines: todayAggregate.generatedLines,
				acceptedLines: todayAggregate.acceptedLines,
				committedLines: todayAggregate.committedLines,
				adoptionRate: todayStrictAdoptionRate,
				retentionRate:
					todayAggregate.acceptedLines > 0 ? todayAggregate.committedLines / todayAggregate.acceptedLines : 0,
				strictCommittedLines: todayAggregate.committedLines,
				equivalentCommittedLines: roundToFour(todayAggregate.equivalentCommittedLines),
				strictAdoptionRate: todayStrictAdoptionRate,
				equivalentAdoptionRate: todayEquivalentAdoptionRate,
			},
			total: {
				suggestedLines: totalSuggestedLines,
				generatedLines: totalGeneratedLines,
				acceptedLines: totalAcceptedLines,
				committedLines: totalStrictCommittedLines,
				adoptionRate: totalStrictAdoptionRate,
				retentionRate: totalAcceptedLines > 0 ? totalStrictCommittedLines / totalAcceptedLines : 0,
				strictCommittedLines: totalStrictCommittedLines,
				equivalentCommittedLines: roundToFour(totalEquivalentCommittedLines),
				strictAdoptionRate: totalStrictAdoptionRate,
				equivalentAdoptionRate: totalEquivalentAdoptionRate,
			},
			pendingEvents,
			lastUpload: state.lastUpload,
		}
	}

	async getGeneratedLinesForRange(range: AiCodeStatsRange, nowTs: number = Date.now()): Promise<number> {
		return this.getMetricLinesForRange(range, "generated", nowTs)
	}

	async getSuggestedLinesForRange(range: AiCodeStatsRange, nowTs: number = Date.now()): Promise<number> {
		return this.getAggregateLinesForRange(range, (aggregate) => aggregate.suggestedLines, nowTs)
	}

	async getCommittedLinesForRange(range: AiCodeStatsRange, nowTs: number = Date.now()): Promise<number> {
		return this.getMetricLinesForRange(range, "committed", nowTs)
	}

	async getAcceptedLinesForRange(range: AiCodeStatsRange, nowTs: number = Date.now()): Promise<number> {
		return this.getMetricLinesForRange(range, "accepted", nowTs)
	}

	async getRangeSummary(range: AiCodeStatsRange, nowTs: number = Date.now()): Promise<AiCodeStatsRangeSummary> {
		const generatedLines = await this.getGeneratedLinesForRange(range, nowTs)
		const acceptedLines = await this.getAcceptedLinesForRange(range, nowTs)
		const committedLines = await this.getCommittedLinesForRange(range, nowTs)

		return {
			generatedLines,
			acceptedLines,
			committedLines,
			adoptionRate: generatedLines > 0 ? acceptedLines / generatedLines : 0,
			retentionRate: acceptedLines > 0 ? committedLines / acceptedLines : 0,
		}
	}

	async getPendingEventCount(): Promise<number> {
		await this.ensureLoaded()
		const pendingStandaloneEvents = (await this.getPendingEvents()).length
		const pendingCommitMetricEvents = this.pendingCommitMetricBlocks.length * 2
		const pendingGeneratedBlocks = this.generatedBlocks.filter(
			(block) => block.uploadStatus === "pending" || block.uploadStatus === "queued",
		).length
		const queuedCommittedBlocks = this.queuedReports.reduce(
			(total, report) => total + report.report.committedBlocks.length,
			0,
		)
		return pendingStandaloneEvents + pendingCommitMetricEvents + pendingGeneratedBlocks + queuedCommittedBlocks
	}

	async getPendingEvents(maxEvents?: number): Promise<AiCodeStatsEvent[]> {
		await this.ensureLoaded()
		const pendingIds = new Set(this.state!.pendingEventIds)
		if (pendingIds.size === 0) {
			return []
		}

		const eventFiles = await this.getEventFilesSorted()
		const events: AiCodeStatsEvent[] = []
		for (const filePath of eventFiles) {
			const fileEvents = await this.readEventFile(filePath)
			for (const event of fileEvents) {
				if (!pendingIds.has(event.eventId)) {
					continue
				}
				if (!this.isUploadableEvent(event)) {
					continue
				}
				events.push(event)
				if (maxEvents && events.length >= maxEvents) {
					return events
				}
			}
		}

		return events
	}

	async getRecentEvents(days: number, maxEvents?: number, nowTs: number = Date.now()): Promise<AiCodeStatsEvent[]> {
		await this.ensureLoaded()
		if (days <= 0) {
			return []
		}

		const now = new Date(nowTs)
		const cutoff = new Date(now)
		cutoff.setHours(0, 0, 0, 0)
		cutoff.setDate(cutoff.getDate() - (days - 1))
		const cutoffKey = toLocalDateKey(cutoff.getTime())

		const eventFiles = await this.getEventFilesSorted()
		const events: AiCodeStatsEvent[] = []

		for (const filePath of eventFiles) {
			const base = path.basename(filePath)
			const dateKey = base.replace(/\.ndjson$/, "")
			if (dateKey < cutoffKey) {
				continue
			}

			const fileEvents = await this.readEventFile(filePath)
			events.push(...fileEvents)
			if (maxEvents && events.length >= maxEvents) {
				return events.slice(0, maxEvents)
			}
		}

		return events
	}

	async getEventsForRange(
		range: AiCodeStatsRange,
		maxEvents?: number,
		nowTs: number = Date.now(),
	): Promise<AiCodeStatsEvent[]> {
		await this.ensureLoaded()
		const bounds = this.resolveRangeBounds(range, nowTs)
		if (bounds === null) {
			return []
		}

		const eventFiles = await this.getEventFilesSorted()
		const events: AiCodeStatsEvent[] = []
		for (const filePath of eventFiles) {
			const dateKey = path.basename(filePath).replace(/\.ndjson$/, "")
			if (!this.isDateInBounds(dateKey, bounds.fromKey, bounds.toKey)) {
				continue
			}

			const fileEvents = await this.readEventFile(filePath)
			for (const event of fileEvents) {
				if (!this.isUploadableEvent(event)) {
					continue
				}
				events.push(event)
				if (maxEvents && events.length >= maxEvents) {
					return events.slice(0, maxEvents)
				}
			}
		}

		return events
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

	async addSuggestedLines(lineCount: number, timestamp: number = Date.now()): Promise<void> {
		if (!Number.isFinite(lineCount) || lineCount <= 0) {
			return
		}

		await this.enqueue(async () => {
			await this.ensureLoaded()
			const state = this.state!
			const dateKey = toLocalDateKey(timestamp)
			const aggregate = state.dailyAggregates[dateKey] ?? emptyAggregate()
			aggregate.suggestedLines += lineCount
			state.dailyAggregates[dateKey] = aggregate
			await this.persistState()
		})
	}

	async getPendingLineAttributions(repoRoot?: string): Promise<AiCodePendingLineAttribution[]> {
		await this.ensureLoaded()
		const normalizedRepoRoot = repoRoot ? normalizePath(path.resolve(repoRoot)) : undefined
		const queuedMatchedLineIds = new Set(this.queuedReports.flatMap((report) => report.matchedPendingLineIds ?? []))
		return this.pendingLines
			.filter((line) => !queuedMatchedLineIds.has(line.id))
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

	async markEventsUploaded(eventIds: string[]): Promise<void> {
		if (eventIds.length === 0) {
			return
		}

		await this.enqueue(async () => {
			await this.ensureLoaded()
			const state = this.state!
			const uploadedSet = new Set(eventIds)
			state.pendingEventIds = state.pendingEventIds.filter((id) => !uploadedSet.has(id))
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
			const eventFiles = await this.getEventFilesSorted()
			for (const filePath of eventFiles) {
				const dateKey = path.basename(filePath).replace(/\.ndjson$/, "")
				if (dateKey >= cutoffKey) {
					continue
				}
				const events = await this.readEventFile(filePath)
				for (const event of events) {
					pendingIds.delete(event.eventId)
					supersededIds.delete(event.eventId)
				}
				await fs.unlink(filePath).catch(() => undefined)
				delete state.dailyAggregates[dateKey]
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
		await fs.mkdir(this.eventsDir, { recursive: true })

		let shouldResetStorage = false
		try {
			const raw = await fs.readFile(this.statePath, "utf8")
			const parsed = JSON.parse(raw) as Partial<AiCodeStatsPersistedState>
			if (parsed.version !== AI_CODE_STATS_VERSION) {
				shouldResetStorage = true
			} else {
				this.state = {
					version: AI_CODE_STATS_VERSION,
					dailyAggregates: this.normalizeDailyAggregates(parsed.dailyAggregates),
					pendingEventIds: Array.isArray(parsed.pendingEventIds) ? parsed.pendingEventIds : [],
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
			await fs.mkdir(this.eventsDir, { recursive: true })
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

	private async appendHistoryEventsInternal(events: AiCodeStatsEvent[], markLegacyPending: boolean): Promise<void> {
		const state = this.state!
		const dateBuckets = new Map<string, AiCodeStatsEvent[]>()
		for (const event of events) {
			const normalizedEvent = this.normalizeHistoryEvent(event)
			const dateKey = toLocalDateKey(normalizedEvent.timestamp)
			const bucket = dateBuckets.get(dateKey) ?? []
			bucket.push(normalizedEvent)
			dateBuckets.set(dateKey, bucket)

			const aggregate = state.dailyAggregates[dateKey] ?? emptyAggregate()
			aggregate.eventCount += 1
			if (normalizedEvent.metricType === "committed") {
				aggregate.committedLines += normalizedEvent.lineCount
				aggregate.equivalentCommittedLines += normalizedEvent.equivalentLineCount ?? normalizedEvent.lineCount
			} else if (normalizedEvent.metricType === "accepted") {
				aggregate.acceptedLines += normalizedEvent.lineCount
			} else {
				aggregate.generatedLines += normalizedEvent.lineCount
			}
			state.dailyAggregates[dateKey] = aggregate

			if (markLegacyPending && !state.pendingEventIds.includes(normalizedEvent.eventId)) {
				state.pendingEventIds.push(normalizedEvent.eventId)
			}
		}

		for (const [dateKey, bucket] of dateBuckets.entries()) {
			const filePath = path.join(this.eventsDir, `${dateKey}.ndjson`)
			const content = bucket.map((event) => JSON.stringify(event)).join("\n")
			await fs.appendFile(filePath, `${content}\n`, "utf8")
		}
		await this.persistState()
	}

	private async supersedePendingMetricEvents(generatedBlockIds: string[]): Promise<void> {
		if (generatedBlockIds.length === 0) {
			return
		}

		const state = this.state!
		const pendingIds = new Set(state.pendingEventIds)
		const supersededIds = new Set(state.supersededEventIds)
		const targetGeneratedBlockIds = new Set(generatedBlockIds)
		let changed = false

		const eventFiles = await this.getEventFilesSorted()
		for (const filePath of eventFiles) {
			const events = await this.readEventFile(filePath)
			for (const event of events) {
				if (!pendingIds.has(event.eventId)) {
					continue
				}
				if (event.metricType !== "generated" && event.metricType !== "accepted") {
					continue
				}
				if (!event.generatedBlockId || !targetGeneratedBlockIds.has(event.generatedBlockId)) {
					continue
				}
				pendingIds.delete(event.eventId)
				supersededIds.add(event.eventId)
				this.applyAggregateDelta(state, event, -1)
				changed = true
			}
		}

		if (!changed) {
			return
		}

		state.pendingEventIds = [...pendingIds]
		state.supersededEventIds = [...supersededIds]
		await this.persistState()
	}

	private applyAggregateDelta(state: AiCodeStatsPersistedState, event: AiCodeStatsEvent, direction: 1 | -1): void {
		const dateKey = toLocalDateKey(event.timestamp)
		const aggregate = state.dailyAggregates[dateKey] ?? emptyAggregate()
		aggregate.eventCount = Math.max(0, aggregate.eventCount + direction)
		if (event.metricType === "committed") {
			aggregate.committedLines = Math.max(0, aggregate.committedLines + event.lineCount * direction)
			aggregate.equivalentCommittedLines = Math.max(
				0,
				roundToFour(
					aggregate.equivalentCommittedLines + (event.equivalentLineCount ?? event.lineCount) * direction,
				),
			)
		} else if (event.metricType === "accepted") {
			aggregate.acceptedLines = Math.max(0, aggregate.acceptedLines + event.lineCount * direction)
		} else {
			aggregate.generatedLines = Math.max(0, aggregate.generatedLines + event.lineCount * direction)
		}

		if (
			aggregate.suggestedLines === 0 &&
			aggregate.generatedLines === 0 &&
			aggregate.acceptedLines === 0 &&
			aggregate.committedLines === 0 &&
			aggregate.equivalentCommittedLines === 0 &&
			aggregate.eventCount === 0
		) {
			delete state.dailyAggregates[dateKey]
			return
		}

		state.dailyAggregates[dateKey] = aggregate
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

	private async getEventFilesSorted(): Promise<string[]> {
		try {
			const names = await fs.readdir(this.eventsDir)
			return names
				.filter((name) => name.endsWith(".ndjson"))
				.sort((a, b) => a.localeCompare(b))
				.map((name) => path.join(this.eventsDir, name))
		} catch {
			return []
		}
	}

	private async readEventFile(filePath: string): Promise<AiCodeStatsEvent[]> {
		try {
			const raw = await fs.readFile(filePath, "utf8")
			const lines = raw.split("\n")
			const events: AiCodeStatsEvent[] = []
			for (const line of lines) {
				if (!line.trim()) {
					continue
				}
				try {
					const parsed = JSON.parse(line) as Partial<AiCodeStatsEvent>
					if (
						parsed?.eventId &&
						typeof parsed.timestamp === "number" &&
						isCurrentSemanticsVersion(parsed.semanticsVersion)
					) {
						events.push(this.normalizeHistoryEvent(parsed as AiCodeStatsEvent))
					}
				} catch {
					// Skip malformed lines to preserve remaining records.
				}
			}
			return events
		} catch {
			return []
		}
	}

	private normalizeHistoryEvent(event: AiCodeStatsEvent): AiCodeStatsEvent {
		return {
			...event,
			semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
			metricType:
				event.metricType === "committed"
					? "committed"
					: event.metricType === "accepted"
						? "accepted"
						: "generated",
			workspacePath: normalizePath(event.workspacePath ?? ""),
			filePath: normalizePath(event.filePath ?? ""),
			relativePath: normalizePath(event.relativePath ?? ""),
			matchStrategy:
				event.matchStrategy === "exact" || event.matchStrategy === "partial" ? event.matchStrategy : undefined,
			matchConfidence: typeof event.matchConfidence === "number" ? event.matchConfidence : undefined,
			equivalentLineCount:
				typeof event.equivalentLineCount === "number"
					? event.equivalentLineCount
					: typeof event.lineCount === "number"
						? event.lineCount
						: 0,
			fileSnapshotContent: typeof event.fileSnapshotContent === "string" ? event.fileSnapshotContent : undefined,
			generatedBlockId:
				typeof event.generatedBlockId === "string" && event.generatedBlockId.trim()
					? event.generatedBlockId
					: undefined,
		}
	}

	private isUploadableEvent(event: AiCodeStatsEvent): boolean {
		return (
			event.semanticsVersion === CURRENT_AI_CODE_STATS_SEMANTICS_VERSION &&
			(event.sourceType === "agent_insert" || event.sourceType === "autocomplete") &&
			!this.state?.supersededEventIds.includes(event.eventId)
		)
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
			workspacePath: normalizePath(block.workspacePath),
			filePath: normalizePath(block.filePath),
			relativePath: normalizePath(block.relativePath),
			lineStart,
			lineEnd,
			lineCount,
			codeSnippet: typeof block.codeSnippet === "string" ? block.codeSnippet : "",
			fileSnapshotContent: typeof block.fileSnapshotContent === "string" ? block.fileSnapshotContent : undefined,
		}
	}

	private async getMetricLinesForRange(
		range: AiCodeStatsRange,
		metricType: AiCodeMetricType,
		nowTs: number,
	): Promise<number> {
		await this.ensureLoaded()
		const bounds = this.resolveRangeBounds(range, nowTs)
		if (bounds === null) {
			return 0
		}

		let totalLines = 0
		const eventFiles = await this.getEventFilesSorted()
		for (const filePath of eventFiles) {
			const dateKey = path.basename(filePath).replace(/\.ndjson$/, "")
			if (!this.isDateInBounds(dateKey, bounds.fromKey, bounds.toKey)) {
				continue
			}

			const events = await this.readEventFile(filePath)
			for (const event of events) {
				if (!this.isUploadableEvent(event) || event.metricType !== metricType) {
					continue
				}
				totalLines += event.lineCount
			}
		}

		return totalLines
	}

	private async getAggregateLinesForRange(
		range: AiCodeStatsRange,
		selectLines: (aggregate: AiCodeStatsDailyAggregate) => number,
		nowTs: number,
	): Promise<number> {
		await this.ensureLoaded()
		const bounds = this.resolveRangeBounds(range, nowTs)
		if (bounds === null) {
			return 0
		}

		let totalLines = 0
		for (const [dateKey, aggregate] of Object.entries(this.state!.dailyAggregates)) {
			if (!this.isDateInBounds(dateKey, bounds.fromKey, bounds.toKey)) {
				continue
			}
			totalLines += selectLines(aggregate)
		}

		return totalLines
	}

	private resolveRangeBounds(range: AiCodeStatsRange, nowTs: number): { fromKey?: string; toKey?: string } | null {
		const type = range.type
		if (type === "all") {
			return {}
		}

		if (type === "custom") {
			const startKey = this.normalizeDateKey(range.startDate)
			const endKey = this.normalizeDateKey(range.endDate)
			if (!startKey || !endKey) {
				return null
			}
			return startKey <= endKey ? { fromKey: startKey, toKey: endKey } : { fromKey: endKey, toKey: startKey }
		}

		const endDate = new Date(nowTs)
		endDate.setHours(0, 0, 0, 0)
		const startDate = new Date(endDate)
		if (type === "last7days") {
			const dayOfWeek = endDate.getDay()
			const diffToMonday = (dayOfWeek + 6) % 7
			startDate.setDate(startDate.getDate() - diffToMonday)
		} else if (type === "last30days") {
			startDate.setDate(1)
		}

		return {
			fromKey: toLocalDateKey(startDate.getTime()),
			toKey: toLocalDateKey(endDate.getTime()),
		}
	}

	private normalizeDateKey(value?: string): string | undefined {
		if (!value || !DATE_KEY_REGEX.test(value)) {
			return undefined
		}
		const parsed = new Date(`${value}T00:00:00`)
		if (Number.isNaN(parsed.getTime())) {
			return undefined
		}
		return value
	}

	private isDateInBounds(dateKey: string, fromKey?: string, toKey?: string): boolean {
		if (!DATE_KEY_REGEX.test(dateKey)) {
			return false
		}
		if (fromKey && dateKey < fromKey) {
			return false
		}
		if (toKey && dateKey > toKey) {
			return false
		}
		return true
	}

	private normalizeDailyAggregates(
		dailyAggregates: Partial<Record<string, AiCodeStatsDailyAggregate | Record<string, unknown>>> | undefined,
	): Record<string, AiCodeStatsDailyAggregate> {
		const normalized: Record<string, AiCodeStatsDailyAggregate> = {}
		for (const [dateKey, aggregate] of Object.entries(dailyAggregates ?? {})) {
			if (!DATE_KEY_REGEX.test(dateKey) || !aggregate) {
				continue
			}
			const aggregateRecord = aggregate as Record<string, unknown>

			normalized[dateKey] = {
				suggestedLines: typeof aggregateRecord.suggestedLines === "number" ? aggregateRecord.suggestedLines : 0,
				generatedLines: typeof aggregateRecord.generatedLines === "number" ? aggregateRecord.generatedLines : 0,
				acceptedLines: typeof aggregateRecord.acceptedLines === "number" ? aggregateRecord.acceptedLines : 0,
				committedLines: typeof aggregateRecord.committedLines === "number" ? aggregateRecord.committedLines : 0,
				equivalentCommittedLines:
					typeof aggregateRecord.equivalentCommittedLines === "number"
						? aggregateRecord.equivalentCommittedLines
						: typeof aggregateRecord.committedLines === "number"
							? aggregateRecord.committedLines
							: 0,
				eventCount: typeof aggregateRecord.eventCount === "number" ? aggregateRecord.eventCount : 0,
			}
		}

		return normalized
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
			workspacePath: normalizePath(block.workspacePath),
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
			matchedPendingLineIds: Array.isArray(report.matchedPendingLineIds)
				? [...new Set(report.matchedPendingLineIds)]
				: [],
			report: {
				...report.report,
				version: "v2",
				source: "kilocode-ai-code-stats",
				mode: "commit_report",
				semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
				repoRoot: normalizePath(report.report.repoRoot),
				workspacePath: normalizePath(report.report.workspacePath),
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
				committedBlocks: (report.report.committedBlocks ?? []).map((block) => ({
					...block,
					semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
					workspacePath: normalizePath(block.workspacePath),
					filePath: normalizePath(block.filePath),
					relativePath: normalizePath(block.relativePath),
					generatedBlockId: block.generatedBlockId,
					fileSnapshotContent:
						typeof block.fileSnapshotContent === "string" ? block.fileSnapshotContent : undefined,
					matchStrategy:
						block.matchStrategy === "exact" || block.matchStrategy === "partial"
							? block.matchStrategy
							: undefined,
					matchConfidence: typeof block.matchConfidence === "number" ? block.matchConfidence : undefined,
					equivalentLineCount:
						typeof block.equivalentLineCount === "number" ? block.equivalentLineCount : block.lineCount,
				})),
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
				})),
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
		const lineFeatures = extractLineFeatures(rawLine)
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
			workspacePath: normalizePath(line.workspacePath),
			filePath: normalizePath(line.filePath),
			relativePath: normalizePath(line.relativePath),
			repoRoot: normalizePath(line.repoRoot),
			repoRelativePath: normalizePath(line.repoRelativePath),
			rawLine,
			blockLineIndex,
			blockLineCount,
			lineHash,
			normalizedLine: line.normalizedLine || lineFeatures.normalizedLine,
			normalizedTokenLine: line.normalizedTokenLine || lineFeatures.normalizedTokenLine,
			rareIdentifiers:
				Array.isArray(line.rareIdentifiers) && line.rareIdentifiers.length > 0
					? [...new Set(line.rareIdentifiers.map((value) => String(value).toLowerCase()))].sort(
							(left, right) => left.localeCompare(right),
						)
					: lineFeatures.rareIdentifiers,
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
			await fs.mkdir(this.eventsDir, { recursive: true })
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
				dailyAggregates: {},
				pendingEventIds: [],
				supersededEventIds: [],
				repoObservedCommits: {},
				lastUpload: emptySummary().lastUpload,
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
