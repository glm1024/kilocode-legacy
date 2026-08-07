import { randomUUID } from "crypto"
import { AsyncLocalStorage } from "async_hooks"
import * as fs from "fs/promises"
import * as path from "path"

import { recoverSafeWriteJson, safeWriteJson, withCrossProcessFileLock } from "../../utils/safeWriteJson"
import {
	AI_TOKEN_USAGE_RETENTION_DAYS,
	AI_TOKEN_USAGE_VERSION,
	buildAggregateKey,
	buildUserKey,
	normalizeConfiguredUserEmail,
	toLocalDateKey,
	type AiTokenUsageAggregateRow,
	type AiTokenUsagePersistedState,
	type AiTokenUsageRecordInput,
	type AiTokenUsageRange,
	type AiTokenUsageSummary,
} from "./types"

const STATE_FILE = "state.json"
const STORE_REVISION_VERSION = 1 as const
const DATE_KEY_REGEX = /^\d{4}-\d{2}-\d{2}$/
const saturatingAdd = (left: number, right: number): number =>
	left > Number.MAX_SAFE_INTEGER - right ? Number.MAX_SAFE_INTEGER : left + right
const MISSING_IDENTITY_REASON = "Token usage is retained locally until a configured enterprise user email is available"

export interface AiTokenUsageConfiguredIdentity {
	userEmail: string
	userName?: string
	departmentName?: string
	officeName?: string
	teamName?: string
}

export interface AiTokenUsageUploadIssueUpdate {
	key: string
	kind: "blocked" | "invalid"
	code: string
	reason: string
}

const emptyState = (): AiTokenUsagePersistedState => ({
	version: AI_TOKEN_USAGE_VERSION,
	rows: {},
})

export class AiTokenUsageStore {
	private readonly baseDir: string
	private readonly statePath: string
	private readonly storeLockPath: string
	private readonly revisionPath: string
	private state: AiTokenUsagePersistedState | null = null
	private loadPromise: Promise<void> | null = null
	private operationQueue: Promise<void> = Promise.resolve()
	private loadedRevision: string | undefined
	private readonly storeLockContext = new AsyncLocalStorage<boolean>()

	constructor(globalStoragePath: string) {
		this.baseDir = path.join(globalStoragePath, "ai-token-usage", "v1")
		this.statePath = path.join(this.baseDir, STATE_FILE)
		this.storeLockPath = path.join(globalStoragePath, ".ai-token-usage-v1-store")
		this.revisionPath = path.join(globalStoragePath, ".ai-token-usage-v1-revision.json")
	}

	async recordUsage(record: AiTokenUsageRecordInput): Promise<void> {
		await this.enqueue(async () => {
			await this.ensureLoaded()
			const state = this.state!
			const configuredEmail = normalizeConfiguredUserEmail(record.userEmail)
			const identityKind = record.identityKind ?? (configuredEmail ? "configured" : "anonymous")
			const effectiveEmail = identityKind === "configured" ? configuredEmail : undefined
			const normalizedRecord: AiTokenUsageRecordInput = {
				...record,
				userEmail: effectiveEmail,
				userKey: effectiveEmail ? buildUserKey(effectiveEmail) : record.userKey,
				identityKind,
			}
			const dateKey = toLocalDateKey(record.occurredAt)
			const key = buildAggregateKey(
				dateKey,
				normalizedRecord.userKey,
				record.projectKey,
				record.ide,
				record.provider,
				record.model,
			)
			let existing = state.rows[key]
			if (!existing) {
				const legacyEntry = Object.entries(state.rows).find(
					([, row]) =>
						row.dateKey === dateKey &&
						row.userKey === normalizedRecord.userKey &&
						row.projectKey === record.projectKey &&
						row.ide === record.ide &&
						row.provider === record.provider &&
						row.model === record.model,
				)
				if (legacyEntry) {
					const [legacyKey, legacyRow] = legacyEntry
					delete state.rows[legacyKey]
					legacyRow.key = key
					state.rows[key] = legacyRow
					existing = legacyRow
				}
			}
			if (existing) {
				existing.timezone = normalizedRecord.timezone
				existing.userName = normalizedRecord.userName
				existing.userEmail = normalizedRecord.userEmail
				existing.departmentName = normalizedRecord.departmentName
				existing.officeName = normalizedRecord.officeName
				existing.teamName = normalizedRecord.teamName
				existing.sourceIp = normalizedRecord.sourceIp
				existing.userKey = normalizedRecord.userKey
				existing.identityKind = identityKind
				existing.organizationId = normalizedRecord.organizationId
				existing.organizationName = normalizedRecord.organizationName
				existing.projectKey = normalizedRecord.projectKey
				existing.projectName = normalizedRecord.projectName
				existing.repoRoot = normalizedRecord.repoRoot
				existing.gitRemoteUrl = normalizedRecord.gitRemoteUrl
				existing.gitBranch = normalizedRecord.gitBranch
				existing.ide = normalizedRecord.ide
				existing.provider = normalizedRecord.provider
				existing.model = normalizedRecord.model
				existing.requestCount = saturatingAdd(existing.requestCount, normalizedRecord.requestCount)
				existing.inputTokens = saturatingAdd(existing.inputTokens, normalizedRecord.inputTokens)
				existing.outputTokens = saturatingAdd(existing.outputTokens, normalizedRecord.outputTokens)
				existing.cacheReadTokens = saturatingAdd(existing.cacheReadTokens, normalizedRecord.cacheReadTokens)
				existing.cacheWriteTokens = saturatingAdd(existing.cacheWriteTokens, normalizedRecord.cacheWriteTokens)
				existing.totalTokens = saturatingAdd(existing.totalTokens, normalizedRecord.totalTokens)
				existing.firstOccurredAt = Math.min(existing.firstOccurredAt, record.occurredAt)
				existing.lastOccurredAt = Math.max(existing.lastOccurredAt, record.occurredAt)
				existing.occurredAt = existing.lastOccurredAt
				existing.dirty = true
				if (identityKind === "configured") {
					this.clearUploadIssue(existing)
				} else {
					this.setUploadIssue(existing, "blocked", "missing_configured_user_email", MISSING_IDENTITY_REASON)
				}
			} else {
				state.rows[key] = {
					key,
					dateKey,
					firstOccurredAt: record.occurredAt,
					lastOccurredAt: record.occurredAt,
					dirty: true,
					...normalizedRecord,
				}
				if (identityKind === "anonymous") {
					this.setUploadIssue(
						state.rows[key],
						"blocked",
						"missing_configured_user_email",
						MISSING_IDENTITY_REASON,
					)
				}
			}

			this.pruneExpiredRows(state)
			await this.persistState()
		})
	}

	/**
	 * Assigns only facts explicitly persisted as anonymous. Rows already tied to
	 * any configured email are never rewritten, even when current settings now
	 * contain a different email.
	 */
	async assignAnonymousRowsToConfiguredIdentity(identity: AiTokenUsageConfiguredIdentity): Promise<number> {
		const userEmail = normalizeConfiguredUserEmail(identity.userEmail)
		if (!userEmail) {
			return 0
		}

		let assigned = 0
		await this.enqueue(async () => {
			await this.ensureLoaded()
			const state = this.state!
			for (const [oldKey, row] of Object.entries({ ...state.rows })) {
				if (!row.dirty || row.identityKind !== "anonymous") {
					continue
				}

				const userKey = buildUserKey(userEmail)
				const newKey = buildAggregateKey(row.dateKey, userKey, row.projectKey, row.ide, row.provider, row.model)
				const adopted: AiTokenUsageAggregateRow = {
					...row,
					key: newKey,
					userKey,
					userEmail,
					userName: identity.userName?.trim() || row.userName,
					departmentName: identity.departmentName?.trim() || undefined,
					officeName: identity.officeName?.trim() || undefined,
					teamName: identity.teamName?.trim() || undefined,
					identityKind: "configured",
				}
				this.clearUploadIssue(adopted)

				const target = state.rows[newKey]
				if (target && target !== row) {
					const targetEmail = normalizeConfiguredUserEmail(target.userEmail)
					if (targetEmail !== userEmail) {
						this.setUploadIssue(
							row,
							"invalid",
							"identity_key_collision",
							"Anonymous Token usage could not be assigned without overwriting another configured identity",
						)
						continue
					}
					target.requestCount = saturatingAdd(target.requestCount, adopted.requestCount)
					target.inputTokens = saturatingAdd(target.inputTokens, adopted.inputTokens)
					target.outputTokens = saturatingAdd(target.outputTokens, adopted.outputTokens)
					target.cacheReadTokens = saturatingAdd(target.cacheReadTokens, adopted.cacheReadTokens)
					target.cacheWriteTokens = saturatingAdd(target.cacheWriteTokens, adopted.cacheWriteTokens)
					target.totalTokens = saturatingAdd(target.totalTokens, adopted.totalTokens)
					target.firstOccurredAt = Math.min(target.firstOccurredAt, adopted.firstOccurredAt)
					target.lastOccurredAt = Math.max(target.lastOccurredAt, adopted.lastOccurredAt)
					target.occurredAt = target.lastOccurredAt
					target.dirty = true
					target.identityKind = "configured"
					target.userEmail = userEmail
					target.userKey = userKey
					target.userName = adopted.userName
					target.departmentName = adopted.departmentName
					target.officeName = adopted.officeName
					target.teamName = adopted.teamName
					this.clearUploadIssue(target)
				} else {
					state.rows[newKey] = adopted
				}
				delete state.rows[oldKey]
				assigned++
			}
			if (assigned > 0) {
				await this.persistState()
			}
		})
		return assigned
	}

	async markRowsUploadIssues(issues: AiTokenUsageUploadIssueUpdate[]): Promise<void> {
		if (issues.length === 0) {
			return
		}
		await this.enqueue(async () => {
			await this.ensureLoaded()
			let changed = false
			for (const issue of issues) {
				const row = this.state!.rows[issue.key]
				if (!row || !row.dirty) {
					continue
				}
				if (
					row.uploadIssueKind === issue.kind &&
					row.uploadIssueCode === issue.code &&
					row.uploadIssueReason === issue.reason
				) {
					continue
				}
				this.setUploadIssue(row, issue.kind, issue.code, issue.reason)
				changed = true
			}
			if (changed) {
				await this.persistState()
			}
		})
	}

	async clearRowsUploadIssues(keys: string[]): Promise<void> {
		if (keys.length === 0) {
			return
		}
		await this.enqueue(async () => {
			await this.ensureLoaded()
			let changed = false
			for (const key of keys) {
				const row = this.state!.rows[key]
				if (!row || !row.dirty || !row.uploadIssueKind) {
					continue
				}
				this.clearUploadIssue(row)
				changed = true
			}
			if (changed) {
				await this.persistState()
			}
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

	async markRowsUploaded(uploadedRows: AiTokenUsageAggregateRow[], uploadedAt: number = Date.now()): Promise<void> {
		if (uploadedRows.length === 0) {
			return
		}

		await this.enqueue(async () => {
			await this.ensureLoaded()
			for (const uploadedRow of uploadedRows) {
				const row = this.state!.rows[uploadedRow.key]
				if (!row) {
					continue
				}
				if (!this.isSameUploadedSnapshot(row, uploadedRow)) {
					continue
				}
				row.dirty = false
				row.uploadedAt = uploadedAt
				this.clearUploadIssue(row)
			}
			this.pruneExpiredRows(this.state!, uploadedAt)
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
			inputTokens = saturatingAdd(inputTokens, row.inputTokens)
			outputTokens = saturatingAdd(outputTokens, row.outputTokens)
			totalTokens = saturatingAdd(totalTokens, row.totalTokens)
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
			if (row.dateKey < cutoffKey && !row.dirty) {
				delete state.rows[key]
			}
		}
	}

	private async ensureLoaded(): Promise<void> {
		if (this.storeLockContext.getStore()) {
			if (!this.state) {
				await this.loadState()
			}
			return
		}

		await withCrossProcessFileLock(this.storeLockPath, () =>
			this.storeLockContext.run(true, async () => {
				await this.refreshFromDiskIfNeeded()
			}),
		)
	}

	private async loadState(): Promise<void> {
		await fs.mkdir(this.baseDir, { recursive: true })
		await recoverSafeWriteJson(this.statePath)
		try {
			const raw = await fs.readFile(this.statePath, "utf8")
			const parsed = JSON.parse(raw) as Partial<AiTokenUsagePersistedState>
			if (
				(parsed.version !== undefined && parsed.version !== AI_TOKEN_USAGE_VERSION) ||
				typeof parsed.rows !== "object" ||
				parsed.rows === null ||
				Array.isArray(parsed.rows)
			) {
				throw new Error("Incompatible AI token usage state")
			}
			this.state = {
				version: AI_TOKEN_USAGE_VERSION,
				rows: parsed.rows,
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
				console.warn("[AiTokenUsage] Failed to read persisted state, recreating:", error)
				await fs.rename(this.statePath, `${this.statePath}.corrupt-${Date.now()}`).catch((archiveError) => {
					if ((archiveError as NodeJS.ErrnoException)?.code !== "ENOENT") {
						throw archiveError
					}
				})
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
		const guardedOperation = async () => {
			await withCrossProcessFileLock(this.storeLockPath, () =>
				this.storeLockContext.run(true, async () => {
					await this.refreshFromDiskIfNeeded()
					const nextRevision = await this.writeNextRevision()
					try {
						await operation()
						this.loadedRevision = nextRevision
					} catch (error) {
						this.resetLoadedState()
						throw error
					}
				}),
			)
		}
		this.operationQueue = this.operationQueue.then(guardedOperation, guardedOperation)
		await this.operationQueue
	}

	private async refreshFromDiskIfNeeded(): Promise<void> {
		let diskRevision = await this.readRevision()
		if (!diskRevision) {
			diskRevision = await this.writeNextRevision()
		}
		if (this.state && this.loadedRevision === diskRevision) {
			return
		}

		this.resetLoadedState()
		if (!this.loadPromise) {
			this.loadPromise = this.loadState()
		}
		try {
			await this.loadPromise
			this.loadedRevision = diskRevision
		} catch (error) {
			this.resetLoadedState()
			throw error
		}
	}

	private async readRevision(): Promise<string | undefined> {
		await recoverSafeWriteJson(this.revisionPath)
		try {
			const parsed = JSON.parse(await fs.readFile(this.revisionPath, "utf8")) as {
				version?: number
				revision?: string
			}
			if (
				parsed.version !== STORE_REVISION_VERSION ||
				typeof parsed.revision !== "string" ||
				!parsed.revision.trim()
			) {
				throw new Error("Invalid AI token usage store revision")
			}
			return parsed.revision
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
				await fs
					.rename(this.revisionPath, `${this.revisionPath}.corrupt-${Date.now()}`)
					.catch((archiveError) => {
						if ((archiveError as NodeJS.ErrnoException)?.code !== "ENOENT") {
							throw archiveError
						}
					})
			}
			return undefined
		}
	}

	private async writeNextRevision(): Promise<string> {
		const revision = `${Date.now()}-${process.pid}-${randomUUID()}`
		await safeWriteJson(this.revisionPath, {
			version: STORE_REVISION_VERSION,
			revision,
		})
		return revision
	}

	private resetLoadedState(): void {
		this.state = null
		this.loadPromise = null
		this.loadedRevision = undefined
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

	private isSameUploadedSnapshot(current: AiTokenUsageAggregateRow, uploaded: AiTokenUsageAggregateRow): boolean {
		return (
			current.requestCount === uploaded.requestCount &&
			current.inputTokens === uploaded.inputTokens &&
			current.outputTokens === uploaded.outputTokens &&
			current.cacheReadTokens === uploaded.cacheReadTokens &&
			current.cacheWriteTokens === uploaded.cacheWriteTokens &&
			current.totalTokens === uploaded.totalTokens &&
			current.firstOccurredAt === uploaded.firstOccurredAt &&
			current.lastOccurredAt === uploaded.lastOccurredAt
		)
	}

	private setUploadIssue(
		row: AiTokenUsageAggregateRow,
		kind: "blocked" | "invalid",
		code: string,
		reason: string,
	): void {
		if (
			row.uploadIssueKind === kind &&
			row.uploadIssueCode === code &&
			row.uploadIssueReason === reason &&
			row.uploadIssueAt
		) {
			return
		}
		row.uploadIssueKind = kind
		row.uploadIssueCode = code
		row.uploadIssueReason = reason
		row.uploadIssueAt = Date.now()
	}

	private clearUploadIssue(row: AiTokenUsageAggregateRow): void {
		delete row.uploadIssueKind
		delete row.uploadIssueCode
		delete row.uploadIssueReason
		delete row.uploadIssueAt
	}
}
