// kilocode_change - new file

import * as fs from "fs/promises"
import * as path from "path"

import { safeWriteJson } from "../../utils/safeWriteJson"
import {
	AI_CODE_STATS_VERSION,
	emptyAggregate,
	emptySummary,
	normalizePath,
	toLocalDateKey,
	type AiCodeStatsEvent,
	type AiCodeStatsLastUpload,
	type AiCodeStatsPersistedState,
	type AiCodeStatsRange,
	type AiCodeStatsSummary,
} from "./types"

const STATE_FILE = "state.json"
const DATE_KEY_REGEX = /^\d{4}-\d{2}-\d{2}$/

export class AiCodeStatsStore {
	private readonly baseDir: string
	private readonly eventsDir: string
	private readonly statePath: string
	private state: AiCodeStatsPersistedState | null = null
	private stateLoadPromise: Promise<void> | null = null
	private operationQueue: Promise<void> = Promise.resolve()

	constructor(globalStoragePath: string) {
		this.baseDir = path.join(globalStoragePath, "ai-code-stats", "v1")
		this.eventsDir = path.join(this.baseDir, "events")
		this.statePath = path.join(this.baseDir, STATE_FILE)
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
				aggregate.agentLines += event.lineCount
				aggregate.totalLines += event.lineCount
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

		let totalAgentLines = 0
		for (const aggregate of Object.values(state.dailyAggregates)) {
			totalAgentLines += aggregate.agentLines
		}

		const pendingEvents = await this.getPendingEventCount()

		return {
			today: {
				agentLines: todayAggregate.agentLines,
				totalLines: todayAggregate.agentLines,
			},
			total: {
				agentLines: totalAgentLines,
				totalLines: totalAgentLines,
			},
			pendingEvents,
			lastUpload: state.lastUpload,
			lastSuccessfulUploadAt: state.lastSuccessfulUploadAt,
		}
	}

	async getGeneratedLinesForRange(range: AiCodeStatsRange, nowTs: number = Date.now()): Promise<number> {
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
				if (!this.isUploadableEvent(event)) {
					continue
				}
				totalLines += event.lineCount
			}
		}

		return totalLines
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
			await this.persistState()
		})
	}

	private async ensureLoaded(): Promise<void> {
		if (this.state) {
			return
		}

		if (!this.stateLoadPromise) {
			this.stateLoadPromise = this.loadState()
		}

		await this.stateLoadPromise
	}

	private async loadState(): Promise<void> {
		await fs.mkdir(this.baseDir, { recursive: true })
		await fs.mkdir(this.eventsDir, { recursive: true })

		try {
			const raw = await fs.readFile(this.statePath, "utf8")
			const parsed = JSON.parse(raw) as Partial<AiCodeStatsPersistedState>
			this.state = {
				version: AI_CODE_STATS_VERSION,
				dailyAggregates: parsed.dailyAggregates ?? {},
				pendingEventIds: parsed.pendingEventIds ?? [],
				lastUpload: parsed.lastUpload ?? { status: "idle" },
				lastSuccessfulUploadAt:
					typeof parsed.lastSuccessfulUploadAt === "number" ? parsed.lastSuccessfulUploadAt : undefined,
			}
		} catch {
			this.state = {
				version: AI_CODE_STATS_VERSION,
				dailyAggregates: {},
				pendingEventIds: [],
				lastUpload: { status: "idle" },
				lastSuccessfulUploadAt: undefined,
			}
			await this.persistState()
		}
	}

	private async persistState(): Promise<void> {
		await safeWriteJson(this.statePath, this.state)
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
					const parsed = JSON.parse(line) as AiCodeStatsEvent
					if (parsed?.eventId && typeof parsed.timestamp === "number") {
						events.push({
							...parsed,
							workspacePath: normalizePath(parsed.workspacePath),
							filePath: normalizePath(parsed.filePath),
							relativePath: normalizePath(parsed.relativePath),
						})
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
			// Use local Monday as week start.
			const dayOfWeek = endDate.getDay()
			const diffToMonday = (dayOfWeek + 6) % 7
			startDate.setDate(startDate.getDate() - diffToMonday)
		} else if (type === "last30days") {
			// Use first day of current month.
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
				lastUpload: { status: "idle" },
				lastSuccessfulUploadAt: undefined,
			}
			await fs.rm(this.baseDir, { recursive: true, force: true })
			await fs.mkdir(this.eventsDir, { recursive: true })
			await this.persistState()
		})
	}

	async getRawStateForTests(): Promise<AiCodeStatsPersistedState> {
		await this.ensureLoaded()
		return (
			this.state ?? {
				version: AI_CODE_STATS_VERSION,
				dailyAggregates: {},
				pendingEventIds: [],
				lastUpload: emptySummary().lastUpload,
				lastSuccessfulUploadAt: undefined,
			}
		)
	}
}
