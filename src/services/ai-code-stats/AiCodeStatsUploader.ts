// kilocode_change - new file

import { fetchWithRetries } from "../../shared/http"
import { AiCodeStatsStore } from "./AiCodeStatsStore"
import { resolveAiCodeStatsWebhookUrl } from "./AiCodeStatsWebhookUrl"
import {
	CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
	normalizePath,
	type AiCodeCommitReport,
	type AiCodeStatsUploadClient,
	type AiCodeStatsUploadEnvelope,
	type AiCodeStatsUploadSettings,
} from "./types"

export interface AiCodeStatsUploadResult {
	uploaded: number
}

export interface AiCodeCommitReportUploadResult {
	uploadedReports: number
	uploadedBlocks: number
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
				workspacePath: normalizePath(event.workspacePath),
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
			return { uploadedReports: 0, uploadedBlocks: 0 }
		}

		const webhookUrl = resolveAiCodeStatsWebhookUrl(settings.webhookUrl)
		const reports = await this.store.getQueuedCommitReports()
		let uploadedReports = 0
		let uploadedBlocks = 0

		for (const queued of reports) {
			await this.postJson(
				webhookUrl,
				this.buildCommitReportPayload(queued.report),
				"AI code commit report upload failed",
			)
			await this.store.acknowledgeQueuedCommitReport(queued.report.reportId)
			uploadedReports += 1
			const baselineBlockCount =
				queued.report.acceptedBlocks && queued.report.acceptedBlocks.length > 0
					? queued.report.acceptedBlocks.length
					: (queued.report.generatedBlocks?.length ?? 0)
			uploadedBlocks += baselineBlockCount
		}

		return { uploadedReports, uploadedBlocks }
	}

	private buildCommitReportPayload(report: AiCodeCommitReport): AiCodeCommitReport {
		return {
			version: "v2",
			source: "kilocode-ai-code-stats",
			mode: "commit_report",
			semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
			attributionInputVersion: report.attributionInputVersion,
			reportId: report.reportId,
			reportGeneratedAt: report.reportGeneratedAt,
			client: report.client,
			repoRoot: normalizePath(report.repoRoot),
			workspaceName: report.workspaceName,
			workspacePath: normalizePath(report.workspacePath),
			projectKey: report.projectKey,
			gitRemoteUrl: report.gitRemoteUrl,
			gitBranch: report.gitBranch,
			commitHash: report.commitHash,
			previousCommitHash: report.previousCommitHash,
			commitOccurredAt: report.commitOccurredAt,
			acceptedBlocks: (report.acceptedBlocks ?? []).map((block) => ({
				eventId: block.eventId,
				generatedBlockId: block.generatedBlockId,
				timestamp: block.timestamp,
				semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
				sourceType: block.sourceType,
				ide: block.ide,
				userName: block.userName,
				userEmail: block.userEmail,
				organizationId: block.organizationId,
				organizationName: block.organizationName,
				sourceIp: block.sourceIp,
				workspaceName: block.workspaceName,
				workspacePath: normalizePath(block.workspacePath),
				projectKey: block.projectKey,
				filePath: normalizePath(block.filePath),
				relativePath: normalizePath(block.relativePath),
				language: block.language,
				gitRemoteUrl: block.gitRemoteUrl,
				gitBranch: block.gitBranch,
				lineStart: block.lineStart,
				lineEnd: block.lineEnd,
				lineCount: block.lineCount,
				codeSnippet: block.codeSnippet,
				fileSnapshotContent: block.fileSnapshotContent,
				taskId: block.taskId,
			})),
			generatedBlocks: (report.generatedBlocks ?? []).map((block) => ({
				eventId: block.eventId,
				generatedBlockId: block.generatedBlockId,
				timestamp: block.timestamp,
				semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
				sourceType: block.sourceType,
				ide: block.ide,
				userName: block.userName,
				userEmail: block.userEmail,
				organizationId: block.organizationId,
				organizationName: block.organizationName,
				sourceIp: block.sourceIp,
				workspaceName: block.workspaceName,
				workspacePath: normalizePath(block.workspacePath),
				projectKey: block.projectKey,
				filePath: normalizePath(block.filePath),
				relativePath: normalizePath(block.relativePath),
				language: block.language,
				gitRemoteUrl: block.gitRemoteUrl,
				gitBranch: block.gitBranch,
				lineStart: block.lineStart,
				lineEnd: block.lineEnd,
				lineCount: block.lineCount,
				codeSnippet: block.codeSnippet,
				fileSnapshotContent: block.fileSnapshotContent,
				taskId: block.taskId,
			})),
			changedFiles: (report.changedFiles || []).map((file) => ({
				relativePath: normalizePath(file.relativePath),
				filePath: normalizePath(file.filePath),
				previousFilePath: file.previousFilePath ? normalizePath(file.previousFilePath) : undefined,
				language: file.language,
				committedSnapshotContent: file.committedSnapshotContent,
				changedBlocks: (file.changedBlocks || []).map((block) => ({
					startLine: block.startLine,
					endLine: block.endLine,
					lineCount: block.lineCount,
					codeSnippet: block.codeSnippet,
					displayOrder: block.displayOrder,
				})),
				addedLines: (file.addedLines || []).map((line) => ({
					addedIndex: line.addedIndex,
					lineNumber: line.lineNumber,
					content: line.content,
					lineHash: line.lineHash,
				})),
			})),
			candidateLines: (report.candidateLines || []).map((line) => ({
				clientLineId: line.clientLineId,
				generatedBlockId: line.generatedBlockId,
				baselineEventId: line.baselineEventId,
				baselineMetricType: line.baselineMetricType,
				sourceTimestamp: line.sourceTimestamp,
				sourceType: line.sourceType,
				ide: line.ide,
				userName: line.userName,
				userEmail: line.userEmail,
				organizationId: line.organizationId,
				organizationName: line.organizationName,
				sourceIp: line.sourceIp,
				workspaceName: line.workspaceName,
				workspacePath: normalizePath(line.workspacePath),
				projectKey: line.projectKey,
				filePath: normalizePath(line.filePath),
				relativePath: normalizePath(line.relativePath),
				repoRoot: normalizePath(line.repoRoot),
				repoRelativePath: normalizePath(line.repoRelativePath),
				language: line.language,
				gitRemoteUrl: line.gitRemoteUrl,
				gitBranch: line.gitBranch,
				taskId: line.taskId,
				lineNumber: line.lineNumber,
				rawLine: line.rawLine,
				blockLineIndex: line.blockLineIndex,
				blockLineCount: line.blockLineCount,
				lineHash: line.lineHash,
				occurrenceIndex: line.occurrenceIndex,
			})),
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
}
