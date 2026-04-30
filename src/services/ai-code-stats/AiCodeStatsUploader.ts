// kilocode_change - new file

import { gzip } from "zlib"
import { promisify } from "util"

import { fetchWithRetries } from "../../shared/http"
import { buildCompactCommitReportPayload } from "./AiCodeCompactCommitReport"
import { AiCodeStatsStore } from "./AiCodeStatsStore"
import { resolveAiCodeStatsWebhookUrl } from "./AiCodeStatsWebhookUrl"
import {
	CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
	normalizePath,
	normalizeUserEmail,
	type AiCodeStatsFailedReportUpload,
	type AiCodeStatsUploadClient,
	type AiCodeStatsUploadEnvelope,
	type AiCodeStatsUploadSettings,
} from "./types"

const gzipAsync = promisify(gzip)
const COMMIT_REPORT_UPLOAD_MIN_TIMEOUT_MS = 10 * 60 * 1000
const COMMIT_REPORT_UPLOAD_MAX_TIMEOUT_MS = 60 * 60 * 1000
const COMMIT_REPORT_UPLOAD_BYTES_PER_SECOND = 64 * 1024
const COMMIT_REPORT_GZIP_MIN_RAW_BYTES = 1024 * 1024

export interface AiCodeStatsUploadResult {
	uploaded: number
}

export interface AiCodeCommitReportUploadResult {
	uploadedReports: number
	uploadedBlocks: number
	failedReports: number
	failedReportErrors: AiCodeStatsFailedReportUpload[]
	rawPayloadBytes: number
	compressedPayloadBytes: number
	timeoutMs: number
}

export class AiCodeStatsUploader {
	constructor(private readonly store: AiCodeStatsStore) {}

	async upload(
		settings: AiCodeStatsUploadSettings,
		context: { client: AiCodeStatsUploadClient; maxEvents?: number },
	): Promise<AiCodeStatsUploadResult> {
		if (!settings.webhookUrl?.trim()) {
			return { uploaded: 0 }
		}
		const fallbackUserEmail = normalizeUserEmail(settings.userEmail)
		if (!fallbackUserEmail) {
			return { uploaded: 0 }
		}

		const events = await this.store.getPendingEvents(context.maxEvents)
		const uploadableEvents = events.filter(
			(event) => event.metricType === "generated" || event.metricType === "accepted",
		)
		if (uploadableEvents.length === 0) {
			return { uploaded: 0 }
		}

		const webhookUrl = resolveAiCodeStatsWebhookUrl(settings.webhookUrl)
		const generatedAt = Date.now()
		const timestamps = uploadableEvents.map((event) => event.timestamp)
		const payload: AiCodeStatsUploadEnvelope = {
			version: "v1",
			source: "kilocode-ai-code-stats",
			mode: "incremental",
			semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
			client: context.client,
			window: {
				fromTimestamp: Math.min(...timestamps),
				toTimestamp: Math.max(...timestamps),
				timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
				generatedAt,
			},
			events: uploadableEvents.map((event) => ({
				...event,
				semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
				sourceType: "agent_insert",
				metricType: event.metricType,
				userEmail: normalizeUserEmail(event.userEmail) ?? fallbackUserEmail,
				repoRoot: event.repoRoot ? normalizePath(event.repoRoot) : undefined,
				repoRelativePath: event.repoRelativePath ? normalizePath(event.repoRelativePath) : undefined,
				filePath: normalizePath(event.filePath),
				relativePath: normalizePath(event.relativePath),
			})),
		}

		await this.postJson(webhookUrl, payload, "AI code stats upload failed")
		await this.store.markEventsUploaded(uploadableEvents.map((event) => event.eventId))
		return { uploaded: uploadableEvents.length }
	}

	async uploadQueuedReports(settings: AiCodeStatsUploadSettings): Promise<AiCodeCommitReportUploadResult> {
		if (!settings.webhookUrl?.trim()) {
			return this.emptyCommitReportUploadResult()
		}
		const fallbackUserEmail = normalizeUserEmail(settings.userEmail)
		if (!fallbackUserEmail) {
			return this.emptyCommitReportUploadResult()
		}

		const webhookUrl = resolveAiCodeStatsWebhookUrl(settings.webhookUrl)
		const reports = await this.store.getQueuedCommitReports()
		let uploadedReports = 0
		let uploadedBlocks = 0
		let rawPayloadBytes = 0
		let compressedPayloadBytes = 0
		let timeoutMs = 0
		const failedReportErrors: AiCodeStatsFailedReportUpload[] = []

		for (const queued of reports) {
			const payload = buildCompactCommitReportPayload(queued.report, fallbackUserEmail)
			const prepared = await this.prepareJsonPayload(payload)
			rawPayloadBytes += prepared.rawPayloadBytes
			compressedPayloadBytes += prepared.compressedPayloadBytes
			timeoutMs = Math.max(timeoutMs, prepared.timeoutMs)
			try {
				await this.postPreparedJson(
					webhookUrl,
					prepared,
					{
						reportId: queued.report.reportId,
						commitHash: queued.report.commitHash,
					},
					"AI code commit report upload failed",
				)
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				failedReportErrors.push({
					reportId: queued.report.reportId,
					commitHash: queued.report.commitHash,
					rawPayloadBytes: prepared.rawPayloadBytes,
					compressedPayloadBytes: prepared.compressedPayloadBytes,
					encoding: prepared.contentEncoding,
					timeoutMs: prepared.timeoutMs,
					message,
				})
				continue
			}
			await this.store.acknowledgeQueuedCommitReport(queued.report.reportId)
			uploadedReports += 1
			const baselineBlockCount =
				queued.report.acceptedBlocks && queued.report.acceptedBlocks.length > 0
					? queued.report.acceptedBlocks.length
					: (queued.report.generatedBlocks?.length ?? 0)
			uploadedBlocks += baselineBlockCount
		}

		return {
			uploadedReports,
			uploadedBlocks,
			failedReports: failedReportErrors.length,
			failedReportErrors,
			rawPayloadBytes,
			compressedPayloadBytes,
			timeoutMs,
		}
	}

	private emptyCommitReportUploadResult(): AiCodeCommitReportUploadResult {
		return {
			uploadedReports: 0,
			uploadedBlocks: 0,
			failedReports: 0,
			failedReportErrors: [],
			rawPayloadBytes: 0,
			compressedPayloadBytes: 0,
			timeoutMs: 0,
		}
	}

	private async postJson(webhookUrl: string, payload: unknown, errorPrefix: string): Promise<void> {
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
				`${errorPrefix} (${response.status} ${response.statusText})${
					errorBody ? `: ${errorBody.slice(0, 200)}` : ""
				}`,
			)
		}
	}

	private async prepareJsonPayload(payload: unknown): Promise<{
		body: string | Uint8Array
		contentEncoding: "gzip" | "identity"
		rawPayloadBytes: number
		compressedPayloadBytes: number
		timeoutMs: number
	}> {
		const rawJson = JSON.stringify(payload)
		const raw = Buffer.from(rawJson, "utf8")
		if (raw.byteLength < COMMIT_REPORT_GZIP_MIN_RAW_BYTES) {
			return {
				body: rawJson,
				contentEncoding: "identity",
				rawPayloadBytes: raw.byteLength,
				compressedPayloadBytes: raw.byteLength,
				timeoutMs: this.computeCommitReportUploadTimeout(raw.byteLength),
			}
		}
		const compressed = await gzipAsync(raw)
		const timeoutMs = this.computeCommitReportUploadTimeout(compressed.byteLength)
		return {
			body: new Uint8Array(compressed),
			contentEncoding: "gzip",
			rawPayloadBytes: raw.byteLength,
			compressedPayloadBytes: compressed.byteLength,
			timeoutMs,
		}
	}

	private async postPreparedJson(
		webhookUrl: string,
		prepared: {
			body: string | Uint8Array
			contentEncoding: "gzip" | "identity"
			rawPayloadBytes: number
			compressedPayloadBytes: number
			timeoutMs: number
		},
		reportIdentity: {
			reportId: string
			commitHash: string
		},
		errorPrefix: string,
	): Promise<void> {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			"X-Ai-Code-Stats-Wire-Version": "v3",
			"X-Ai-Code-Stats-Raw-Bytes": String(prepared.rawPayloadBytes),
			"X-Ai-Code-Stats-Wire-Bytes": String(prepared.compressedPayloadBytes),
			"X-Ai-Code-Stats-Report-Id": reportIdentity.reportId,
			"X-Ai-Code-Stats-Commit-Hash": reportIdentity.commitHash,
		}
		if (prepared.contentEncoding === "gzip") {
			headers["Content-Encoding"] = "gzip"
			headers["X-Ai-Code-Stats-Gzip-Bytes"] = String(prepared.compressedPayloadBytes)
		}
		const response = await fetchWithRetries({
			url: webhookUrl,
			method: "POST",
			headers,
			body: prepared.body,
			retries: 3,
			timeout: prepared.timeoutMs,
			shouldRetry: (res) => res.status >= 500 || res.status === 429,
		})

		if (!response.ok) {
			const errorBody = await response.text().catch(() => "")
			throw new Error(
				`${errorPrefix} (${response.status} ${response.statusText})${
					errorBody ? `: ${errorBody.slice(0, 200)}` : ""
				}`,
			)
		}
	}

	private computeCommitReportUploadTimeout(compressedPayloadBytes: number): number {
		const sizeBasedTimeout =
			Math.ceil(compressedPayloadBytes / COMMIT_REPORT_UPLOAD_BYTES_PER_SECOND) * 1000 + 60 * 1000
		return Math.min(
			COMMIT_REPORT_UPLOAD_MAX_TIMEOUT_MS,
			Math.max(COMMIT_REPORT_UPLOAD_MIN_TIMEOUT_MS, sizeBasedTimeout),
		)
	}
}
