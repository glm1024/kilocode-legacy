import { fetchWithRetries } from "../../shared/http"
import { AiTokenUsageStore } from "./AiTokenUsageStore"
import { resolveAiTokenUsageWebhookUrl } from "./AiTokenUsageWebhookUrl"
import {
	type AiTokenUsageAggregateRow,
	type AiTokenUsageUploadClient,
	type AiTokenUsageUploadEnvelope,
	type AiTokenUsageUploadSettings,
	buildUserKey,
	normalizeUserEmail,
} from "./types"

const DEFAULT_MAX_ROWS_PER_BATCH = 100
const DEFAULT_MAX_PAYLOAD_BYTES = 450_000

export interface AiTokenUsageUploadContext {
	client: AiTokenUsageUploadClient
	maxRowsPerBatch?: number
	maxPayloadBytes?: number
}

export interface AiTokenUsageUploadResult {
	uploaded: number
}

export class AiTokenUsageUploader {
	constructor(private readonly store: AiTokenUsageStore) {}

	async upload(
		settings: AiTokenUsageUploadSettings,
		context: AiTokenUsageUploadContext,
	): Promise<AiTokenUsageUploadResult> {
		if (!settings.webhookUrl?.trim()) {
			return { uploaded: 0 }
		}
		const fallbackUserEmail = normalizeUserEmail(settings.userEmail)
		if (!fallbackUserEmail) {
			return { uploaded: 0 }
		}

		const webhookUrl = resolveAiTokenUsageWebhookUrl(settings.webhookUrl)
		const maxRowsPerBatch = context.maxRowsPerBatch ?? DEFAULT_MAX_ROWS_PER_BATCH
		const maxPayloadBytes = context.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES
		const pendingRows = (await this.store.getPendingUploadRows()).map((row) => {
			const userEmail = normalizeUserEmail(row.userEmail) ?? fallbackUserEmail
			return {
				...row,
				userEmail,
				userKey: buildUserKey(userEmail),
			}
		})
		if (pendingRows.length === 0) {
			return { uploaded: 0 }
		}

		let uploaded = 0
		const batches = this.createBatches(pendingRows, maxRowsPerBatch, maxPayloadBytes)
		for (const batch of batches) {
			await this.postEnvelope(webhookUrl, batch, context.client)
			uploaded += batch.length
			await this.store.markRowsUploaded(batch, Date.now())
		}

		return { uploaded }
	}

	private createBatches(
		rows: AiTokenUsageAggregateRow[],
		maxRowsPerBatch: number,
		maxPayloadBytes: number,
	): AiTokenUsageAggregateRow[][] {
		if (rows.length === 0) {
			return []
		}

		const batches: AiTokenUsageAggregateRow[][] = []
		let currentBatch: AiTokenUsageAggregateRow[] = []
		let currentBatchBytes = 0

		for (const row of rows) {
			const rowBytes = Buffer.byteLength(JSON.stringify(row), "utf8")
			const wouldExceedRowCount = currentBatch.length >= maxRowsPerBatch
			const wouldExceedPayload = currentBatchBytes + rowBytes > maxPayloadBytes
			if (currentBatch.length > 0 && (wouldExceedRowCount || wouldExceedPayload)) {
				batches.push(currentBatch)
				currentBatch = []
				currentBatchBytes = 0
			}

			currentBatch.push(row)
			currentBatchBytes += rowBytes
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
	): Promise<void> {
		if (rows.length === 0) {
			return
		}

		const sorted = [...rows].sort((left, right) => {
			if (left.dateKey === right.dateKey) {
				return left.key.localeCompare(right.key)
			}
			return left.dateKey.localeCompare(right.dateKey)
		})
		const timezone = sorted[0].timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
		const payload: AiTokenUsageUploadEnvelope = {
			version: "v1",
			source: "kilocode-ai-token-usage",
			mode: "incremental",
			client,
			window: {
				fromDate: sorted[0].dateKey,
				toDate: sorted[sorted.length - 1].dateKey,
				timezone,
				generatedAt: Date.now(),
			},
			rows: sorted.map((row) => ({
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
				gitBranch: row.gitBranch,
				ide: row.ide,
				provider: row.provider,
				model: row.model,
				requestCount: row.requestCount,
				inputTokens: row.inputTokens,
				outputTokens: row.outputTokens,
				cacheReadTokens: row.cacheReadTokens,
				cacheWriteTokens: row.cacheWriteTokens,
				totalTokens: row.totalTokens,
				firstOccurredAt: row.firstOccurredAt,
				lastOccurredAt: row.lastOccurredAt,
			})),
		}

		const response = await fetchWithRetries({
			url: webhookUrl,
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify(payload),
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
	}
}
