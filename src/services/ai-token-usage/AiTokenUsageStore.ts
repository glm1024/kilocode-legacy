import * as fs from "fs/promises"
import * as path from "path"

import { safeWriteJson } from "../../utils/safeWriteJson"
import {
	AI_TOKEN_USAGE_RETENTION_DAYS,
	AI_TOKEN_USAGE_VERSION,
	buildAggregateKey,
	toLocalDateKey,
	type AiTokenUsageAggregateRow,
	type AiTokenUsagePersistedState,
	type AiTokenUsageRecordInput,
	type AiTokenUsageRange,
	type AiTokenUsageSummary,
} from "./types"

const STATE_FILE = "state.json"
const DATE_KEY_REGEX = /^\d{4}-\d{2}-\d{2}$/

const emptyState = (): AiTokenUsagePersistedState => ({
	version: AI_TOKEN_USAGE_VERSION,
	rows: {},
})

export class AiTokenUsageStore {
	private readonly baseDir: string
	private readonly statePath: string
	private state: AiTokenUsagePersistedState | null = null
	private loadPromise: Promise<void> | null = null
	private operationQueue: Promise<void> = Promise.resolve()

	constructor(globalStoragePath: string) {
		this.baseDir = path.join(globalStoragePath, "ai-token-usage", "v1")
		this.statePath = path.join(this.baseDir, STATE_FILE)
	}

	async recordUsage(record: AiTokenUsageRecordInput): Promise<void> {
		await this.enqueue(async () => {
			await this.ensureLoaded()
			const state = this.state!
			const dateKey = toLocalDateKey(record.occurredAt)
			const key = buildAggregateKey(
				dateKey,
				record.userKey,
				record.projectKey,
				record.ide,
				record.provider,
				record.model,
			)
			const existing = state.rows[key]
			if (existing) {
				existing.timezone = record.timezone
				existing.userName = record.userName
				existing.sourceIp = record.sourceIp
				existing.userKey = record.userKey
				existing.organizationId = record.organizationId
				existing.organizationName = record.organizationName
				existing.workspaceName = record.workspaceName
				existing.projectKey = record.projectKey
				existing.ide = record.ide
				existing.provider = record.provider
				existing.model = record.model
				existing.requestCount += record.requestCount
				existing.inputTokens += record.inputTokens
				existing.outputTokens += record.outputTokens
				existing.cacheReadTokens += record.cacheReadTokens
				existing.cacheWriteTokens += record.cacheWriteTokens
				existing.totalTokens += record.totalTokens
				existing.firstOccurredAt = Math.min(existing.firstOccurredAt, record.occurredAt)
				existing.lastOccurredAt = Math.max(existing.lastOccurredAt, record.occurredAt)
				existing.occurredAt = existing.lastOccurredAt
				existing.dirty = true
			} else {
				state.rows[key] = {
					key,
					dateKey,
					firstOccurredAt: record.occurredAt,
					lastOccurredAt: record.occurredAt,
					dirty: true,
					...record,
				}
			}

			this.pruneExpiredRows(state)
			await this.persistState()
		})
	}

	async getPendingUploadRows(): Promise<AiTokenUsageAggregateRow[]> {
		await this.ensureLoaded()
		return Object.values(this.state!.rows)
			.filter((row) => row.dirty)
			.sort((left, right) => {
				if (left.dateKey === right.dateKey) {
					return left.key.localeCompare(right.key)
				}
				return left.dateKey.localeCompare(right.dateKey)
			})
			.map((row) => ({ ...row }))
	}

	async markRowsUploaded(keys: string[], uploadedAt: number = Date.now()): Promise<void> {
		if (keys.length === 0) {
			return
		}

		await this.enqueue(async () => {
			await this.ensureLoaded()
			for (const key of keys) {
				const row = this.state!.rows[key]
				if (!row) {
					continue
				}
				row.dirty = false
				row.uploadedAt = uploadedAt
			}
			await this.persistState()
		})
	}

	async getSummaryForRange(range: AiTokenUsageRange, nowTs: number = Date.now()): Promise<AiTokenUsageSummary> {
		await this.ensureLoaded()
		const bounds = this.resolveRangeBounds(range, nowTs)
		if (bounds === null) {
			return {
				inputTokens: 0,
				outputTokens: 0,
				totalTokens: 0,
			}
		}

		let inputTokens = 0
		let outputTokens = 0
		let totalTokens = 0

		for (const row of Object.values(this.state!.rows)) {
			if (!this.isDateInBounds(row.dateKey, bounds.fromKey, bounds.toKey)) {
				continue
			}
			inputTokens += row.inputTokens
			outputTokens += row.outputTokens
			totalTokens += row.totalTokens
		}

		return {
			inputTokens,
			outputTokens,
			totalTokens,
		}
	}

	private pruneExpiredRows(state: AiTokenUsagePersistedState, nowTs: number = Date.now()): void {
		const cutoff = new Date(nowTs)
		cutoff.setHours(0, 0, 0, 0)
		cutoff.setDate(cutoff.getDate() - AI_TOKEN_USAGE_RETENTION_DAYS)
		const cutoffKey = toLocalDateKey(cutoff.getTime())

		for (const [key, row] of Object.entries(state.rows)) {
			if (row.dateKey < cutoffKey) {
				delete state.rows[key]
			}
		}
	}

	private async ensureLoaded(): Promise<void> {
		if (this.state) {
			return
		}
		if (!this.loadPromise) {
			this.loadPromise = this.loadState()
		}
		await this.loadPromise
	}

	private async loadState(): Promise<void> {
		await fs.mkdir(this.baseDir, { recursive: true })
		try {
			const raw = await fs.readFile(this.statePath, "utf8")
			const parsed = JSON.parse(raw) as Partial<AiTokenUsagePersistedState>
			this.state = {
				version: AI_TOKEN_USAGE_VERSION,
				rows: parsed.rows ?? {},
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
				console.warn("[AiTokenUsage] Failed to read persisted state, recreating:", error)
			}
			this.state = emptyState()
			await this.persistState()
		}
	}

	private async persistState(): Promise<void> {
		await fs.mkdir(this.baseDir, { recursive: true })
		await safeWriteJson(this.statePath, this.state)
	}

	private async enqueue(operation: () => Promise<void>): Promise<void> {
		this.operationQueue = this.operationQueue.then(operation, operation)
		await this.operationQueue
	}

	private resolveRangeBounds(range: AiTokenUsageRange, nowTs: number): { fromKey?: string; toKey?: string } | null {
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
}
