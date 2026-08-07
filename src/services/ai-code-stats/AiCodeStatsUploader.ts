// kilocode_change - new file

import { gzip } from "zlib"
import { createHash } from "crypto"
import { promisify } from "util"

import { fetchWithRetries } from "../../shared/http"
import {
	buildCompactCommitReportPayload,
	type AiCodeCompactBlockPayload,
	type AiCodeCompactCommitReport,
	type AiCodeCompactCandidateLinePayload,
	type AiCodeCompactChangedFilePayload,
} from "./AiCodeCompactCommitReport"
import { AiCodeStatsStore } from "./AiCodeStatsStore"
import { buildUploadFailureDiagnostics, summarizeUploadTarget } from "./AiCodeStatsUploadDiagnostics"
import { resolveAiCodeStatsCommitStatusUrl, resolveAiCodeStatsWebhookUrl } from "./AiCodeStatsWebhookUrl"
import {
	CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
	buildRepoCommitKey,
	normalizePath,
	normalizeUserEmail,
	type AiCodeCommitLifecycleReport,
	type AiCodeCommitServerStatus,
	type AiCodeStatsEventBlockCategory,
	type AiCodeStatsEventUploadBlock,
	type AiCodeStatsFailedReportUpload,
	type AiCodeStatsUploadClient,
	type AiCodeStatsUploadEnvelope,
	type AiCodeStatsUploadSettings,
} from "./types"

const gzipAsync = promisify(gzip)
const COMMIT_REPORT_UPLOAD_MIN_TIMEOUT_MS = 30 * 1000
const COMMIT_REPORT_UPLOAD_MAX_TIMEOUT_MS = 60 * 60 * 1000
const COMMIT_REPORT_UPLOAD_BYTES_PER_SECOND = 64 * 1024
const COMMIT_REPORT_UPLOAD_BASE_TIMEOUT_MS = 15 * 1000
const COMMIT_REPORT_GZIP_MIN_RAW_BYTES = 1024 * 1024
const COMMIT_REPORT_MAX_WIRE_BYTES = 128 * 1024 * 1024
const COMMIT_REPORT_MAX_RAW_BYTES = 256 * 1024 * 1024
const COMMIT_REPORT_MAX_FILE_PATH_CHARS = 1024
const COMMIT_REPORT_MAX_RELATIVE_PATH_CHARS = 512
const COMMIT_LIFECYCLE_MAX_BRANCH_CHARS = 255
const COMMIT_LIFECYCLE_MAX_HASHES_PER_SIDE = 32_768
const GENERAL_TEXT_MAX_CHARS = 255
const PATH_MAX_CHARS = 4096
const INCREMENTAL_MAX_EVENTS_PER_ENVELOPE = 1000
const INCREMENTAL_MAX_CODE_SNIPPET_BYTES = 8 * 1024 * 1024
const INCREMENTAL_MAX_FILE_SNAPSHOT_BYTES = 32 * 1024 * 1024
const INCREMENTAL_MAX_EVENT_TEXT_BYTES = 64 * 1024 * 1024
const JAVA_INTEGER_MAX = 2_147_483_647
const MIN_DATABASE_TIMESTAMP_MILLIS = Date.parse("1000-01-02T00:00:00.000Z")
const MAX_DATABASE_TIMESTAMP_MILLIS = Date.parse("9999-12-30T23:59:59.999Z")
// Keep four MiB below the aggregate server text limit. Measuring the complete
// serialized envelope also covers JSON keys, escaping, client and window data.
const INCREMENTAL_MAX_ENVELOPE_BYTES = 60 * 1024 * 1024
const GLOBAL_UPLOAD_FAILURE_CATEGORIES = new Set([
	"server_unreachable",
	"timeout",
	"rate_limited",
	"auth_error",
	"server_error",
])

interface IngestAcknowledgementExpectation {
	kind: "envelope" | "commit_report" | "commit_lifecycle"
	reportId?: string
	itemCount?: number
	payloadSha256: string
}

interface AiCodeStatsUploadContext {
	client: AiCodeStatsUploadClient
	maxEvents?: number
	maxEnvelopeBytes?: number
}

export interface AiCodeCommitReportUploadOptions {
	reportId?: string
	maxReports?: number
	deadlineAt?: number
	requestRetries?: number
	stopOnGlobalFailure?: boolean
}

export interface AiCodeCommitLifecycleUploadOptions {
	blockedRepoCommitKeys?: Set<string>
	eventId?: string
	maxReports?: number
	deadlineAt?: number
	requestRetries?: number
	stopOnGlobalFailure?: boolean
}

export interface AiCodeStatsUploadResult {
	uploaded: number
	blockedEvents?: AiCodeStatsEventUploadBlock[]
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

export interface AiCodeCommitLifecycleUploadResult {
	uploadedReports: number
	failedReports: number
	failedReportErrors: AiCodeStatsFailedReportUpload[]
	rawPayloadBytes: number
	compressedPayloadBytes: number
	timeoutMs: number
}

export interface AiCodeCommitServerStatusQuery {
	userEmail?: string
	client: AiCodeStatsUploadClient
	commits: Array<{
		commitHash: string
		reportId?: string
		gitRemoteUrl?: string
		gitBranch?: string
	}>
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
		const persistedBlockedByEventId = new Map(
			(await this.store.getBlockedEvents()).map((block) => [block.eventId, block]),
		)
		const fallbackUserEmail = normalizeUserEmail(settings.userEmail)
		const generatedAt = Date.now()
		const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
		const maxEvents = Math.min(
			INCREMENTAL_MAX_EVENTS_PER_ENVELOPE,
			Math.max(1, Math.floor(context.maxEvents ?? INCREMENTAL_MAX_EVENTS_PER_ENVELOPE)),
		)
		const maxEnvelopeBytes = Math.min(
			INCREMENTAL_MAX_ENVELOPE_BYTES,
			Math.max(1, Math.floor(context.maxEnvelopeBytes ?? INCREMENTAL_MAX_ENVELOPE_BYTES)),
		)
		const normalizedByEventId = new Map<string, AiCodeStatsUploadEnvelope["events"][number]>()
		const blockObservations = new Map<
			string,
			{
				eventId: string
				block?: {
					category: AiCodeStatsEventBlockCategory
					reason: string
					retryable: boolean
				}
			}
		>()
		const events = await this.store.getPendingEvents(maxEvents, (event) => {
			if (event.metricType !== "generated" && event.metricType !== "accepted") {
				return false
			}
			const persistedBlock = persistedBlockedByEventId.get(event.eventId)
			if (persistedBlock && !persistedBlock.retryable) {
				blockObservations.set(event.eventId, {
					eventId: event.eventId,
					block: {
						category: persistedBlock.category,
						reason: persistedBlock.reason,
						retryable: false,
					},
				})
				return false
			}
			const persistedUserEmail = normalizeUserEmail(event.userEmail)
			const validPersistedUserEmail =
				persistedUserEmail && this.isValidEmail(persistedUserEmail) ? persistedUserEmail : undefined
			if (persistedUserEmail && !validPersistedUserEmail) {
				blockObservations.set(event.eventId, {
					eventId: event.eventId,
					block: {
						category: "invalid_identity",
						reason: "incremental event has a non-empty invalid persisted userEmail",
						retryable: false,
					},
				})
				return false
			}
			const validFallbackUserEmail =
				fallbackUserEmail && this.isValidEmail(fallbackUserEmail) ? fallbackUserEmail : undefined
			const userEmail = validPersistedUserEmail ?? validFallbackUserEmail
			if (!userEmail) {
				blockObservations.set(event.eventId, {
					eventId: event.eventId,
					block: {
						category: "missing_identity",
						reason: "incremental event has no userEmail and no valid configured fallback",
						retryable: true,
					},
				})
				return false
			}
			const normalized = this.normalizeIncrementalEvent(event, userEmail)
			const validationError = this.incrementalEventValidationError(normalized)
			if (validationError) {
				blockObservations.set(event.eventId, {
					eventId: event.eventId,
					block: {
						category: "invalid_local_payload",
						reason: validationError,
						retryable: false,
					},
				})
				return false
			}
			const singleEventPayload = this.buildIncrementalEnvelope(
				[normalized],
				context.client,
				generatedAt,
				timezone,
			)
			if (this.jsonByteLength(singleEventPayload) > maxEnvelopeBytes) {
				blockObservations.set(event.eventId, {
					eventId: event.eventId,
					block: {
						category: "payload_too_large",
						reason: `single incremental event envelope exceeds the ${maxEnvelopeBytes}-byte request limit`,
						retryable: maxEnvelopeBytes < INCREMENTAL_MAX_ENVELOPE_BYTES,
					},
				})
				return false
			}
			blockObservations.set(event.eventId, { eventId: event.eventId })
			normalizedByEventId.set(event.eventId, normalized)
			return true
		})
		const blockedEvents = await this.store.reconcileEventUploadBlocks([...blockObservations.values()])
		const candidates = events.flatMap((event) => {
			const normalized = normalizedByEventId.get(event.eventId)
			return normalized ? [normalized] : []
		})
		const uploadableEvents: AiCodeStatsUploadEnvelope["events"] = []
		let aggregateTextBytes = 0
		let serializedEventBytes = 0
		let fromTimestamp: number | undefined
		let toTimestamp: number | undefined
		for (const event of candidates) {
			const eventTextBytes = this.incrementalEventTextBytes(event)
			const nextTextBytes = aggregateTextBytes + eventTextBytes
			if (nextTextBytes > INCREMENTAL_MAX_EVENT_TEXT_BYTES) {
				break
			}
			const nextFromTimestamp = Math.min(fromTimestamp ?? event.timestamp, event.timestamp)
			const nextToTimestamp = Math.max(toTimestamp ?? event.timestamp, event.timestamp)
			const emptyCandidatePayload = this.buildIncrementalEnvelopeForWindow(
				[],
				context.client,
				generatedAt,
				timezone,
				nextFromTimestamp,
				nextToTimestamp,
			)
			const nextSerializedEventBytes = serializedEventBytes + Buffer.byteLength(JSON.stringify(event), "utf8")
			const arrayCommaBytes = uploadableEvents.length
			const candidateEnvelopeBytes =
				this.jsonByteLength(emptyCandidatePayload) + nextSerializedEventBytes + arrayCommaBytes
			if (candidateEnvelopeBytes > maxEnvelopeBytes) {
				break
			}
			uploadableEvents.push(event)
			aggregateTextBytes = nextTextBytes
			serializedEventBytes = nextSerializedEventBytes
			fromTimestamp = nextFromTimestamp
			toTimestamp = nextToTimestamp
		}
		if (uploadableEvents.length === 0) {
			return this.incrementalUploadResult(0, blockedEvents)
		}

		const webhookUrl = resolveAiCodeStatsWebhookUrl(settings.webhookUrl)
		const payload = this.buildIncrementalEnvelope(uploadableEvents, context.client, generatedAt, timezone)

		await this.postJson(webhookUrl, payload, "AI code stats upload failed", {
			kind: "envelope",
			itemCount: uploadableEvents.length,
		})
		await this.store.markEventsUploaded(uploadableEvents.map((event) => event.eventId))
		return this.incrementalUploadResult(uploadableEvents.length, blockedEvents)
	}

	async uploadQueuedReports(
		settings: AiCodeStatsUploadSettings,
		options: AiCodeCommitReportUploadOptions = {},
	): Promise<AiCodeCommitReportUploadResult> {
		if (!settings.webhookUrl?.trim()) {
			return this.emptyCommitReportUploadResult()
		}
		const fallbackUserEmail = normalizeUserEmail(settings.userEmail)

		const webhookUrl = resolveAiCodeStatsWebhookUrl(settings.webhookUrl)
		const matchingReports = (await this.store.getQueuedCommitReports()).filter(
			(queued) => !options.reportId || queued.report.reportId === options.reportId,
		)
		const orderedReports = options.reportId
			? matchingReports
			: await this.orderCommitReportsByOldestAttempt(matchingReports)
		const maxReports = this.normalizeMaxReports(options.maxReports)
		const reports = orderedReports.slice(0, maxReports)
		let uploadedReports = 0
		let uploadedBlocks = 0
		let rawPayloadBytes = 0
		let compressedPayloadBytes = 0
		let timeoutMs = 0
		const failedReportErrors: AiCodeStatsFailedReportUpload[] = []

		for (const queued of reports) {
			if (this.hasUploadDeadlineExpired(options.deadlineAt)) {
				break
			}
			const reportUserEmail = this.resolveCommitReportUserEmail(queued.report, fallbackUserEmail)
			if (!reportUserEmail) {
				failedReportErrors.push({
					reportId: queued.report.reportId,
					commitHash: queued.report.commitHash,
					rawPayloadBytes: 0,
					compressedPayloadBytes: 0,
					encoding: "identity",
					timeoutMs: 0,
					message: "AI code commit report has no persisted user email",
				})
				continue
			}
			let payload: AiCodeCompactCommitReport
			try {
				this.assertCommitReportTimestampsWithinServerLimits(queued.report)
				payload = buildCompactCommitReportPayload(queued.report, reportUserEmail)
				this.assertCommitReportPayloadWithinServerLimits(payload)
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				failedReportErrors.push({
					reportId: queued.report.reportId,
					commitHash: queued.report.commitHash,
					rawPayloadBytes: 0,
					compressedPayloadBytes: 0,
					encoding: "identity",
					timeoutMs: 0,
					message,
					errorCategory: "invalid_local_payload",
					userMessage:
						"本地保留的 commit 上报事实不符合当前服务端协议，已停止自动重试；请导出诊断并联系管理员处理。",
					...summarizeUploadTarget(webhookUrl),
				})
				continue
			}
			const prepared = await this.prepareJsonPayload(payload)
			const requestTimeoutMs = this.resolveRequestTimeout(prepared.timeoutMs, options.deadlineAt)
			if (requestTimeoutMs === undefined) {
				break
			}
			rawPayloadBytes += prepared.rawPayloadBytes
			compressedPayloadBytes += prepared.compressedPayloadBytes
			timeoutMs = Math.max(timeoutMs, requestTimeoutMs)
			try {
				this.assertPreparedPayloadWithinServerLimits(prepared)
				await this.postPreparedJson(
					webhookUrl,
					prepared,
					{
						reportId: queued.report.reportId,
						commitHash: queued.report.commitHash,
						itemCount: (payload.generatedBlocks?.length ?? 0) + (payload.acceptedBlocks?.length ?? 0),
					},
					"AI code commit report upload failed",
					"commit_report",
					{
						timeoutMs: requestTimeoutMs,
						retries: this.normalizeRequestRetries(options.requestRetries),
					},
				)
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				const diagnostics = buildUploadFailureDiagnostics(message, webhookUrl)
				failedReportErrors.push({
					reportId: queued.report.reportId,
					commitHash: queued.report.commitHash,
					rawPayloadBytes: prepared.rawPayloadBytes,
					compressedPayloadBytes: prepared.compressedPayloadBytes,
					encoding: prepared.contentEncoding,
					timeoutMs: requestTimeoutMs,
					message,
					...diagnostics,
				})
				if (
					options.stopOnGlobalFailure !== false &&
					GLOBAL_UPLOAD_FAILURE_CATEGORIES.has(diagnostics.errorCategory)
				) {
					break
				}
				continue
			}
			await this.store.acknowledgeQueuedCommitReport(queued.report.reportId)
			await this.appendSuccessDiagnosticBestEffort({
				type: "upload_succeeded",
				commitHash: queued.report.commitHash,
				reportId: queued.report.reportId,
				repoRoot: queued.report.repoRoot,
				status: "uploaded",
				details: {
					rawPayloadBytes: prepared.rawPayloadBytes,
					compressedPayloadBytes: prepared.compressedPayloadBytes,
					timeoutMs: requestTimeoutMs,
					encoding: prepared.contentEncoding,
					...summarizeUploadTarget(webhookUrl),
				},
			})
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

	async uploadQueuedLifecycleReports(
		settings: AiCodeStatsUploadSettings,
		options: AiCodeCommitLifecycleUploadOptions = {},
	): Promise<AiCodeCommitLifecycleUploadResult> {
		if (!settings.webhookUrl?.trim()) {
			return this.emptyCommitLifecycleUploadResult()
		}

		const webhookUrl = resolveAiCodeStatsWebhookUrl(settings.webhookUrl)
		const reports = (await this.store.getQueuedCommitLifecycleReports())
			.filter((queued) => !options.eventId || queued.report.eventId === options.eventId)
			.filter((queued) => options.eventId || !queued.blockedReason)
			.filter((queued) => !this.lifecycleTouchesBlockedCommit(queued.report, options.blockedRepoCommitKeys))
			.slice(0, this.normalizeMaxReports(options.maxReports))
		let uploadedReports = 0
		let rawPayloadBytes = 0
		let compressedPayloadBytes = 0
		let timeoutMs = 0
		const failedReportErrors: AiCodeStatsFailedReportUpload[] = []

		for (const queued of reports) {
			if (this.hasUploadDeadlineExpired(options.deadlineAt)) {
				break
			}
			try {
				this.assertLifecyclePayloadWithinServerLimits(queued.report)
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				await this.store.markQueuedCommitLifecycleReportBlocked(queued.report.eventId, message)
				failedReportErrors.push({
					reportId: queued.report.reportId,
					commitHash: this.lifecycleReportCommitHash(queued.report),
					rawPayloadBytes: 0,
					compressedPayloadBytes: 0,
					encoding: "identity",
					timeoutMs: 0,
					message,
					errorCategory: "invalid_local_payload",
					userMessage:
						"本地保留的生命周期事实不符合当前服务端协议，已停止自动重试；请导出诊断并联系管理员处理。",
					...summarizeUploadTarget(webhookUrl),
				})
				continue
			}
			const payload = this.normalizeLifecyclePayloadForUpload(queued.report)
			const prepared = await this.prepareJsonPayload(payload)
			const requestTimeoutMs = this.resolveRequestTimeout(prepared.timeoutMs, options.deadlineAt)
			if (requestTimeoutMs === undefined) {
				break
			}
			rawPayloadBytes += prepared.rawPayloadBytes
			compressedPayloadBytes += prepared.compressedPayloadBytes
			timeoutMs = Math.max(timeoutMs, requestTimeoutMs)
			const commitHash = this.lifecycleReportCommitHash(payload)
			try {
				this.assertPreparedPayloadWithinServerLimits(prepared)
				await this.postPreparedJson(
					webhookUrl,
					prepared,
					{
						reportId: payload.reportId,
						commitHash,
						itemCount: 1,
					},
					"AI code commit lifecycle upload failed",
					"commit_lifecycle",
					{
						timeoutMs: requestTimeoutMs,
						retries: this.normalizeRequestRetries(options.requestRetries),
					},
				)
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				const diagnostics = buildUploadFailureDiagnostics(message, webhookUrl)
				failedReportErrors.push({
					reportId: payload.reportId,
					commitHash,
					rawPayloadBytes: prepared.rawPayloadBytes,
					compressedPayloadBytes: prepared.compressedPayloadBytes,
					encoding: prepared.contentEncoding,
					timeoutMs: requestTimeoutMs,
					message,
					...diagnostics,
				})
				if (
					options.stopOnGlobalFailure !== false &&
					GLOBAL_UPLOAD_FAILURE_CATEGORIES.has(diagnostics.errorCategory)
				) {
					break
				}
				continue
			}
			await this.store.acknowledgeQueuedCommitLifecycleReport(payload.eventId)
			await this.appendSuccessDiagnosticBestEffort({
				type: "lifecycle_upload_succeeded",
				commitHash,
				reportId: payload.reportId,
				repoRoot: payload.repoRoot,
				status: "uploaded",
				details: {
					eventId: payload.eventId,
					eventType: payload.eventType,
					reason: payload.reason,
					confidence: payload.confidence,
					rawPayloadBytes: prepared.rawPayloadBytes,
					compressedPayloadBytes: prepared.compressedPayloadBytes,
					timeoutMs: requestTimeoutMs,
					encoding: prepared.contentEncoding,
					...summarizeUploadTarget(webhookUrl),
				},
			})
			uploadedReports += 1
		}

		return {
			uploadedReports,
			failedReports: failedReportErrors.length,
			failedReportErrors,
			rawPayloadBytes,
			compressedPayloadBytes,
			timeoutMs,
		}
	}

	private async appendSuccessDiagnosticBestEffort(
		event: Parameters<AiCodeStatsStore["appendDiagnosticEvent"]>[0],
	): Promise<void> {
		try {
			await this.store.appendDiagnosticEvent(event)
		} catch (error) {
			// The server acknowledgement and durable outbox removal have already
			// committed. A diagnostics-only write must not turn that successful
			// delivery into a false upload failure or cause an unnecessary retry.
			console.warn("[AiCodeStats] Failed to persist upload success diagnostics:", error)
		}
	}

	async queryCommitStatuses(
		settings: AiCodeStatsUploadSettings,
		query: AiCodeCommitServerStatusQuery,
	): Promise<AiCodeCommitServerStatus[]> {
		if (!settings.webhookUrl?.trim() || query.commits.length === 0) {
			return []
		}
		const fallbackUserEmail = normalizeUserEmail(settings.userEmail)
		const response = await fetchWithRetries({
			url: resolveAiCodeStatsCommitStatusUrl(settings.webhookUrl),
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				client: query.client,
				userEmail: normalizeUserEmail(query.userEmail) ?? fallbackUserEmail,
				commits: query.commits,
			}),
			shouldRetry: (res) => res.status >= 500 || res.status === 429,
		})
		if (!response.ok) {
			const errorBody = await response.text().catch(() => "")
			throw new Error(
				`AI code commit status query failed (${response.status} ${response.statusText})${
					errorBody ? `: ${errorBody.slice(0, 200)}` : ""
				}`,
			)
		}
		const responseBody = await response.text().catch(() => "")
		let payload: unknown
		try {
			payload = JSON.parse(responseBody)
		} catch {
			throw new Error("AI code commit status query returned invalid JSON")
		}
		if (
			typeof payload !== "object" ||
			payload === null ||
			!Array.isArray((payload as { statuses?: unknown }).statuses)
		) {
			throw new Error("AI code commit status query returned an invalid response")
		}
		const statuses = (payload as { statuses: unknown[] }).statuses
		const validStatuses = new Set(["NOT_RECEIVED", "RECEIVED", "ATTRIBUTED", "PROCESSING", "ATTRIBUTION_FAILED"])
		if (
			statuses.some(
				(status) =>
					typeof status !== "object" ||
					status === null ||
					typeof (status as { commitHash?: unknown }).commitHash !== "string" ||
					!validStatuses.has(String((status as { status?: unknown }).status)),
			)
		) {
			throw new Error("AI code commit status query returned an invalid status item")
		}
		return statuses as AiCodeCommitServerStatus[]
	}

	private normalizeIncrementalEvent(
		event: AiCodeStatsUploadEnvelope["events"][number],
		userEmail: string,
	): AiCodeStatsUploadEnvelope["events"][number] {
		return {
			...event,
			semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
			sourceType: "agent_insert",
			metricType: event.metricType,
			userEmail,
			repoRoot: event.repoRoot ? normalizePath(event.repoRoot) : undefined,
			repoRelativePath: event.repoRelativePath ? normalizePath(event.repoRelativePath) : undefined,
			filePath: normalizePath(event.filePath),
			relativePath: normalizePath(event.relativePath),
		}
	}

	private incrementalEventValidationError(event: AiCodeStatsUploadEnvelope["events"][number]): string | undefined {
		if (
			!event.eventId?.trim() ||
			!this.isDatabaseSafeTimestamp(event.timestamp) ||
			!event.ide?.trim() ||
			!this.isValidEmail(event.userEmail) ||
			!event.filePath?.trim() ||
			!event.relativePath?.trim() ||
			(!event.projectKey?.trim() && !event.gitRemoteUrl?.trim() && !event.repoRoot?.trim()) ||
			!Number.isInteger(event.lineStart) ||
			event.lineStart < 1 ||
			event.lineStart > JAVA_INTEGER_MAX ||
			!Number.isInteger(event.lineEnd) ||
			event.lineEnd < event.lineStart ||
			event.lineEnd > JAVA_INTEGER_MAX ||
			!Number.isInteger(event.lineCount) ||
			event.lineCount < 1 ||
			event.lineCount > JAVA_INTEGER_MAX ||
			(event.commitOccurredAt !== undefined && !this.isDatabaseSafeTimestamp(event.commitOccurredAt)) ||
			typeof event.codeSnippet !== "string"
		) {
			return "incremental event has invalid required fields, timestamps, identity, project, or line ranges"
		}

		const boundedFields: Array<[keyof typeof event | "userId" | "matchStrategy", number]> = [
			["eventId", 128],
			["sourceType", 32],
			["ide", 32],
			["metricType", 32],
			["changeType", 32],
			["userId", 128],
			["userName", 255],
			["departmentName", 255],
			["officeName", 255],
			["teamName", 255],
			["userEmail", 255],
			["organizationId", 128],
			["organizationName", 255],
			["sourceIp", 64],
			["provider", 128],
			["model", 255],
			["projectKey", 64],
			["projectName", 255],
			["repoRoot", 4096],
			["repoRelativePath", 4096],
			["filePath", 4096],
			["relativePath", 4096],
			["language", 64],
			["gitRemoteUrl", 4096],
			["gitBranch", 255],
			["fileSnapshotHash", 64],
			["taskId", 128],
			["commitHash", 128],
			["matchStrategy", 32],
			["generatedBlockId", 128],
		]
		const record = event as unknown as Record<string, unknown>
		const overlongField = boundedFields.find(([field, maxChars]) => {
			const value = record[field]
			return typeof value === "string" && value.length > maxChars
		})
		if (overlongField) {
			return `incremental event field ${String(overlongField[0])} exceeds ${overlongField[1]} characters`
		}

		if (Buffer.byteLength(event.codeSnippet, "utf8") > INCREMENTAL_MAX_CODE_SNIPPET_BYTES) {
			return `incremental event codeSnippet exceeds ${INCREMENTAL_MAX_CODE_SNIPPET_BYTES} bytes`
		}
		if (
			event.fileSnapshotContent !== undefined &&
			Buffer.byteLength(event.fileSnapshotContent, "utf8") > INCREMENTAL_MAX_FILE_SNAPSHOT_BYTES
		) {
			return `incremental event fileSnapshotContent exceeds ${INCREMENTAL_MAX_FILE_SNAPSHOT_BYTES} bytes`
		}
		if (this.incrementalEventTextBytes(event) > INCREMENTAL_MAX_EVENT_TEXT_BYTES) {
			return `incremental event text exceeds ${INCREMENTAL_MAX_EVENT_TEXT_BYTES} bytes`
		}
		return undefined
	}

	private incrementalUploadResult(
		uploaded: number,
		blockedEvents: AiCodeStatsEventUploadBlock[],
	): AiCodeStatsUploadResult {
		return blockedEvents.length > 0 ? { uploaded, blockedEvents } : { uploaded }
	}

	private isDatabaseSafeTimestamp(value: unknown): value is number {
		return (
			Number.isSafeInteger(value) &&
			(value as number) >= MIN_DATABASE_TIMESTAMP_MILLIS &&
			(value as number) <= MAX_DATABASE_TIMESTAMP_MILLIS
		)
	}

	private isValidEmail(value?: string): boolean {
		if (!value || value.includes(" ")) {
			return false
		}
		const at = value.indexOf("@")
		const dot = value.lastIndexOf(".")
		return at > 0 && dot > at + 1 && dot < value.length - 1
	}

	private incrementalEventTextBytes(event: AiCodeStatsUploadEnvelope["events"][number]): number {
		const record = event as unknown as Record<string, unknown>
		const textFields = [
			"eventId",
			"sourceType",
			"ide",
			"metricType",
			"changeType",
			"userId",
			"userName",
			"departmentName",
			"officeName",
			"teamName",
			"userEmail",
			"organizationId",
			"organizationName",
			"sourceIp",
			"provider",
			"model",
			"projectKey",
			"projectName",
			"repoRoot",
			"repoRelativePath",
			"filePath",
			"relativePath",
			"language",
			"gitRemoteUrl",
			"gitBranch",
			"fileSnapshotHash",
			"taskId",
			"commitHash",
			"matchStrategy",
			"generatedBlockId",
			"codeSnippet",
			"fileSnapshotContent",
		]
		return textFields.reduce((total, field) => {
			const value = record[field]
			return total + (typeof value === "string" ? Buffer.byteLength(value, "utf8") : 0)
		}, 0)
	}

	private buildIncrementalEnvelope(
		events: AiCodeStatsUploadEnvelope["events"],
		client: AiCodeStatsUploadClient,
		generatedAt: number,
		timezone: string,
	): AiCodeStatsUploadEnvelope {
		const timestamps = events.map((event) => event.timestamp)
		return this.buildIncrementalEnvelopeForWindow(
			events,
			client,
			generatedAt,
			timezone,
			Math.min(...timestamps),
			Math.max(...timestamps),
		)
	}

	private buildIncrementalEnvelopeForWindow(
		events: AiCodeStatsUploadEnvelope["events"],
		client: AiCodeStatsUploadClient,
		generatedAt: number,
		timezone: string,
		fromTimestamp: number,
		toTimestamp: number,
	): AiCodeStatsUploadEnvelope {
		return {
			version: "v1",
			source: "kilocode-ai-code-stats",
			mode: "incremental",
			semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
			client,
			window: {
				fromTimestamp,
				toTimestamp,
				timezone,
				generatedAt,
			},
			events,
		}
	}

	private jsonByteLength(payload: unknown): number {
		return Buffer.byteLength(JSON.stringify(payload), "utf8")
	}

	private resolveCommitReportUserEmail(
		report: Parameters<typeof buildCompactCommitReportPayload>[0],
		fallbackUserEmail?: string,
	): string | undefined {
		return (
			normalizeUserEmail(
				report.acceptedBlocks?.find((block) => normalizeUserEmail(block.userEmail))?.userEmail,
			) ??
			normalizeUserEmail(
				report.generatedBlocks?.find((block) => normalizeUserEmail(block.userEmail))?.userEmail,
			) ??
			normalizeUserEmail(report.candidateLines?.find((line) => normalizeUserEmail(line.userEmail))?.userEmail) ??
			fallbackUserEmail
		)
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

	private emptyCommitLifecycleUploadResult(): AiCodeCommitLifecycleUploadResult {
		return {
			uploadedReports: 0,
			failedReports: 0,
			failedReportErrors: [],
			rawPayloadBytes: 0,
			compressedPayloadBytes: 0,
			timeoutMs: 0,
		}
	}

	private normalizeLifecyclePayloadForUpload(report: AiCodeCommitLifecycleReport): AiCodeCommitLifecycleReport {
		return {
			...report,
			repoRoot: normalizePath(report.repoRoot),
			commitHashes: report.commitHashes ? [...new Set(report.commitHashes.filter(Boolean))] : undefined,
			replacementCommitHashes: report.replacementCommitHashes
				? [...new Set(report.replacementCommitHashes.filter(Boolean))]
				: undefined,
		}
	}

	private lifecycleReportCommitHash(report: AiCodeCommitLifecycleReport): string {
		return (
			report.oldCommitHash ||
			report.newCommitHash ||
			report.commitHashes?.[0] ||
			report.replacementCommitHashes?.[0] ||
			"commit_lifecycle"
		)
	}

	private lifecycleTouchesBlockedCommit(
		report: AiCodeCommitLifecycleReport,
		blockedRepoCommitKeys?: Set<string>,
	): boolean {
		if (!blockedRepoCommitKeys || blockedRepoCommitKeys.size === 0) {
			return false
		}
		const relatedCommitHashes = [
			report.oldCommitHash,
			report.newCommitHash,
			...(report.commitHashes ?? []),
			...(report.replacementCommitHashes ?? []),
		]
		return relatedCommitHashes.some(
			(commitHash) =>
				Boolean(commitHash) && blockedRepoCommitKeys.has(buildRepoCommitKey(report.repoRoot, commitHash!)),
		)
	}

	private async postJson(
		webhookUrl: string,
		payload: unknown,
		errorPrefix: string,
		expectation: Omit<IngestAcknowledgementExpectation, "payloadSha256">,
	): Promise<void> {
		const body = JSON.stringify(payload)
		const payloadSha256 = this.sha256Hex(body)
		const response = await fetchWithRetries({
			url: webhookUrl,
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body,
			timeout: this.computePayloadUploadTimeout(Buffer.byteLength(body, "utf8")),
			shouldRetry: (res) => res.status >= 500 || res.status === 429,
		})

		await this.assertIngestAccepted(response, errorPrefix, {
			...expectation,
			payloadSha256,
		})
	}

	private async assertIngestAccepted(
		response: Response,
		errorPrefix: string,
		expectation: IngestAcknowledgementExpectation,
	): Promise<void> {
		const responseBody = await response.text().catch(() => "")
		if (!response.ok) {
			throw new Error(
				this.buildUploadErrorMessage(errorPrefix, response, this.describeUploadErrorBody(responseBody)),
			)
		}

		const trimmedBody = responseBody.trim()
		let payload: unknown
		try {
			payload = trimmedBody ? JSON.parse(trimmedBody) : undefined
		} catch {
			throw new Error(
				this.buildUploadErrorMessage(
					errorPrefix,
					response,
					`response is not valid JSON${trimmedBody ? `: ${trimmedBody.slice(0, 200)}` : ""}`,
				),
			)
		}

		if (!this.isAcceptedIngestResponse(payload)) {
			throw new Error(
				this.buildUploadErrorMessage(errorPrefix, response, this.describeRejectedIngestResponse(payload)),
			)
		}

		const mismatch = this.describeAcknowledgementMismatch(payload, expectation)
		if (mismatch) {
			throw new Error(this.buildUploadErrorMessage(errorPrefix, response, mismatch))
		}
	}

	private isAcceptedIngestResponse(payload: unknown): boolean {
		return typeof payload === "object" && payload !== null && (payload as { accepted?: unknown }).accepted === true
	}

	private describeRejectedIngestResponse(payload: unknown): string {
		if (typeof payload === "object" && payload !== null) {
			const record = payload as Record<string, unknown>
			const message = [record.msg, record.message, record.error].find(
				(value) => typeof value === "string" && value,
			)
			if (typeof message === "string") {
				return message
			}
			if ("accepted" in record) {
				return `response accepted is ${String(record.accepted)}`
			}
		}
		return "response accepted is not true"
	}

	private describeAcknowledgementMismatch(
		payload: unknown,
		expectation: IngestAcknowledgementExpectation,
	): string | undefined {
		const acknowledgement = payload as Record<string, unknown>
		if (acknowledgement.kind !== expectation.kind) {
			return `acknowledgement kind is ${String(acknowledgement.kind)}, expected ${expectation.kind}`
		}
		if (expectation.reportId !== undefined && acknowledgement.reportId !== expectation.reportId) {
			return `acknowledgement reportId is ${String(acknowledgement.reportId)}, expected ${expectation.reportId}`
		}
		if (expectation.itemCount !== undefined) {
			const insertedEvents = acknowledgement.insertedEvents
			const duplicateEvents = acknowledgement.duplicateEvents
			if (
				!Number.isSafeInteger(insertedEvents) ||
				(insertedEvents as number) < 0 ||
				!Number.isSafeInteger(duplicateEvents) ||
				(duplicateEvents as number) < 0
			) {
				return "acknowledgement event counts must be non-negative integers"
			}
			const acknowledgedCount = (insertedEvents as number) + (duplicateEvents as number)
			if (acknowledgedCount !== expectation.itemCount) {
				return `acknowledgement event count is ${acknowledgedCount}, expected ${expectation.itemCount}`
			}
		}
		const acknowledgedPayloadSha256 = acknowledgement.payloadSha256
		if (
			typeof acknowledgedPayloadSha256 !== "string" ||
			!/^[0-9a-f]{64}$/i.test(acknowledgedPayloadSha256) ||
			acknowledgedPayloadSha256.toLowerCase() !== expectation.payloadSha256
		) {
			return `acknowledgement payloadSha256 is ${String(
				acknowledgedPayloadSha256,
			)}, expected ${expectation.payloadSha256}`
		}
		return undefined
	}

	private describeUploadErrorBody(responseBody: string): string | undefined {
		const trimmedBody = responseBody.trim()
		if (!trimmedBody) {
			return undefined
		}
		try {
			return this.describeRejectedIngestResponse(JSON.parse(trimmedBody))
		} catch {
			return trimmedBody
		}
	}

	private buildUploadErrorMessage(errorPrefix: string, response: Response, detail?: string): string {
		const statusText = response.statusText ? ` ${response.statusText}` : ""
		return `${errorPrefix} (${response.status}${statusText})${detail ? `: ${detail.slice(0, 200)}` : ""}`
	}

	private async prepareJsonPayload(payload: unknown): Promise<{
		body: string | Uint8Array
		contentEncoding: "gzip" | "identity"
		rawPayloadBytes: number
		compressedPayloadBytes: number
		timeoutMs: number
		payloadSha256: string
	}> {
		const rawJson = JSON.stringify(payload)
		const raw = Buffer.from(rawJson, "utf8")
		const payloadSha256 = this.sha256Hex(raw)
		if (raw.byteLength < COMMIT_REPORT_GZIP_MIN_RAW_BYTES) {
			return {
				body: rawJson,
				contentEncoding: "identity",
				rawPayloadBytes: raw.byteLength,
				compressedPayloadBytes: raw.byteLength,
				timeoutMs: this.computePayloadUploadTimeout(raw.byteLength),
				payloadSha256,
			}
		}
		const compressed = await gzipAsync(raw)
		const timeoutMs = this.computePayloadUploadTimeout(compressed.byteLength)
		return {
			body: new Uint8Array(compressed),
			contentEncoding: "gzip",
			rawPayloadBytes: raw.byteLength,
			compressedPayloadBytes: compressed.byteLength,
			timeoutMs,
			payloadSha256,
		}
	}

	private sha256Hex(payload: string | Uint8Array): string {
		return createHash("sha256").update(payload).digest("hex")
	}

	private assertPreparedPayloadWithinServerLimits(prepared: {
		rawPayloadBytes: number
		compressedPayloadBytes: number
	}): void {
		if (prepared.rawPayloadBytes > COMMIT_REPORT_MAX_RAW_BYTES) {
			throw new Error(
				`AI code stats payload too large before upload: raw bytes ${prepared.rawPayloadBytes} exceed ${COMMIT_REPORT_MAX_RAW_BYTES}`,
			)
		}
		if (prepared.compressedPayloadBytes > COMMIT_REPORT_MAX_WIRE_BYTES) {
			throw new Error(
				`AI code stats payload too large before upload: wire bytes ${prepared.compressedPayloadBytes} exceed ${COMMIT_REPORT_MAX_WIRE_BYTES}`,
			)
		}
	}

	private assertLifecyclePayloadWithinServerLimits(payload: AiCodeCommitLifecycleReport): void {
		const requiredFields: Array<[string, unknown]> = [
			["eventId", payload.eventId],
			["reportId", payload.reportId],
			["source", payload.source],
			["version", payload.version],
			["mode", payload.mode],
			["eventType", payload.eventType],
			["reason", payload.reason],
		]
		for (const [field, value] of requiredFields) {
			if (typeof value !== "string" || !value.trim()) {
				throw new Error(`AI code commit lifecycle ${field} is required`)
			}
		}
		if (payload.mode !== "commit_lifecycle") {
			throw new Error("AI code commit lifecycle mode is invalid")
		}
		if (!["commit_replaced", "commits_abandoned", "branch_rewrite_observed"].includes(payload.eventType)) {
			throw new Error("AI code commit lifecycle eventType is unsupported")
		}
		if (payload.gitBranch && payload.gitBranch.length > COMMIT_LIFECYCLE_MAX_BRANCH_CHARS) {
			throw new Error(`AI code commit lifecycle branch exceeds ${COMMIT_LIFECYCLE_MAX_BRANCH_CHARS} characters`)
		}
		this.assertCurrentSemanticsVersion("AI code commit lifecycle", payload.semanticsVersion)
		this.assertStringFieldsWithinLimits("AI code commit lifecycle", [
			["eventId", payload.eventId, 128],
			["reportId", payload.reportId, 128],
			["source", payload.source, 64],
			["version", payload.version, 16],
			["mode", payload.mode, 32],
			["eventType", payload.eventType, 64],
			["reason", payload.reason, 64],
			["confidence", payload.confidence, 32],
			["projectKey", payload.projectKey, 64],
			["projectName", payload.projectName, GENERAL_TEXT_MAX_CHARS],
			["repoRoot", payload.repoRoot, PATH_MAX_CHARS],
			["gitRemoteUrl", payload.gitRemoteUrl, PATH_MAX_CHARS],
			["oldCommitHash", payload.oldCommitHash, 128],
			["newCommitHash", payload.newCommitHash, 128],
		])
		this.assertUploadClientWithinServerLimits("AI code commit lifecycle client", payload.client)
		for (const [field, hashes] of [
			["commitHashes", payload.commitHashes],
			["replacementCommitHashes", payload.replacementCommitHashes],
		] as const) {
			for (const hash of hashes ?? []) {
				this.assertStringWithinLimit(`AI code commit lifecycle ${field}`, hash, 128)
			}
		}
		this.assertResolvedProjectNameWithinServerLimits(
			"AI code commit lifecycle",
			payload.projectName,
			undefined,
			payload.gitRemoteUrl,
			payload.repoRoot,
			payload.projectKey,
		)
		for (const [field, value] of [
			["eventOccurredAt", payload.eventOccurredAt],
			["reportedAt", payload.reportedAt],
		] as const) {
			if (!this.isDatabaseSafeTimestamp(value)) {
				throw new Error(`AI code commit lifecycle ${field} is outside the database-safe range`)
			}
		}
		const oldCommits = new Set(
			[payload.oldCommitHash, ...(payload.commitHashes ?? [])]
				.filter((commitHash): commitHash is string => Boolean(commitHash?.trim()))
				.map((commitHash) => commitHash.trim()),
		)
		const newCommits = new Set(
			[payload.newCommitHash, ...(payload.replacementCommitHashes ?? [])]
				.filter((commitHash): commitHash is string => Boolean(commitHash?.trim()))
				.map((commitHash) => commitHash.trim()),
		)
		if (
			oldCommits.size > COMMIT_LIFECYCLE_MAX_HASHES_PER_SIDE ||
			newCommits.size > COMMIT_LIFECYCLE_MAX_HASHES_PER_SIDE
		) {
			throw new Error(`AI code commit lifecycle exceeds ${COMMIT_LIFECYCLE_MAX_HASHES_PER_SIDE} hashes per side`)
		}
		if (oldCommits.size === 0 && newCommits.size === 0) {
			throw new Error("AI code commit lifecycle requires at least one commit hash")
		}
	}

	private assertCommitReportPayloadWithinServerLimits(payload: AiCodeCompactCommitReport): void {
		const requiredFields: Array<[string, unknown]> = [
			["source", payload.source],
			["version", payload.version],
			["mode", payload.mode],
			["reportId", payload.reportId],
			["commitHash", payload.commitHash],
			["client ide", payload.client?.ide],
		]
		for (const [field, value] of requiredFields) {
			if (typeof value !== "string" || !value.trim()) {
				throw new Error(`AI code commit report ${field} is required`)
			}
		}
		if (payload.mode !== "commit_report") {
			throw new Error("AI code commit report mode is invalid")
		}
		this.assertCurrentSemanticsVersion("AI code commit report", payload.semanticsVersion)
		this.assertStringFieldsWithinLimits("AI code commit report", [
			["source", payload.source, 64],
			["version", payload.version, 16],
			["mode", payload.mode, 32],
			["reportId", payload.reportId, 128],
			["repoRoot", payload.repoRoot, COMMIT_REPORT_MAX_FILE_PATH_CHARS],
			["projectKey", payload.projectKey, 64],
			["projectName", payload.projectName, GENERAL_TEXT_MAX_CHARS],
			["gitRemoteUrl", payload.gitRemoteUrl, PATH_MAX_CHARS],
			["gitBranch", payload.gitBranch, COMMIT_LIFECYCLE_MAX_BRANCH_CHARS],
			["commitHash", payload.commitHash, 64],
			["previousCommitHash", payload.previousCommitHash, 64],
			["authorName", payload.authorName, GENERAL_TEXT_MAX_CHARS],
			["authorEmail", payload.authorEmail, GENERAL_TEXT_MAX_CHARS],
			["committerName", payload.committerName, GENERAL_TEXT_MAX_CHARS],
			["committerEmail", payload.committerEmail, GENERAL_TEXT_MAX_CHARS],
		])
		this.assertUploadClientWithinServerLimits("AI code commit report client", payload.client)
		this.assertResolvedProjectNameWithinServerLimits(
			"AI code commit report",
			payload.projectName,
			undefined,
			payload.gitRemoteUrl,
			payload.repoRoot,
			payload.projectKey,
		)

		const defaults = payload.defaults
		this.assertStringFieldsWithinLimits("AI code commit report defaults", [
			["sourceType", defaults.sourceType, 32],
			["ide", defaults.ide, 32],
			["userName", defaults.userName, GENERAL_TEXT_MAX_CHARS],
			["departmentName", defaults.departmentName, GENERAL_TEXT_MAX_CHARS],
			["officeName", defaults.officeName, GENERAL_TEXT_MAX_CHARS],
			["teamName", defaults.teamName, GENERAL_TEXT_MAX_CHARS],
			["userEmail", defaults.userEmail, GENERAL_TEXT_MAX_CHARS],
			["organizationId", defaults.organizationId, 128],
			["organizationName", defaults.organizationName, GENERAL_TEXT_MAX_CHARS],
			["sourceIp", defaults.sourceIp, 64],
			["provider", defaults.provider, 128],
			["model", defaults.model, GENERAL_TEXT_MAX_CHARS],
			["projectKey", defaults.projectKey, 64],
			["projectName", defaults.projectName, GENERAL_TEXT_MAX_CHARS],
			["repoRoot", defaults.repoRoot, COMMIT_REPORT_MAX_FILE_PATH_CHARS],
			["gitRemoteUrl", defaults.gitRemoteUrl, PATH_MAX_CHARS],
			["gitBranch", defaults.gitBranch, COMMIT_LIFECYCLE_MAX_BRANCH_CHARS],
		])
		this.assertResolvedProjectNameWithinServerLimits(
			"AI code commit report defaults",
			defaults.projectName,
			undefined,
			defaults.gitRemoteUrl,
			defaults.repoRoot,
			defaults.projectKey,
		)

		for (const snapshot of payload.snapshots ?? []) {
			this.assertStringWithinLimit("AI code commit report snapshot contentHash", snapshot.contentHash, 64)
			this.assertUtf8BytesWithinLimit(
				"AI code commit report snapshot content",
				snapshot.content,
				INCREMENTAL_MAX_FILE_SNAPSHOT_BYTES,
			)
		}
		const snapshotHashes = new Set((payload.snapshots ?? []).map((snapshot) => snapshot.contentHash))
		for (const block of [...(payload.generatedBlocks ?? []), ...(payload.acceptedBlocks ?? [])]) {
			if (block.fileSnapshotHash && !snapshotHashes.has(block.fileSnapshotHash)) {
				throw new Error("AI code commit report baseline snapshot reference is missing")
			}
			this.assertCommitReportBlockWithinServerLimits(payload, block)
		}
		for (const file of payload.changedFiles ?? []) {
			if (file.committedSnapshotHash && !snapshotHashes.has(file.committedSnapshotHash)) {
				throw new Error("AI code commit report changed-file snapshot reference is missing")
			}
			this.assertCommitChangedFileWithinServerLimits(file)
		}
		for (const line of payload.candidateLines ?? []) {
			this.assertCommitCandidateLineWithinServerLimits(payload, line)
		}
	}

	private assertCommitReportBlockWithinServerLimits(
		payload: AiCodeCompactCommitReport,
		block: AiCodeCompactBlockPayload,
	): void {
		const defaults = payload.defaults
		const effective = {
			sourceType: this.firstNonBlankValue(block.sourceType, defaults.sourceType, "agent_insert"),
			ide: this.firstNonBlankValue(block.ide, payload.client.ide, defaults.ide),
			userName: this.firstNonBlankValue(block.userName, defaults.userName),
			departmentName: this.firstNonBlankValue(block.departmentName, defaults.departmentName),
			officeName: this.firstNonBlankValue(block.officeName, defaults.officeName),
			teamName: this.firstNonBlankValue(block.teamName, defaults.teamName),
			userEmail: this.firstNonBlankValue(block.userEmail, defaults.userEmail),
			organizationId: this.firstNonBlankValue(block.organizationId, defaults.organizationId),
			organizationName: this.firstNonBlankValue(block.organizationName, defaults.organizationName),
			sourceIp: this.firstNonBlankValue(block.sourceIp, defaults.sourceIp),
			provider: this.firstNonBlankValue(block.provider, defaults.provider),
			model: this.firstNonBlankValue(block.model, defaults.model),
			projectKey: this.firstNonBlankValue(block.projectKey, payload.projectKey, defaults.projectKey),
			projectName: this.firstNonBlankValue(block.projectName, payload.projectName, defaults.projectName),
			repoRoot: this.firstNonBlankValue(block.repoRoot, payload.repoRoot, defaults.repoRoot),
			gitRemoteUrl: this.firstNonBlankValue(block.gitRemoteUrl, payload.gitRemoteUrl, defaults.gitRemoteUrl),
			gitBranch: this.firstNonBlankValue(block.gitBranch, payload.gitBranch, defaults.gitBranch),
		}
		if (
			!block.eventId?.trim() ||
			!effective.sourceType ||
			!effective.ide ||
			(!effective.projectKey && !effective.gitRemoteUrl && !effective.repoRoot) ||
			!block.filePath?.trim() ||
			!block.relativePath?.trim() ||
			typeof block.codeSnippet !== "string"
		) {
			throw new Error("AI code commit report baseline block is incomplete")
		}
		if (
			!Number.isInteger(block.lineStart) ||
			block.lineStart < 1 ||
			block.lineStart > JAVA_INTEGER_MAX ||
			!Number.isInteger(block.lineEnd) ||
			block.lineEnd < block.lineStart ||
			block.lineEnd > JAVA_INTEGER_MAX ||
			!Number.isInteger(block.lineCount) ||
			block.lineCount < 1 ||
			block.lineCount > JAVA_INTEGER_MAX
		) {
			throw new Error("AI code commit report baseline block line range is invalid")
		}
		if (!this.isDatabaseSafeTimestamp(block.timestamp)) {
			throw new Error("AI code commit report baseline timestamp is outside the database-safe range")
		}
		this.assertCurrentSemanticsVersion(
			"AI code commit report baseline",
			block.semanticsVersion ?? payload.semanticsVersion,
		)
		this.assertStringFieldsWithinLimits("AI code commit report baseline", [
			["eventId", block.eventId, 128],
			["generatedBlockId", block.generatedBlockId, 128],
			["sourceType", effective.sourceType, 32],
			["ide", effective.ide, 32],
			["changeType", block.changeType, 32],
			["userName", effective.userName, GENERAL_TEXT_MAX_CHARS],
			["departmentName", effective.departmentName, GENERAL_TEXT_MAX_CHARS],
			["officeName", effective.officeName, GENERAL_TEXT_MAX_CHARS],
			["teamName", effective.teamName, GENERAL_TEXT_MAX_CHARS],
			["userEmail", effective.userEmail, GENERAL_TEXT_MAX_CHARS],
			["organizationId", effective.organizationId, 128],
			["organizationName", effective.organizationName, GENERAL_TEXT_MAX_CHARS],
			["sourceIp", effective.sourceIp, 64],
			["provider", effective.provider, 128],
			["model", effective.model, GENERAL_TEXT_MAX_CHARS],
			["projectKey", effective.projectKey, 64],
			["projectName", effective.projectName, GENERAL_TEXT_MAX_CHARS],
			["repoRoot", effective.repoRoot, PATH_MAX_CHARS],
			["repoRelativePath", block.repoRelativePath, PATH_MAX_CHARS],
			["filePath", block.filePath, PATH_MAX_CHARS],
			["relativePath", block.relativePath, PATH_MAX_CHARS],
			["language", block.language, 64],
			["gitRemoteUrl", effective.gitRemoteUrl, PATH_MAX_CHARS],
			["gitBranch", effective.gitBranch, COMMIT_LIFECYCLE_MAX_BRANCH_CHARS],
			["fileSnapshotHash", block.fileSnapshotHash, 64],
			["taskId", block.taskId, 128],
		])
		if (!effective.userEmail || !this.isValidEmail(effective.userEmail.trim().toLowerCase())) {
			throw new Error("AI code commit report baseline userEmail is invalid")
		}
		this.assertResolvedProjectNameWithinServerLimits(
			"AI code commit report baseline",
			effective.projectName,
			payload.projectName,
			effective.gitRemoteUrl,
			effective.repoRoot,
			effective.projectKey,
		)
		this.assertUtf8BytesWithinLimit(
			"AI code commit report baseline codeSnippet",
			block.codeSnippet,
			INCREMENTAL_MAX_CODE_SNIPPET_BYTES,
		)
	}

	private assertCommitChangedFileWithinServerLimits(file: AiCodeCompactChangedFilePayload): void {
		this.assertStringFieldsWithinLimits("AI code commit report changedFiles", [
			["relativePath", file.relativePath, COMMIT_REPORT_MAX_RELATIVE_PATH_CHARS],
			["filePath", file.filePath, COMMIT_REPORT_MAX_FILE_PATH_CHARS],
			["previousFilePath", file.previousFilePath, COMMIT_REPORT_MAX_FILE_PATH_CHARS],
			["language", file.language, 64],
			["committedSnapshotHash", file.committedSnapshotHash, 64],
		])
		for (const block of file.changedBlocks ?? []) {
			this.assertUtf8BytesWithinLimit(
				"AI code commit report changedBlocks codeSnippet",
				block.codeSnippet,
				INCREMENTAL_MAX_CODE_SNIPPET_BYTES,
			)
		}
		for (const line of file.addedLines ?? []) {
			this.assertStringWithinLimit("AI code commit report addedLines lineHash", line.lineHash, 64)
			this.assertUtf8BytesWithinLimit(
				"AI code commit report addedLines content",
				line.content,
				INCREMENTAL_MAX_CODE_SNIPPET_BYTES,
			)
		}
		for (const line of file.deletedLines ?? []) {
			this.assertStringWithinLimit("AI code commit report deletedLines lineHash", line.lineHash, 64)
			this.assertUtf8BytesWithinLimit(
				"AI code commit report deletedLines content",
				line.content,
				INCREMENTAL_MAX_CODE_SNIPPET_BYTES,
			)
		}
	}

	private assertCommitCandidateLineWithinServerLimits(
		payload: AiCodeCompactCommitReport,
		line: AiCodeCompactCandidateLinePayload,
	): void {
		const defaults = payload.defaults
		const effective = {
			sourceType: this.firstNonBlankValue(line.sourceType, defaults.sourceType, "agent_insert"),
			ide: this.firstNonBlankValue(line.ide, payload.client.ide, defaults.ide),
			projectKey: this.firstNonBlankValue(line.projectKey, payload.projectKey, defaults.projectKey),
			projectName: this.firstNonBlankValue(line.projectName, payload.projectName, defaults.projectName),
			repoRoot: this.firstNonBlankValue(line.repoRoot, payload.repoRoot, defaults.repoRoot),
			gitRemoteUrl: this.firstNonBlankValue(line.gitRemoteUrl, payload.gitRemoteUrl, defaults.gitRemoteUrl),
			gitBranch: this.firstNonBlankValue(line.gitBranch, payload.gitBranch, defaults.gitBranch),
		}
		if (!line.clientLineId?.trim() || !line.generatedBlockId?.trim() || typeof line.rawLine !== "string") {
			throw new Error("AI code commit report candidateLines entry is incomplete")
		}
		if (!this.isDatabaseSafeTimestamp(line.sourceTimestamp)) {
			throw new Error("AI code commit report candidate sourceTimestamp is outside the database-safe range")
		}
		this.assertStringFieldsWithinLimits("AI code commit report candidateLines", [
			// clientLineId is intentionally not bounded here. The backend keeps
			// compatibility by hashing oversized historical ids into varchar(128).
			["generatedBlockId", line.generatedBlockId, 128],
			["baselineEventId", line.baselineEventId, 128],
			["baselineMetricType", line.baselineMetricType, 32],
			["sourceType", effective.sourceType, 32],
			["ide", effective.ide, 32],
			["userName", this.firstNonBlankValue(line.userName, defaults.userName), GENERAL_TEXT_MAX_CHARS],
			[
				"departmentName",
				this.firstNonBlankValue(line.departmentName, defaults.departmentName),
				GENERAL_TEXT_MAX_CHARS,
			],
			["officeName", this.firstNonBlankValue(line.officeName, defaults.officeName), GENERAL_TEXT_MAX_CHARS],
			["teamName", this.firstNonBlankValue(line.teamName, defaults.teamName), GENERAL_TEXT_MAX_CHARS],
			["userEmail", this.firstNonBlankValue(line.userEmail, defaults.userEmail), GENERAL_TEXT_MAX_CHARS],
			["organizationId", this.firstNonBlankValue(line.organizationId, defaults.organizationId), 128],
			[
				"organizationName",
				this.firstNonBlankValue(line.organizationName, defaults.organizationName),
				GENERAL_TEXT_MAX_CHARS,
			],
			["sourceIp", this.firstNonBlankValue(line.sourceIp, defaults.sourceIp), 64],
			["provider", this.firstNonBlankValue(line.provider, defaults.provider), 128],
			["model", this.firstNonBlankValue(line.model, defaults.model), GENERAL_TEXT_MAX_CHARS],
			["projectKey", effective.projectKey, 64],
			["projectName", effective.projectName, GENERAL_TEXT_MAX_CHARS],
			["filePath", line.filePath, COMMIT_REPORT_MAX_FILE_PATH_CHARS],
			["relativePath", line.relativePath, COMMIT_REPORT_MAX_RELATIVE_PATH_CHARS],
			["repoRoot", effective.repoRoot, COMMIT_REPORT_MAX_FILE_PATH_CHARS],
			["repoRelativePath", line.repoRelativePath, COMMIT_REPORT_MAX_RELATIVE_PATH_CHARS],
			["language", line.language, 64],
			["gitRemoteUrl", effective.gitRemoteUrl, PATH_MAX_CHARS],
			["gitBranch", effective.gitBranch, COMMIT_LIFECYCLE_MAX_BRANCH_CHARS],
			["taskId", line.taskId, 128],
			["lineHash", line.lineHash, 64],
			["changeType", line.changeType, 32],
			["machineId", payload.client.machineId, 128],
			[
				"normalized relativePath",
				this.normalizeReportPath(line.relativePath, payload.repoRoot),
				COMMIT_REPORT_MAX_RELATIVE_PATH_CHARS,
			],
			[
				"normalized repoRelativePath",
				this.firstNonBlank(
					this.normalizeReportPath(line.repoRelativePath, payload.repoRoot),
					this.normalizeReportPath(line.relativePath, payload.repoRoot),
				),
				COMMIT_REPORT_MAX_RELATIVE_PATH_CHARS,
			],
		])
		this.assertResolvedProjectNameWithinServerLimits(
			"AI code commit report candidateLines",
			effective.projectName,
			payload.projectName,
			effective.gitRemoteUrl,
			effective.repoRoot,
			effective.projectKey,
		)
		this.assertUtf8BytesWithinLimit(
			"AI code commit report candidateLines rawLine",
			line.rawLine,
			INCREMENTAL_MAX_CODE_SNIPPET_BYTES,
		)
	}

	private assertCurrentSemanticsVersion(field: string, value: unknown): void {
		if (value !== CURRENT_AI_CODE_STATS_SEMANTICS_VERSION) {
			throw new Error(`${field} semanticsVersion is unsupported`)
		}
	}

	private assertUploadClientWithinServerLimits(field: string, client: AiCodeStatsUploadClient | undefined): void {
		this.assertStringFieldsWithinLimits(field, [
			["ide", client?.ide, 32],
			["wrapperName", client?.wrapperName, 128],
			["wrapperVersion", client?.wrapperVersion, 64],
			["extensionVersion", client?.extensionVersion, 64],
			["machineId", client?.machineId, 128],
		])
	}

	private assertStringFieldsWithinLimits(prefix: string, fields: Array<[string, unknown, number]>): void {
		for (const [field, value, maxChars] of fields) {
			this.assertStringWithinLimit(`${prefix} ${field}`, value, maxChars)
		}
	}

	private assertStringWithinLimit(field: string, value: unknown, maxChars: number): void {
		if (typeof value === "string" && value.length > maxChars) {
			throw new Error(`${field} exceeds ${maxChars} characters`)
		}
	}

	private assertUtf8BytesWithinLimit(field: string, value: unknown, maxBytes: number): void {
		if (typeof value === "string" && Buffer.byteLength(value, "utf8") > maxBytes) {
			throw new Error(`${field} exceeds ${maxBytes} UTF-8 bytes`)
		}
	}

	private assertResolvedProjectNameWithinServerLimits(
		field: string,
		preferredName?: string,
		reportName?: string,
		gitRemoteUrl?: string,
		repoRoot?: string,
		fallback?: string,
	): void {
		const resolvedName = this.firstNonBlank(
			preferredName,
			reportName,
			this.projectNameFromRemoteUrl(gitRemoteUrl),
			this.projectNameFromRepoRoot(repoRoot),
			fallback,
			"unknown-project",
		)
		this.assertStringWithinLimit(`${field} resolved projectName`, resolvedName, GENERAL_TEXT_MAX_CHARS)
	}

	private projectNameFromRemoteUrl(gitRemoteUrl?: string): string | undefined {
		const normalized = gitRemoteUrl?.trim().replace(/\\/g, "/").replace(/\/+$/, "")
		if (!normalized) {
			return undefined
		}
		const splitIndex = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf(":"))
		const name = (splitIndex >= 0 ? normalized.slice(splitIndex + 1) : normalized).replace(/\.git$/i, "")
		return name.trim() || undefined
	}

	private projectNameFromRepoRoot(repoRoot?: string): string | undefined {
		const normalized = repoRoot?.trim().replace(/\\/g, "/").replace(/\/+$/, "")
		if (!normalized) {
			return undefined
		}
		const slashIndex = normalized.lastIndexOf("/")
		const name = slashIndex >= 0 ? normalized.slice(slashIndex + 1) : normalized
		return name.trim() || undefined
	}

	private normalizeReportPath(value?: string, repoRoot?: string): string | undefined {
		const trimmed = value?.trim()
		if (!trimmed) {
			return undefined
		}
		let normalized = trimmed.replace(/\\/g, "/")
		const normalizedRepoRoot = repoRoot?.trim().replace(/\\/g, "/")
		if (normalizedRepoRoot) {
			const rootWithSlash = normalizedRepoRoot.endsWith("/") ? normalizedRepoRoot : `${normalizedRepoRoot}/`
			if (normalized === normalizedRepoRoot) {
				return ""
			}
			if (normalized.startsWith(rootWithSlash)) {
				normalized = normalized.slice(rootWithSlash.length)
			}
		}
		while (normalized.startsWith("../")) {
			normalized = normalized.slice(3)
		}
		return normalized
	}

	private firstNonBlank(...values: Array<string | undefined>): string | undefined {
		for (const value of values) {
			const trimmed = value?.trim()
			if (trimmed) {
				return trimmed
			}
		}
		return undefined
	}

	private firstNonBlankValue(...values: Array<string | undefined>): string | undefined {
		for (const value of values) {
			if (value?.trim()) {
				return value
			}
		}
		return undefined
	}

	private assertCommitReportTimestampsWithinServerLimits(
		report: Parameters<typeof buildCompactCommitReportPayload>[0],
	): void {
		for (const [field, value] of [
			["reportGeneratedAt", report.reportGeneratedAt],
			["commitOccurredAt", report.commitOccurredAt],
		] as const) {
			if (!this.isDatabaseSafeTimestamp(value)) {
				throw new Error(`AI code commit report ${field} is outside the database-safe range`)
			}
		}
		for (const block of [...(report.generatedBlocks ?? []), ...(report.acceptedBlocks ?? [])]) {
			if (!this.isDatabaseSafeTimestamp(block.timestamp)) {
				throw new Error("AI code commit report baseline timestamp is outside the database-safe range")
			}
		}
		for (const line of report.candidateLines ?? []) {
			if (!this.isDatabaseSafeTimestamp(line.sourceTimestamp)) {
				throw new Error("AI code commit report candidate sourceTimestamp is outside the database-safe range")
			}
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
			payloadSha256: string
		},
		reportIdentity: {
			reportId: string
			commitHash: string
			itemCount: number
		},
		errorPrefix: string,
		expectedKind: "commit_report" | "commit_lifecycle",
		requestOptions: {
			timeoutMs?: number
			retries?: number
		} = {},
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
			body: prepared.body as BodyInit,
			retries: requestOptions.retries ?? 3,
			timeout: requestOptions.timeoutMs ?? prepared.timeoutMs,
			shouldRetry: (res) => res.status >= 500 || res.status === 429,
		})

		await this.assertIngestAccepted(response, errorPrefix, {
			kind: expectedKind,
			reportId: reportIdentity.reportId,
			itemCount: reportIdentity.itemCount,
			payloadSha256: prepared.payloadSha256,
		})
	}

	private computePayloadUploadTimeout(payloadBytes: number): number {
		const sizeBasedTimeout =
			Math.ceil(payloadBytes / COMMIT_REPORT_UPLOAD_BYTES_PER_SECOND) * 1000 +
			COMMIT_REPORT_UPLOAD_BASE_TIMEOUT_MS
		return Math.min(
			COMMIT_REPORT_UPLOAD_MAX_TIMEOUT_MS,
			Math.max(COMMIT_REPORT_UPLOAD_MIN_TIMEOUT_MS, sizeBasedTimeout),
		)
	}

	private normalizeMaxReports(maxReports?: number): number {
		if (maxReports === undefined) {
			return Number.MAX_SAFE_INTEGER
		}
		if (!Number.isFinite(maxReports)) {
			return maxReports > 0 ? Number.MAX_SAFE_INTEGER : 0
		}
		return Math.max(0, Math.floor(maxReports))
	}

	private normalizeRequestRetries(requestRetries?: number): number {
		if (requestRetries === undefined || !Number.isFinite(requestRetries)) {
			return 3
		}
		return Math.max(0, Math.floor(requestRetries))
	}

	private hasUploadDeadlineExpired(deadlineAt?: number): boolean {
		return Number.isFinite(deadlineAt) && Date.now() >= deadlineAt!
	}

	private resolveRequestTimeout(preparedTimeoutMs: number, deadlineAt?: number): number | undefined {
		if (!Number.isFinite(deadlineAt)) {
			return preparedTimeoutMs
		}
		const remainingMs = Math.floor(deadlineAt! - Date.now())
		if (remainingMs <= 0) {
			return undefined
		}
		return Math.max(1, Math.min(preparedTimeoutMs, remainingMs))
	}

	private async orderCommitReportsByOldestAttempt(
		reports: Awaited<ReturnType<AiCodeStatsStore["getQueuedCommitReports"]>>,
	): Promise<Awaited<ReturnType<AiCodeStatsStore["getQueuedCommitReports"]>>> {
		const uploadRecords = await this.store.getCommitUploadRecords()
		const permanentlyBlockedReportIds = new Set(
			uploadRecords
				.filter(
					(record) =>
						record.reportId &&
						(record.lastErrorCategory === "payload_too_large" ||
							record.lastErrorCategory === "invalid_local_payload"),
				)
				.map((record) => record.reportId!),
		)
		const lastAttemptByReportId = new Map(
			uploadRecords
				.filter((record) => record.reportId)
				.map((record) => [record.reportId!, record.lastAttemptAt] as const),
		)
		return reports
			.filter((report) => !permanentlyBlockedReportIds.has(report.report.reportId))
			.sort((left, right) => {
				const leftAttempt = lastAttemptByReportId.get(left.report.reportId)
				const rightAttempt = lastAttemptByReportId.get(right.report.reportId)
				if (leftAttempt === undefined && rightAttempt !== undefined) {
					return -1
				}
				if (leftAttempt !== undefined && rightAttempt === undefined) {
					return 1
				}
				return (
					(leftAttempt ?? 0) - (rightAttempt ?? 0) ||
					left.createdAt - right.createdAt ||
					left.report.reportId.localeCompare(right.report.reportId)
				)
			})
	}
}
