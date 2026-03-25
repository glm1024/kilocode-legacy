// kilocode_change - new file

import * as fs from "fs/promises"
import * as path from "path"

import { safeWriteJson } from "../../utils/safeWriteJson"
import { extractLineFeatures, roundToFour } from "./AiCodeLineFeatures"
import { hashLineFingerprint } from "./AiCodeLineFingerprint"
import {
	AI_CODE_STATS_VERSION,
	emptyAggregate,
	emptySummary,
	normalizePath,
	toLocalDateKey,
	type AiCodeMetricType,
	type AiCodePendingLineAttribution,
	type AiCodeStatsDailyAggregate,
	type AiCodeStatsEvent,
	type AiCodeStatsLastUpload,
	type AiCodeStatsPersistedState,
	type AiCodeStatsRange,
	type AiCodeStatsSummary,
} from "./types"

const STATE_FILE = "state.json"
const PENDING_LINES_FILE = "pending-lines.json"
const DATE_KEY_REGEX = /^\d{4}-\d{2}-\d{2}$/

export class AiCodeStatsStore {
	private readonly baseDir: string
	private readonly eventsDir: string
	private readonly statePath: string
	private readonly pendingLinesPath: string
	private state: AiCodeStatsPersistedState | null = null
	private pendingLines: AiCodePendingLineAttribution[] = []
	private loadPromise: Promise<void> | null = null
	private operationQueue: Promise<void> = Promise.resolve()

	constructor(globalStoragePath: string) {
		this.baseDir = path.join(globalStoragePath, "ai-code-stats", "v1")
		this.eventsDir = path.join(this.baseDir, "events")
		this.statePath = path.join(this.baseDir, STATE_FILE)
		this.pendingLinesPath = path.join(this.baseDir, PENDING_LINES_FILE)
	}

	async appendEvent(event: AiCodeStatsEvent): Promise<void> {
		await this.enqueue(async () => {
			await this.ensureLoaded()
			const state = this.state!

			await fs.mkdir(this.eventsDir, { recursive: true })
			const dateKey = toLocalDateKey(event.timestamp)
			const filePath = path.join(this.eventsDir, `${dateKey}.ndjson`)
			await fs.appendFile(filePath, `${JSON.stringify(event)}\n`, "utf8")

			const aggregate = state.dailyAggregates[dateKey] ?? emptyAggregate()
			aggregate.eventCount += 1
			if (event.sourceType === "agent_insert") {
				if (event.metricType === "committed") {
					aggregate.committedLines += event.lineCount
					aggregate.equivalentCommittedLines += event.equivalentLineCount ?? event.lineCount
				} else {
					aggregate.generatedLines += event.lineCount
				}
			}
			state.dailyAggregates[dateKey] = aggregate

			if (!state.pendingEventIds.includes(event.eventId)) {
				state.pendingEventIds.push(event.eventId)
			}

			await this.persistState()
		})
	}

	async getSummary(nowTs: number = Date.now()): Promise<AiCodeStatsSummary> {
		await this.ensureLoaded()
		const state = this.state!
		const todayKey = toLocalDateKey(nowTs)
		const todayAggregate = state.dailyAggregates[todayKey] ?? emptyAggregate()

		let totalSuggestedLines = 0
		let totalGeneratedLines = 0
		let totalStrictCommittedLines = 0
		let totalEquivalentCommittedLines = 0
		for (const aggregate of Object.values(state.dailyAggregates)) {
			totalSuggestedLines += aggregate.suggestedLines
			totalGeneratedLines += aggregate.generatedLines
			totalStrictCommittedLines += aggregate.committedLines
			totalEquivalentCommittedLines += aggregate.equivalentCommittedLines
		}

		const pendingEvents = await this.getPendingEventCount()
		const todayStrictAdoptionRate =
			todayAggregate.generatedLines > 0 ? todayAggregate.committedLines / todayAggregate.generatedLines : 0
		const todayEquivalentAdoptionRate =
			todayAggregate.generatedLines > 0
				? todayAggregate.equivalentCommittedLines / todayAggregate.generatedLines
				: 0
		const totalStrictAdoptionRate = totalGeneratedLines > 0 ? totalStrictCommittedLines / totalGeneratedLines : 0
		const totalEquivalentAdoptionRate =
			totalGeneratedLines > 0 ? totalEquivalentCommittedLines / totalGeneratedLines : 0

		return {
			today: {
				suggestedLines: todayAggregate.suggestedLines,
				generatedLines: todayAggregate.generatedLines,
				committedLines: todayAggregate.committedLines,
				adoptionRate: todayStrictAdoptionRate,
				strictCommittedLines: todayAggregate.committedLines,
				equivalentCommittedLines: roundToFour(todayAggregate.equivalentCommittedLines),
				strictAdoptionRate: todayStrictAdoptionRate,
				equivalentAdoptionRate: todayEquivalentAdoptionRate,
			},
			total: {
				suggestedLines: totalSuggestedLines,
				generatedLines: totalGeneratedLines,
				committedLines: totalStrictCommittedLines,
				adoptionRate: totalStrictAdoptionRate,
				strictCommittedLines: totalStrictCommittedLines,
				equivalentCommittedLines: roundToFour(totalEquivalentCommittedLines),
				strictAdoptionRate: totalStrictAdoptionRate,
				equivalentAdoptionRate: totalEquivalentAdoptionRate,
			},
			pendingEvents,
			lastUpload: state.lastUpload,
			lastSuccessfulUploadAt: state.lastSuccessfulUploadAt,
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

	async getPendingEventCount(): Promise<number> {
		const pendingEvents = await this.getPendingEvents()
		return pendingEvents.length
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
			if (lastUpload.status === "success" && typeof lastUpload.timestamp === "number") {
				state.lastSuccessfulUploadAt = lastUpload.timestamp
			}
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
			const eventFiles = await this.getEventFilesSorted()

			for (const filePath of eventFiles) {
				const dateKey = path.basename(filePath).replace(/\.ndjson$/, "")
				if (dateKey >= cutoffKey) {
					continue
				}

				const events = await this.readEventFile(filePath)
				for (const event of events) {
					pendingIds.delete(event.eventId)
				}

				await fs.unlink(filePath).catch(() => undefined)
				delete state.dailyAggregates[dateKey]
			}

			state.pendingEventIds = [...pendingIds]
			this.pendingLines = this.pendingLines.filter((line) => line.timestamp >= cutoffTimestamp)
			await this.persistState()
			await this.persistPendingLines()
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

		try {
			const raw = await fs.readFile(this.statePath, "utf8")
			const parsed = JSON.parse(raw) as Partial<AiCodeStatsPersistedState>
			this.state = {
				version: AI_CODE_STATS_VERSION,
				dailyAggregates: this.normalizeDailyAggregates(parsed.dailyAggregates),
				pendingEventIds: parsed.pendingEventIds ?? [],
				repoObservedCommits: this.normalizeRepoObservedCommits(parsed.repoObservedCommits),
				lastUpload: parsed.lastUpload ?? { status: "idle" },
				lastSuccessfulUploadAt:
					typeof parsed.lastSuccessfulUploadAt === "number" ? parsed.lastSuccessfulUploadAt : undefined,
			}
		} catch {
			this.state = {
				version: AI_CODE_STATS_VERSION,
				dailyAggregates: {},
				pendingEventIds: [],
				repoObservedCommits: {},
				lastUpload: { status: "idle" },
				lastSuccessfulUploadAt: undefined,
			}
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

		if (this.pruneRepoObservedCommits(this.state!)) {
			await this.persistState()
		}
	}

	private async persistState(): Promise<void> {
		await safeWriteJson(this.statePath, this.state)
	}

	private async persistPendingLines(): Promise<void> {
		await safeWriteJson(this.pendingLinesPath, this.pendingLines)
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
					if (parsed?.eventId && typeof parsed.timestamp === "number") {
						events.push({
							...parsed,
							metricType: parsed.metricType === "committed" ? "committed" : "generated",
							workspacePath: normalizePath(parsed.workspacePath ?? ""),
							filePath: normalizePath(parsed.filePath ?? ""),
							relativePath: normalizePath(parsed.relativePath ?? ""),
							matchStrategy:
								parsed.matchStrategy === "exact" || parsed.matchStrategy === "partial_block"
									? parsed.matchStrategy
									: undefined,
							matchConfidence:
								typeof parsed.matchConfidence === "number" ? parsed.matchConfidence : undefined,
							equivalentLineCount:
								typeof parsed.equivalentLineCount === "number"
									? parsed.equivalentLineCount
									: typeof parsed.lineCount === "number"
										? parsed.lineCount
										: 0,
						} as AiCodeStatsEvent)
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

	private isUploadableEvent(event: AiCodeStatsEvent): boolean {
		return event.sourceType === "agent_insert"
	}

	private async getMetricLinesForRange(
		range: AiCodeStatsRange,
		metricType: AiCodeMetricType,
		nowTs: number,
	): Promise<number> {
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
		if (type === "current") {
			// Keep current day only.
		} else if (type === "last3days") {
			startDate.setDate(startDate.getDate() - 2)
		} else if (type === "last7days") {
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
			const legacyGeneratedLines =
				typeof aggregateRecord.agentLines === "number"
					? aggregateRecord.agentLines
					: typeof aggregateRecord.totalLines === "number"
						? aggregateRecord.totalLines
						: 0

			normalized[dateKey] = {
				suggestedLines: typeof aggregateRecord.suggestedLines === "number" ? aggregateRecord.suggestedLines : 0,
				generatedLines:
					typeof aggregateRecord.generatedLines === "number"
						? aggregateRecord.generatedLines
						: legacyGeneratedLines,
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
				version: AI_CODE_STATS_VERSION,
				dailyAggregates: {},
				pendingEventIds: [],
				repoObservedCommits: {},
				lastUpload: { status: "idle" },
				lastSuccessfulUploadAt: undefined,
			}
			this.pendingLines = []
			await fs.rm(this.baseDir, { recursive: true, force: true })
			await fs.mkdir(this.eventsDir, { recursive: true })
			await this.persistState()
			await this.persistPendingLines()
		})
	}

	async getRawStateForTests(): Promise<AiCodeStatsPersistedState> {
		await this.ensureLoaded()
		return (
			this.state ?? {
				version: AI_CODE_STATS_VERSION,
				dailyAggregates: {},
				pendingEventIds: [],
				repoObservedCommits: {},
				lastUpload: emptySummary().lastUpload,
				lastSuccessfulUploadAt: undefined,
			}
		)
	}

	async getRawPendingLineAttributionsForTests(): Promise<AiCodePendingLineAttribution[]> {
		await this.ensureLoaded()
		return this.pendingLines.map((line) => ({ ...line }))
	}
}
