import { createHash } from "crypto"

import { fetchWithRetries } from "../../shared/http"
import { AiTokenUsageStore } from "./AiTokenUsageStore"
import { resolveAiTokenUsageWebhookUrl } from "./AiTokenUsageWebhookUrl"
import {
	AI_TOKEN_USAGE_MAX_DATABASE_TIMESTAMP_MILLIS,
	AI_TOKEN_USAGE_MIN_DATABASE_TIMESTAMP_MILLIS,
	buildUserKey,
	type AiTokenUsageAggregateRow,
	type AiTokenUsageAggregateUploadRow,
	type AiTokenUsageUploadClient,
	type AiTokenUsageUploadEnvelope,
	type AiTokenUsageUploadSettings,
	isPersistedIdentityEmailMissing,
	isReassignableAnonymousIdentity,
	normalizeConfiguredUserEmail,
} from "./types"

const DEFAULT_MAX_ROWS_PER_BATCH = 100
const MAX_TOKEN_ROWS_PER_ENVELOPE = 1000
const DEFAULT_MAX_PAYLOAD_BYTES = 450_000
const MAX_TOKEN_PATH_CHARS = 4096
const TOKEN_DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export interface AiTokenUsageUploadContext {
	client: AiTokenUsageUploadClient
	maxRowsPerBatch?: number
	maxPayloadBytes?: number
}

export interface AiTokenUsageUploadResult {
	uploaded: number
	blocked: number
	invalid: number
}

export class AiTokenUsageUploader {
	constructor(private readonly store: AiTokenUsageStore) {}

	async upload(
		settings: AiTokenUsageUploadSettings,
		context: AiTokenUsageUploadContext,
	): Promise<AiTokenUsageUploadResult> {
		const quarantinedRowCount = await this.store.getQuarantinedRowCount()
		if (!settings.webhookUrl?.trim()) {
			return { uploaded: 0, blocked: 0, invalid: quarantinedRowCount }
		}
		const configuredUserEmail = normalizeConfiguredUserEmail(settings.userEmail)
		if (configuredUserEmail) {
			await this.store.assignAnonymousRowsToConfiguredIdentity({
				userEmail: configuredUserEmail,
				userName: settings.userName,
				departmentName: settings.departmentName,
				officeName: settings.officeName,
				teamName: settings.teamName,
			})
		}

		const webhookUrl = resolveAiTokenUsageWebhookUrl(settings.webhookUrl)
		const maxRowsPerBatch = Math.min(
			MAX_TOKEN_ROWS_PER_ENVELOPE,
			Math.max(1, Math.floor(context.maxRowsPerBatch ?? DEFAULT_MAX_ROWS_PER_BATCH)),
		)
		const maxPayloadBytes = Math.min(
			DEFAULT_MAX_PAYLOAD_BYTES,
			Math.max(1, Math.floor(context.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES)),
		)
		const generatedAt = Date.now()
		const pendingRows = await this.store.getPendingUploadRows()
		if (pendingRows.length === 0) {
			return { uploaded: 0, blocked: 0, invalid: quarantinedRowCount }
		}

		let blocked = 0
		let invalid = quarantinedRowCount
		const readyRows: AiTokenUsageAggregateRow[] = []
		const issueUpdates: Array<{
			key: string
			kind: "blocked" | "invalid"
			code: string
			reason: string
		}> = []
		for (const row of pendingRows) {
			const userEmail = normalizeConfiguredUserEmail(row.userEmail)
			if (!userEmail && !isPersistedIdentityEmailMissing(row.userEmail)) {
				invalid++
				issueUpdates.push({
					key: row.key,
					kind: "invalid",
					code: "invalid_persisted_user_email",
					reason: "Persisted Token usage has a non-empty invalid email, so automatic reassignment is unsafe",
				})
				continue
			}
			// Older builds incorrectly persisted an adjustable envelope budget as
			// permanent. Re-evaluate that one legacy issue so a corrected budget can
			// unblock the retained fact.
			if (row.uploadIssueKind === "invalid" && row.uploadIssueCode !== "row_exceeds_envelope_budget") {
				invalid++
				continue
			}

			if (!userEmail) {
				if (isReassignableAnonymousIdentity(row)) {
					blocked++
					issueUpdates.push({
						key: row.key,
						kind: "blocked",
						code: "missing_configured_user_email",
						reason: "Token usage is retained locally until a configured enterprise user email is available",
					})
				} else {
					invalid++
					issueUpdates.push({
						key: row.key,
						kind: "invalid",
						code: "invalid_persisted_user_email",
						reason: "Persisted Token usage has no valid email and no anonymous identity provenance, so automatic reassignment is unsafe",
					})
				}
				continue
			}

			const uploadRow: AiTokenUsageAggregateRow = {
				...row,
				userEmail,
				userKey: buildUserKey(userEmail),
			}
			const permanentIssue = this.getPermanentInvalidIssue(uploadRow)
			if (permanentIssue) {
				invalid++
				issueUpdates.push({ key: row.key, kind: "invalid", ...permanentIssue })
				continue
			}
			const singleRowBytes = this.envelopeByteLength([uploadRow], context.client, generatedAt)
			if (singleRowBytes > maxPayloadBytes) {
				const exceedsProtocolMaximum = singleRowBytes > DEFAULT_MAX_PAYLOAD_BYTES
				if (exceedsProtocolMaximum) {
					invalid++
				} else {
					blocked++
				}
				issueUpdates.push({
					key: row.key,
					kind: exceedsProtocolMaximum ? "invalid" : "blocked",
					code: exceedsProtocolMaximum
						? "row_exceeds_protocol_envelope_limit"
						: "row_exceeds_current_envelope_budget",
					reason: `Single Token usage row requires ${singleRowBytes} bytes, exceeding the ${maxPayloadBytes}-byte envelope budget`,
				})
				continue
			}
			readyRows.push(uploadRow)
		}

		await this.store.markRowsUploadIssues(issueUpdates)
		await this.store.clearRowsUploadIssues(readyRows.map((row) => row.key))

		let uploaded = 0
		const batches = this.createBatches(readyRows, maxRowsPerBatch, maxPayloadBytes, context.client, generatedAt)
		for (const batch of batches) {
			await this.postEnvelope(webhookUrl, batch, context.client, generatedAt)
			uploaded += batch.length
			await this.store.markRowsUploaded(batch, Date.now())
		}

		return { uploaded, blocked, invalid }
	}

	private createBatches(
		rows: AiTokenUsageAggregateRow[],
		maxRowsPerBatch: number,
		maxPayloadBytes: number,
		client: AiTokenUsageUploadClient,
		generatedAt: number,
	): AiTokenUsageAggregateRow[][] {
		if (rows.length === 0) {
			return []
		}

		const batches: AiTokenUsageAggregateRow[][] = []
		let currentBatch: AiTokenUsageAggregateRow[] = []

		for (const row of rows) {
			const wouldExceedRowCount = currentBatch.length >= maxRowsPerBatch
			const wouldExceedPayload =
				currentBatch.length > 0 &&
				this.envelopeByteLength([...currentBatch, row], client, generatedAt) > maxPayloadBytes
			if (currentBatch.length > 0 && (wouldExceedRowCount || wouldExceedPayload)) {
				batches.push(currentBatch)
				currentBatch = []
			}

			currentBatch.push(row)
		}

		if (currentBatch.length > 0) {
			batches.push(currentBatch)
		}

		return batches
	}

	private async postEnvelope(
		webhookUrl: string,
		rows: AiTokenUsageAggregateRow[],
		client: AiTokenUsageUploadClient,
		generatedAt: number,
	): Promise<void> {
		if (rows.length === 0) {
			return
		}

		const payload = this.buildEnvelope(rows, client, generatedAt)
		const body = JSON.stringify(payload)
		const payloadSha256 = createHash("sha256").update(body).digest("hex")

		const response = await fetchWithRetries({
			url: webhookUrl,
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body,
			shouldRetry: (res) => res.status >= 500 || res.status === 429,
		})

		if (!response.ok) {
			const errorBody = await response.text().catch(() => "")
			throw new Error(
				`AI token usage upload failed (${response.status} ${response.statusText})${
					errorBody ? `: ${errorBody.slice(0, 200)}` : ""
				}`,
			)
		}

		const responseBody = await response.text().catch(() => "")
		let acknowledgement: unknown
		try {
			acknowledgement = JSON.parse(responseBody)
		} catch {
			throw new Error("AI token usage upload returned an invalid acknowledgement")
		}
		if (
			typeof acknowledgement !== "object" ||
			acknowledgement === null ||
			(acknowledgement as { accepted?: unknown }).accepted !== true
		) {
			throw new Error("AI token usage upload was not accepted by the server")
		}
		const record = acknowledgement as Record<string, unknown>
		if (record.kind !== "envelope") {
			throw new Error(`AI token usage upload acknowledgement kind is ${String(record.kind)}, expected envelope`)
		}
		const acknowledgedPayloadSha256 = record.payloadSha256
		if (
			typeof acknowledgedPayloadSha256 !== "string" ||
			!/^[0-9a-f]{64}$/i.test(acknowledgedPayloadSha256) ||
			acknowledgedPayloadSha256.toLowerCase() !== payloadSha256
		) {
			throw new Error(
				`AI token usage upload acknowledgement payloadSha256 is ${String(
					acknowledgedPayloadSha256,
				)}, expected ${payloadSha256}`,
			)
		}
		const insertedEvents = record.insertedEvents
		const duplicateEvents = record.duplicateEvents
		if (
			!Number.isSafeInteger(insertedEvents) ||
			(insertedEvents as number) < 0 ||
			!Number.isSafeInteger(duplicateEvents) ||
			(duplicateEvents as number) < 0
		) {
			throw new Error("AI token usage upload acknowledgement counts must be non-negative integers")
		}
		const acknowledgedRows = (insertedEvents as number) + (duplicateEvents as number)
		if (acknowledgedRows !== rows.length) {
			throw new Error(
				`AI token usage upload acknowledgement count is ${acknowledgedRows}, expected ${rows.length}`,
			)
		}
	}

	private buildEnvelope(
		rows: AiTokenUsageAggregateRow[],
		client: AiTokenUsageUploadClient,
		generatedAt: number,
	): AiTokenUsageUploadEnvelope {
		const sorted = [...rows].sort((left, right) => {
			if (left.dateKey === right.dateKey) {
				return left.key.localeCompare(right.key)
			}
			return left.dateKey.localeCompare(right.dateKey)
		})
		const timezone = sorted[0].timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
		return {
			version: "v1",
			source: "kilocode-ai-token-usage",
			mode: "incremental",
			client,
			window: {
				fromDate: sorted[0].dateKey,
				toDate: sorted[sorted.length - 1].dateKey,
				timezone,
				generatedAt,
			},
			rows: sorted.map((row) => this.toUploadRow(row)),
		}
	}

	private toUploadRow(row: AiTokenUsageAggregateRow): AiTokenUsageAggregateUploadRow {
		return {
			dateKey: row.dateKey,
			timezone: row.timezone,
			userName: row.userName,
			userEmail: row.userEmail,
			departmentName: row.departmentName,
			officeName: row.officeName,
			teamName: row.teamName,
			sourceIp: row.sourceIp,
			userKey: row.userKey,
			organizationId: row.organizationId,
			organizationName: row.organizationName,
			projectKey: row.projectKey,
			projectName: row.projectName,
			repoRoot: row.repoRoot,
			gitRemoteUrl: row.gitRemoteUrl,
			// Branch remains compatible local metadata, but it is not part of
			// the Token usage dimension or filter contract.
			ide: row.ide,
			provider: row.provider,
			model: row.model,
			requestCount: row.requestCount,
			inputTokens: row.inputTokens,
			outputTokens: row.outputTokens,
			cacheReadTokens: row.cacheReadTokens,
			cacheReadObservedRequestCount: row.cacheReadObservedRequestCount ?? 0,
			cacheReadObservedInputTokens: row.cacheReadObservedInputTokens ?? 0,
			cacheWriteTokens: row.cacheWriteTokens,
			totalTokens: row.totalTokens,
			firstOccurredAt: row.firstOccurredAt,
			lastOccurredAt: row.lastOccurredAt,
		}
	}

	private envelopeByteLength(
		rows: AiTokenUsageAggregateRow[],
		client: AiTokenUsageUploadClient,
		generatedAt: number,
	): number {
		return Buffer.byteLength(JSON.stringify(this.buildEnvelope(rows, client, generatedAt)), "utf8")
	}

	private getPermanentInvalidIssue(row: AiTokenUsageAggregateRow): { code: string; reason: string } | undefined {
		if (!this.isValidDateKey(row.dateKey)) {
			return {
				code: "invalid_date_key",
				reason: `Token usage dateKey is outside the supported protocol: ${row.dateKey}`,
			}
		}
		const stringColumns: Array<{
			value: unknown
			maxChars: number
			name: string
			required?: boolean
		}> = [
			{ value: row.timezone, maxChars: 64, name: "timezone" },
			{ value: row.userName, maxChars: 255, name: "userName" },
			{ value: row.userEmail, maxChars: 255, name: "userEmail", required: true },
			{ value: row.departmentName, maxChars: 255, name: "departmentName" },
			{ value: row.officeName, maxChars: 255, name: "officeName" },
			{ value: row.teamName, maxChars: 255, name: "teamName" },
			{ value: row.sourceIp, maxChars: 64, name: "sourceIp" },
			{ value: row.userKey, maxChars: 261, name: "userKey", required: true },
			{ value: row.organizationId, maxChars: 128, name: "organizationId" },
			{ value: row.organizationName, maxChars: 255, name: "organizationName" },
			{ value: row.projectKey, maxChars: 64, name: "projectKey", required: true },
			{ value: row.projectName, maxChars: 255, name: "projectName" },
			{ value: row.repoRoot, maxChars: MAX_TOKEN_PATH_CHARS, name: "repoRoot" },
			{ value: row.gitRemoteUrl, maxChars: MAX_TOKEN_PATH_CHARS, name: "gitRemoteUrl" },
			{ value: row.ide, maxChars: 32, name: "ide", required: true },
			{ value: row.provider, maxChars: 128, name: "provider", required: true },
			{ value: row.model, maxChars: 255, name: "model", required: true },
		]
		for (const column of stringColumns) {
			if (column.value === undefined || column.value === null) {
				if (column.required) {
					return {
						code: "missing_required_dimension",
						reason: `Token usage ${column.name} is required by the upload protocol`,
					}
				}
				continue
			}
			if (typeof column.value !== "string") {
				return {
					code: "invalid_string_dimension",
					reason: `Token usage ${column.name} must be a string when present`,
				}
			}
			if (column.required && !column.value.trim()) {
				return {
					code: "missing_required_dimension",
					reason: `Token usage ${column.name} is required by the upload protocol`,
				}
			}
			if (Array.from(column.value.trim()).length > column.maxChars) {
				return {
					code: "dimension_exceeds_protocol_limit",
					reason: `Token usage ${column.name} exceeds the ${column.maxChars}-character protocol limit`,
				}
			}
		}
		const numericValues = [
			row.requestCount,
			row.inputTokens,
			row.outputTokens,
			row.cacheReadTokens,
			row.cacheReadObservedRequestCount ?? 0,
			row.cacheReadObservedInputTokens ?? 0,
			row.cacheWriteTokens,
			row.totalTokens,
			row.firstOccurredAt,
			row.lastOccurredAt,
		]
		if (!numericValues.every((value) => Number.isSafeInteger(value))) {
			return {
				code: "invalid_numeric_value",
				reason: "Token usage counters and occurrence timestamps must be safe integers",
			}
		}
		const counters = [
			row.requestCount,
			row.inputTokens,
			row.outputTokens,
			row.cacheReadTokens,
			row.cacheReadObservedRequestCount ?? 0,
			row.cacheReadObservedInputTokens ?? 0,
			row.cacheWriteTokens,
			row.totalTokens,
		]
		if (counters.some((value) => value < 0)) {
			return {
				code: "negative_token_counter",
				reason: "Token usage counters must be non-negative",
			}
		}
		if (
			(row.cacheReadObservedRequestCount ?? 0) > row.requestCount ||
			(row.cacheReadObservedInputTokens ?? 0) > row.inputTokens
		) {
			return {
				code: "invalid_cache_observation_coverage",
				reason: "Token cache observation coverage cannot exceed the corresponding request or input totals",
			}
		}
		if (
			row.firstOccurredAt < AI_TOKEN_USAGE_MIN_DATABASE_TIMESTAMP_MILLIS ||
			row.firstOccurredAt > AI_TOKEN_USAGE_MAX_DATABASE_TIMESTAMP_MILLIS ||
			row.lastOccurredAt < AI_TOKEN_USAGE_MIN_DATABASE_TIMESTAMP_MILLIS ||
			row.lastOccurredAt > AI_TOKEN_USAGE_MAX_DATABASE_TIMESTAMP_MILLIS
		) {
			return {
				code: "timestamp_outside_database_range",
				reason: "Token usage occurrence timestamp is outside the backend database-safe range",
			}
		}
		if (row.firstOccurredAt > row.lastOccurredAt) {
			return {
				code: "reversed_occurrence_window",
				reason: "Token usage firstOccurredAt is later than lastOccurredAt",
			}
		}
		return undefined
	}

	private isValidDateKey(value: string): boolean {
		if (!TOKEN_DATE_KEY_PATTERN.test(value)) {
			return false
		}
		const [year, month, day] = value.split("-").map(Number)
		const parsed = new Date(Date.UTC(year, month - 1, day))
		return (
			year >= 1000 &&
			year <= 9999 &&
			parsed.getUTCFullYear() === year &&
			parsed.getUTCMonth() === month - 1 &&
			parsed.getUTCDate() === day
		)
	}
}
