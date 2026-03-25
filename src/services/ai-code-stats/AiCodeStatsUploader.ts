// kilocode_change - new file

import { fetchWithRetries } from "../../shared/http"
import { AiCodeStatsStore } from "./AiCodeStatsStore"
import { resolveAiCodeStatsWebhookUrl } from "./AiCodeStatsWebhookUrl"
import {
	normalizePath,
	type AiCodeStatsEvent,
	type AiCodeStatsRange,
	type AiCodeStatsUploadClient,
	type AiCodeStatsUploadEnvelope,
	type AiCodeUploadMode,
	type AiCodeStatsUploadSettings,
} from "./types"

const DEFAULT_MAX_EVENTS_PER_BATCH = 100
const DEFAULT_MAX_PAYLOAD_BYTES = 450_000

export interface AiCodeStatsUploadContext {
	client: AiCodeStatsUploadClient
	maxEventsPerBatch?: number
	maxPayloadBytes?: number
}

export interface AiCodeStatsUploadResult {
	uploaded: number
}

export interface AiCodeStatsRangeUploadContext {
	client: AiCodeStatsUploadClient
	range: AiCodeStatsRange
	maxEventsPerBatch?: number
	maxPayloadBytes?: number
}

export interface AiCodeStatsRangeUploadResult {
	uploaded: number
}

export class AiCodeStatsUploader {
	constructor(private readonly store: AiCodeStatsStore) {}

	async upload(
		settings: AiCodeStatsUploadSettings,
		context: AiCodeStatsUploadContext,
	): Promise<AiCodeStatsUploadResult> {
		if (!settings.webhookUrl?.trim()) {
			return { uploaded: 0 }
		}

		const webhookUrl = resolveAiCodeStatsWebhookUrl(settings.webhookUrl)
		const maxEventsPerBatch = context.maxEventsPerBatch ?? DEFAULT_MAX_EVENTS_PER_BATCH
		const maxPayloadBytes = context.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES

		let uploaded = 0

		const pendingEvents = this.filterUploadableEvents(await this.store.getPendingEvents())
		if (pendingEvents.length > 0) {
			const batches = this.createBatches(pendingEvents, maxEventsPerBatch, maxPayloadBytes)
			for (const batch of batches) {
				await this.postEnvelope(webhookUrl, "incremental", batch, context.client)
				uploaded += batch.length
				await this.store.markEventsUploaded(batch.map((event) => event.eventId))
			}
		}

		return { uploaded }
	}

	async uploadRange(
		settings: AiCodeStatsUploadSettings,
		context: AiCodeStatsRangeUploadContext,
	): Promise<AiCodeStatsRangeUploadResult> {
		if (!settings.webhookUrl?.trim()) {
			return { uploaded: 0 }
		}

		const webhookUrl = resolveAiCodeStatsWebhookUrl(settings.webhookUrl)
		const maxEventsPerBatch = context.maxEventsPerBatch ?? DEFAULT_MAX_EVENTS_PER_BATCH
		const maxPayloadBytes = context.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES

		const events = await this.store.getEventsForRange(context.range)
		if (events.length === 0) {
			return { uploaded: 0 }
		}

		const uploadableEvents = this.filterUploadableEvents(events)
		const batches = this.createBatches(uploadableEvents, maxEventsPerBatch, maxPayloadBytes)

		let uploaded = 0
		for (const batch of batches) {
			await this.postEnvelope(webhookUrl, "backfill", batch, context.client)
			uploaded += batch.length
		}

		return { uploaded }
	}

	private filterUploadableEvents(events: AiCodeStatsEvent[]): AiCodeStatsEvent[] {
		return events.filter((event) => event.sourceType === "agent_insert")
	}

	private createBatches(
		events: AiCodeStatsEvent[],
		maxEventsPerBatch: number,
		maxPayloadBytes: number,
	): AiCodeStatsEvent[][] {
		if (events.length === 0) {
			return []
		}

		const batches: AiCodeStatsEvent[][] = []
		let currentBatch: AiCodeStatsEvent[] = []
		let currentBatchBytes = 0

		for (const event of events) {
			const eventBytes = Buffer.byteLength(JSON.stringify(event), "utf8")
			const wouldExceedEventCount = currentBatch.length >= maxEventsPerBatch
			const wouldExceedPayload = currentBatchBytes + eventBytes > maxPayloadBytes

			if (currentBatch.length > 0 && (wouldExceedEventCount || wouldExceedPayload)) {
				batches.push(currentBatch)
				currentBatch = []
				currentBatchBytes = 0
			}

			currentBatch.push(event)
			currentBatchBytes += eventBytes
		}

		if (currentBatch.length > 0) {
			batches.push(currentBatch)
		}

		return batches
	}

	private async postEnvelope(
		webhookUrl: string,
		mode: AiCodeUploadMode,
		events: AiCodeStatsEvent[],
		client: AiCodeStatsUploadClient,
	): Promise<void> {
		if (events.length === 0) {
			return
		}

		const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
		const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp)
		const fromTimestamp = sorted[0].timestamp
		const toTimestamp = sorted[sorted.length - 1].timestamp
		const generatedAt = Date.now()

		const payload: AiCodeStatsUploadEnvelope = {
			version: "v1",
			source: "kilocode-ai-code-stats",
			mode,
			client,
			window: {
				fromTimestamp,
				toTimestamp,
				timezone,
				generatedAt,
			},
			events: sorted.map((event) => ({
				...event,
				workspacePath: normalizePath(event.workspacePath),
				filePath: normalizePath(event.filePath),
				relativePath: normalizePath(event.relativePath),
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
				`AI code stats upload failed (${response.status} ${response.statusText})${
					errorBody ? `: ${errorBody.slice(0, 200)}` : ""
				}`,
			)
		}
	}
}
