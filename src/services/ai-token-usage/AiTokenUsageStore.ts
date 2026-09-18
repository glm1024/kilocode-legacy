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
	classifyUserEmail,
	isReassignableAnonymousIdentity,
	normalizeConfiguredUserEmail,
	toLocalDateKey,
	type AiTokenUsageAggregateRow,
	type AiTokenUsagePersistedState,
	type AiTokenUsageQuarantinedRow,
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
	quarantinedRows: {},
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

const requiredStringFields = [
	"key",
	"dateKey",
	"timezone",
	"userName",
	"sourceIp",
	"userKey",
	"projectKey",
	"projectName",
	"ide",
	"provider",
	"model",
] as const

const optionalStringFields = [
	"taskId",
	"userEmail",
	"departmentName",
	"officeName",
	"teamName",
	"organizationId",
	"organizationName",
	"repoRoot",
	"gitRemoteUrl",
	"gitBranch",
	"uploadIssueCode",
	"uploadIssueReason",
] as const

const requiredNumberFields = [
	"occurredAt",
	"requestCount",
	"inputTokens",
	"outputTokens",
	"cacheReadTokens",
	"cacheWriteTokens",
	"totalTokens",
	"firstOccurredAt",
	"lastOccurredAt",
] as const

const optionalNumberFields = [
	"cacheReadObservedRequestCount",
	"cacheReadObservedInputTokens",
	"uploadedAt",
	"uploadIssueAt",
] as const

const validatePersistedRow = (sourceKey: string, value: unknown): string | undefined => {
	if (!isRecord(value)) {
		return "Persisted Token usage row must be a JSON object"
	}
	for (const field of requiredStringFields) {
		if (typeof value[field] !== "string") {
			return `Persisted Token usage row field ${field} must be a string`
		}
	}
	for (const field of optionalStringFields) {
		if (value[field] !== undefined && typeof value[field] !== "string") {
			return `Persisted Token usage row field ${field} must be a string when present`
		}
	}
	for (const field of requiredNumberFields) {
		if (typeof value[field] !== "number" || !Number.isFinite(value[field])) {
			return `Persisted Token usage row field ${field} must be a finite number`
		}
	}
	for (const field of optionalNumberFields) {
		if (value[field] !== undefined && (typeof value[field] !== "number" || !Number.isFinite(value[field]))) {
			return `Persisted Token usage row field ${field} must be a finite number when present`
		}
	}
	if (typeof value.dirty !== "boolean") {
		return "Persisted Token usage row field dirty must be a boolean"
	}
	if (value.identityKind !== undefined && value.identityKind !== "anonymous" && value.identityKind !== "configured") {
		return "Persisted Token usage row field identityKind is invalid"
	}
	if (
		value.uploadIssueKind !== undefined &&
		value.uploadIssueKind !== "blocked" &&
		value.uploadIssueKind !== "invalid"
	) {
		return "Persisted Token usage row field uploadIssueKind is invalid"
	}
	if (value.key !== sourceKey) {
		return "Persisted Token usage row key does not match its storage key"
	}
	return undefined
}

const isQuarantinedRow = (value: unknown): value is AiTokenUsageQuarantinedRow =>
	isRecord(value) &&
	typeof value.sourceKey === "string" &&
	typeof value.detectedAt === "number" &&
	Number.isFinite(value.detectedAt) &&
	value.issueCode === "invalid_persisted_row_structure" &&
	typeof value.issueReason === "string" &&
	Object.prototype.hasOwnProperty.call(value, "raw")

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
			const inputIdentity = classifyUserEmail(record.userEmail)
			const configuredEmail = inputIdentity.kind === "valid" ? inputIdentity.userEmail : undefined
			const identityKind = record.identityKind ?? (configuredEmail ? "configured" : "anonymous")
			const effectiveEmail =
				inputIdentity.kind === "invalid"
					? record.userEmail
					: identityKind === "configured"
						? configuredEmail
						: undefined
			const normalizedRecord: AiTokenUsageRecordInput = {
				...record,
				cacheReadObservedRequestCount: record.cacheReadObservedRequestCount ?? 0,
				cacheReadObservedInputTokens: record.cacheReadObservedInputTokens ?? 0,
				userEmail: effectiveEmail,
				userKey: effectiveEmail ? buildUserKey(effectiveEmail) : record.userKey,
				identityKind,
			}
			const dateKey = toLocalDateKey(record.occurredAt)
			const aggregateKey = buildAggregateKey(
				dateKey,
				normalizedRecord.userKey,
				record.projectKey,
				record.ide,
				record.provider,
				record.model,
			)
			// A newly observed invalid-present identity is its own forensic fact.
			// It must not poison an otherwise assignable anonymous aggregate that
			// happens to share the same installation/dimension key.
			const key =
				inputIdentity.kind === "invalid"
					? JSON.stringify(["invalid-identity", aggregateKey, randomUUID()])
					: aggregateKey
			let existing: AiTokenUsageAggregateRow | undefined = state.rows[key]
			if (!existing && inputIdentity.kind !== "invalid") {
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
			if (existing && classifyUserEmail(existing.userEmail).kind === "invalid") {
				// A later healthy fact must never wash a non-empty invalid identity
				// into the assignable anonymous state. Preserve the historical fact
				// under a distinct forensic key and record the new fact separately.
				this.setUploadIssue(
					existing,
					"invalid",
					"invalid_persisted_user_email",
					"Persisted Token usage has a non-empty invalid email, so later facts cannot replace or reassign it",
				)
				const quarantinedKey = JSON.stringify(["invalid-identity", key, randomUUID()])
				delete state.rows[key]
				existing.key = quarantinedKey
				state.rows[quarantinedKey] = existing
				existing = undefined
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
				existing.cacheReadObservedRequestCount = saturatingAdd(
					existing.cacheReadObservedRequestCount ?? 0,
					normalizedRecord.cacheReadObservedRequestCount ?? 0,
				)
				existing.cacheReadObservedInputTokens = saturatingAdd(
					existing.cacheReadObservedInputTokens ?? 0,
					normalizedRecord.cacheReadObservedInputTokens ?? 0,
				)
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
				if (inputIdentity.kind === "invalid") {
					this.setUploadIssue(
						state.rows[key],
						"invalid",
						"invalid_persisted_user_email",
						"Token usage was recorded with a non-empty invalid email and cannot be reassigned safely",
					)
				} else if (identityKind === "anonymous") {
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
		let collisionDiagnosticsChanged = false
		await this.enqueue(async () => {
			await this.ensureLoaded()
			const state = this.state!
			for (const [oldKey, row] of Object.entries({ ...state.rows })) {
				if (!row.dirty || !isReassignableAnonymousIdentity(row)) {
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
					const targetIdentity = classifyUserEmail(target.userEmail)
					if (targetIdentity.kind !== "valid" || targetIdentity.userEmail !== userEmail) {
						if (targetIdentity.kind === "invalid") {
							this.setUploadIssue(
								target,
								"invalid",
								"invalid_persisted_user_email",
								"Persisted Token usage collision target has an invalid email, so automatic reassignment is unsafe",
							)
						}
						this.setUploadIssue(
							row,
							"invalid",
							"identity_key_collision",
							"Anonymous Token usage could not be assigned without overwriting another configured identity",
						)
						collisionDiagnosticsChanged = true
						continue
					}
					target.requestCount = saturatingAdd(target.requestCount, adopted.requestCount)
					target.inputTokens = saturatingAdd(target.inputTokens, adopted.inputTokens)
					target.outputTokens = saturatingAdd(target.outputTokens, adopted.outputTokens)
					target.cacheReadTokens = saturatingAdd(target.cacheReadTokens, adopted.cacheReadTokens)
					target.cacheReadObservedRequestCount = saturatingAdd(
						target.cacheReadObservedRequestCount ?? 0,
						adopted.cacheReadObservedRequestCount ?? 0,
					)
					target.cacheReadObservedInputTokens = saturatingAdd(
						target.cacheReadObservedInputTokens ?? 0,
						adopted.cacheReadObservedInputTokens ?? 0,
					)
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
			if (assigned > 0 || collisionDiagnosticsChanged) {
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

	async getQuarantinedRows(): Promise<AiTokenUsageQuarantinedRow[]> {
		await this.ensureLoaded()
		return Object.values(this.state!.quarantinedRows)
			.sort((left, right) => {
				if (left.detectedAt === right.detectedAt) {
					return left.sourceKey.localeCompare(right.sourceKey)
				}
				return left.detectedAt - right.detectedAt
			})
			.map((row) => ({ ...row }))
	}

	async getQuarantinedRowCount(): Promise<number> {
		await this.ensureLoaded()
		return Object.keys(this.state!.quarantinedRows).length
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
		let shouldPersistQuarantine = false
		try {
			const raw = await fs.readFile(this.statePath, "utf8")
			const parsed: unknown = JSON.parse(raw)
			if (
				!isRecord(parsed) ||
				(parsed.version !== undefined && parsed.version !== AI_TOKEN_USAGE_VERSION) ||
				!isRecord(parsed.rows)
			) {
				throw new Error("Incompatible AI token usage state")
			}

			const quarantinedRows: Record<string, AiTokenUsageQuarantinedRow> = Object.create(null)
			if (parsed.quarantinedRows !== undefined) {
				if (isRecord(parsed.quarantinedRows)) {
					for (const [quarantineKey, quarantinedValue] of Object.entries(parsed.quarantinedRows)) {
						if (isQuarantinedRow(quarantinedValue)) {
							quarantinedRows[quarantineKey] = quarantinedValue
						} else {
							this.addQuarantinedRow(
								quarantinedRows,
								`quarantinedRows.${quarantineKey}`,
								quarantinedValue,
								"Persisted Token usage quarantine entry is structurally invalid",
							)
							shouldPersistQuarantine = true
						}
					}
				} else {
					this.addQuarantinedRow(
						quarantinedRows,
						"quarantinedRows",
						parsed.quarantinedRows,
						"Persisted Token usage quarantine container must be a JSON object",
					)
					shouldPersistQuarantine = true
				}
			}

			const rows: Record<string, AiTokenUsageAggregateRow> = Object.create(null)
			for (const [sourceKey, value] of Object.entries(parsed.rows)) {
				const issueReason = validatePersistedRow(sourceKey, value)
				if (issueReason) {
					this.addQuarantinedRow(quarantinedRows, sourceKey, value, issueReason)
					shouldPersistQuarantine = true
					continue
				}
				rows[sourceKey] = {
					...(value as unknown as AiTokenUsageAggregateRow),
					cacheReadObservedRequestCount:
						((value as Record<string, unknown>).cacheReadObservedRequestCount as number | undefined) ?? 0,
					cacheReadObservedInputTokens:
						((value as Record<string, unknown>).cacheReadObservedInputTokens as number | undefined) ?? 0,
				}
			}
			this.state = {
				version: AI_TOKEN_USAGE_VERSION,
				rows,
				quarantinedRows,
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
			return
		}
		if (shouldPersistQuarantine) {
			await this.persistState()
		}
	}

	private addQuarantinedRow(
		quarantinedRows: Record<string, AiTokenUsageQuarantinedRow>,
		sourceKey: string,
		raw: unknown,
		issueReason: string,
	): void {
		let quarantineKey = sourceKey
		while (Object.prototype.hasOwnProperty.call(quarantinedRows, quarantineKey)) {
			quarantineKey = JSON.stringify([sourceKey, randomUUID()])
		}
		quarantinedRows[quarantineKey] = {
			sourceKey,
			detectedAt: Date.now(),
			issueCode: "invalid_persisted_row_structure",
			issueReason,
			raw,
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
			(current.cacheReadObservedRequestCount ?? 0) === (uploaded.cacheReadObservedRequestCount ?? 0) &&
			(current.cacheReadObservedInputTokens ?? 0) === (uploaded.cacheReadObservedInputTokens ?? 0) &&
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
