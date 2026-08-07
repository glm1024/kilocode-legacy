// kilocode_change - new file
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { createHash } from "crypto"
import { gunzip } from "zlib"
import { promisify } from "util"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { setFetchRetryFactorForTests } from "../../../shared/http"
import { AiCodeStatsStore } from "../AiCodeStatsStore"
import { AiCodeStatsUploader } from "../AiCodeStatsUploader"
import {
	CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
	buildRepoCommitKey,
	type AiCodeCommitLifecycleReport,
	type AiCodeCommitReport,
	type AiCodeQueuedCommitLifecycleReport,
	type AiCodeQueuedCommitReport,
	type AiCodeStatsEvent,
} from "../types"

const gunzipAsync = promisify(gunzip)

const acceptedIngestResponse = (body: Record<string, unknown> = {}): Response =>
	new Response(JSON.stringify({ accepted: true, kind: "commit_report", ...body }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	})

const rejectedIngestResponse = (body: Record<string, unknown> = {}): Response =>
	new Response(JSON.stringify({ accepted: false, code: 500, msg: "business failed", ...body }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	})

const decodeJsonBody = async (body: BodyInit | null | undefined, headers?: Record<string, string>): Promise<Buffer> => {
	const buffer =
		body instanceof Uint8Array
			? Buffer.from(body)
			: typeof body === "string"
				? Buffer.from(body)
				: Buffer.from(body as ArrayBuffer)
	if (headers?.["Content-Encoding"] === "gzip") {
		return gunzipAsync(buffer)
	}
	return buffer
}

const parseJsonBody = async (body: BodyInit | null | undefined, headers?: Record<string, string>): Promise<any> => {
	return JSON.parse((await decodeJsonBody(body, headers)).toString("utf8"))
}

const acceptedIngestResponseForRequestWith = async (
	init: RequestInit,
	overrides: Record<string, unknown> = {},
): Promise<Response> => {
	const headers = init.headers as Record<string, string> | undefined
	const rawBody = await decodeJsonBody(init.body as BodyInit, headers)
	const payload = JSON.parse(rawBody.toString("utf8"))
	const kind =
		payload.mode === "commit_report"
			? "commit_report"
			: payload.mode === "commit_lifecycle"
				? "commit_lifecycle"
				: "envelope"
	const itemCount =
		payload.mode === "commit_report"
			? (payload.generatedBlocks?.length ?? 0) + (payload.acceptedBlocks?.length ?? 0)
			: payload.mode === "commit_lifecycle"
				? 1
				: Array.isArray(payload.events)
					? payload.events.length
					: 0
	return acceptedIngestResponse({
		kind,
		reportId: payload.reportId,
		insertedEvents: itemCount,
		duplicateEvents: 0,
		payloadSha256: createHash("sha256").update(rawBody).digest("hex"),
		...overrides,
	})
}

const acceptedIngestResponseForRequest = async (_url: string, init: RequestInit): Promise<Response> =>
	acceptedIngestResponseForRequestWith(init)

const buildCommitReport = (overrides: Partial<AiCodeCommitReport> = {}): AiCodeCommitReport => ({
	version: "v2",
	source: "kilocode-ai-code-stats",
	mode: "commit_report",
	semanticsVersion: overrides.semanticsVersion ?? CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
	reportId: overrides.reportId ?? `report-${Math.random().toString(36).slice(2)}`,
	reportGeneratedAt: overrides.reportGeneratedAt ?? Date.now(),
	client: overrides.client ?? { ide: "vscode", machineId: "machine-1" },
	repoRoot: overrides.repoRoot ?? "/workspace/project",
	projectKey: overrides.projectKey ?? "project-key",
	projectName: overrides.projectName ?? "repo",
	gitRemoteUrl: overrides.gitRemoteUrl ?? "https://github.com/example/repo.git",
	gitBranch: overrides.gitBranch ?? "feature/stats",
	commitHash: overrides.commitHash ?? "commit-1",
	previousCommitHash: overrides.previousCommitHash ?? "commit-0",
	commitOccurredAt: overrides.commitOccurredAt ?? Date.now(),
	authorName: overrides.authorName,
	authorEmail: overrides.authorEmail,
	committerName: overrides.committerName,
	committerEmail: overrides.committerEmail,
	acceptedBlocks: overrides.acceptedBlocks ?? [
		{
			eventId: "generated-1",
			generatedBlockId: "generated-1",
			timestamp: Date.now(),
			semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
			sourceType: "agent_insert",
			ide: "vscode",
			projectKey: "project-key",
			projectName: "repo",
			repoRoot: "/workspace/project",
			repoRelativePath: "src/a.ts",
			filePath: "/workspace/project/src/a.ts",
			relativePath: "src/a.ts",
			language: "typescript",
			gitRemoteUrl: "https://github.com/example/repo.git",
			gitBranch: "feature/stats",
			lineStart: 1,
			lineEnd: 1,
			lineCount: 1,
			codeSnippet: "const a = 1",
			fileSnapshotContent: "const a = 1\n",
		},
	],
	generatedBlocks: overrides.generatedBlocks,
	changedFiles: overrides.changedFiles ?? [
		{
			relativePath: "src/a.ts",
			filePath: "/workspace/project/src/a.ts",
			language: "typescript",
			committedSnapshotContent: "const a = 1\n",
			changedBlocks: [
				{
					startLine: 1,
					endLine: 1,
					lineCount: 1,
					codeSnippet: "const a = 1",
					displayOrder: 1,
				},
			],
		},
	],
})

const buildQueuedReport = (overrides: Partial<AiCodeQueuedCommitReport> = {}): AiCodeQueuedCommitReport => ({
	report: overrides.report ?? buildCommitReport(),
	createdAt: overrides.createdAt ?? Date.now(),
	generatedBlockIds: overrides.generatedBlockIds ?? ["generated-1"],
})

const buildLifecycleReport = (overrides: Partial<AiCodeCommitLifecycleReport> = {}): AiCodeCommitLifecycleReport => ({
	version: "v1",
	source: "kilocode-ai-code-stats",
	mode: "commit_lifecycle",
	semanticsVersion: overrides.semanticsVersion ?? CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
	eventId: overrides.eventId ?? "lifecycle-1",
	reportId: overrides.reportId ?? "report-lifecycle-1",
	eventOccurredAt: overrides.eventOccurredAt ?? Date.now(),
	reportedAt: overrides.reportedAt ?? Date.now(),
	client: overrides.client ?? { ide: "vscode", machineId: "machine-1" },
	repoRoot: overrides.repoRoot ?? "/workspace/project",
	projectKey: overrides.projectKey ?? "project-key",
	projectName: overrides.projectName ?? "repo",
	gitRemoteUrl: overrides.gitRemoteUrl ?? "https://github.com/example/repo.git",
	gitBranch: overrides.gitBranch ?? "feature/stats",
	eventType: overrides.eventType ?? "commit_replaced",
	reason: overrides.reason ?? "amend",
	confidence: overrides.confidence ?? "strong",
	oldCommitHash: overrides.oldCommitHash ?? "old-commit",
	newCommitHash: overrides.newCommitHash ?? "new-commit",
	commitHashes: overrides.commitHashes ?? ["old-commit"],
	replacementCommitHashes: overrides.replacementCommitHashes ?? ["new-commit"],
})

const buildQueuedLifecycleReport = (
	overrides: Partial<AiCodeQueuedCommitLifecycleReport> = {},
): AiCodeQueuedCommitLifecycleReport => ({
	report: overrides.report ?? buildLifecycleReport(),
	createdAt: overrides.createdAt ?? Date.now(),
})

const buildIncrementalEvent = (eventId: string, overrides: Partial<AiCodeStatsEvent> = {}): AiCodeStatsEvent => ({
	eventId,
	timestamp: overrides.timestamp ?? Date.now(),
	semanticsVersion: overrides.semanticsVersion ?? CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
	sourceType: overrides.sourceType ?? "agent_insert",
	ide: overrides.ide ?? "vscode",
	metricType: overrides.metricType ?? "generated",
	userEmail: overrides.userEmail,
	projectKey: overrides.projectKey ?? "project-key",
	projectName: overrides.projectName ?? "repo",
	repoRoot: overrides.repoRoot ?? "/workspace/project",
	repoRelativePath: overrides.repoRelativePath ?? "src/incremental.ts",
	filePath: overrides.filePath ?? "/workspace/project/src/incremental.ts",
	relativePath: overrides.relativePath ?? "src/incremental.ts",
	lineStart: overrides.lineStart ?? 1,
	lineEnd: overrides.lineEnd ?? 1,
	lineCount: overrides.lineCount ?? 1,
	codeSnippet: overrides.codeSnippet ?? "const generated = true",
	fileSnapshotContent: overrides.fileSnapshotContent,
	commitOccurredAt: overrides.commitOccurredAt,
})

describe("AiCodeStatsUploader", () => {
	let tmpDir: string
	let store: AiCodeStatsStore
	let uploader: AiCodeStatsUploader
	let unsetRetryFactor: (() => void) | undefined

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-code-stats-uploader-"))
		store = new AiCodeStatsStore(tmpDir)
		uploader = new AiCodeStatsUploader(store)
		unsetRetryFactor = setFetchRetryFactorForTests().unset
	})

	afterEach(() => {
		unsetRetryFactor?.()
		vi.restoreAllMocks()
		vi.unstubAllGlobals()
	})

	it("uploads queued commit reports and acknowledges them in FIFO order", async () => {
		await store.queueCommitReport(
			buildQueuedReport({
				report: buildCommitReport({
					reportId: "report-1",
					commitHash: "commit-1",
					authorName: "Zhang San",
					authorEmail: "zhang.san@example.com",
					committerName: "CI Bot",
					committerEmail: "ci@example.com",
				}),
			}),
		)
		await store.queueCommitReport(
			buildQueuedReport({
				report: buildCommitReport({
					reportId: "report-2",
					commitHash: "commit-2",
					acceptedBlocks: [],
					generatedBlocks: [
						{
							eventId: "generated-2",
							generatedBlockId: "generated-2",
							timestamp: Date.now(),
							sourceType: "agent_insert",
							ide: "vscode",
							projectKey: "project-key",
							projectName: "repo",
							repoRoot: "/workspace/project",
							repoRelativePath: "src/b.ts",
							filePath: "/workspace/project/src/b.ts",
							relativePath: "src/b.ts",
							language: "typescript",
							gitRemoteUrl: "https://github.com/example/repo.git",
							gitBranch: "feature/stats",
							lineStart: 1,
							lineEnd: 1,
							lineCount: 1,
							codeSnippet: "const b = 2",
							fileSnapshotContent: "const b = 2\n",
						},
					],
				}),
				generatedBlockIds: ["generated-2"],
			}),
		)

		const fetchMock = vi.fn(acceptedIngestResponseForRequest)
		vi.stubGlobal("fetch", fetchMock)

		const result = await uploader.uploadQueuedReports({
			enabled: true,
			webhookUrl: "https://example.com/webhook",
			userEmail: "current.user@example.com",
		})

		expect(result).toMatchObject({ uploadedReports: 2, uploadedBlocks: 2 })
		expect(result.rawPayloadBytes).toBeGreaterThan(0)
		expect(result.compressedPayloadBytes).toBeGreaterThan(0)
		expect(result.timeoutMs).toBe(30 * 1000)
		expect(fetchMock.mock.calls).toHaveLength(2)
		expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
			"X-Ai-Code-Stats-Wire-Version": "v3",
			"X-Ai-Code-Stats-Report-Id": "report-1",
			"X-Ai-Code-Stats-Commit-Hash": "commit-1",
		})
		expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty("Content-Encoding")
		const firstBody = await parseJsonBody(
			fetchMock.mock.calls[0][1].body as BodyInit,
			fetchMock.mock.calls[0][1].headers as Record<string, string>,
		)
		expect(firstBody.reportId).toBe("report-1")
		expect(firstBody.version).toBe("v3")
		expect(firstBody).toMatchObject({
			authorName: "Zhang San",
			authorEmail: "zhang.san@example.com",
			committerName: "CI Bot",
			committerEmail: "ci@example.com",
		})
		expect(firstBody.snapshots).toHaveLength(1)
		expect(firstBody.acceptedBlocks[0].fileSnapshotContent).toBeUndefined()
		expect(firstBody.acceptedBlocks[0].fileSnapshotHash).toBe(firstBody.snapshots[0].contentHash)
		expect(firstBody.acceptedBlocks[0].userEmail).toBeUndefined()
		expect(firstBody.defaults.userEmail).toBe("current.user@example.com")
		const secondBody = await parseJsonBody(
			fetchMock.mock.calls[1][1].body as BodyInit,
			fetchMock.mock.calls[1][1].headers as Record<string, string>,
		)
		expect(secondBody.reportId).toBe("report-2")
		expect(secondBody.generatedBlocks[0].fileSnapshotContent).toBeUndefined()
		expect(secondBody.generatedBlocks[0].fileSnapshotHash).toBe(secondBody.snapshots[0].contentHash)
		expect(secondBody.generatedBlocks[0].userEmail).toBeUndefined()
		expect(secondBody.changedFiles[0]).toMatchObject({
			relativePath: "src/a.ts",
			filePath: "/workspace/project/src/a.ts",
			changedBlocks: [
				{
					startLine: 1,
					endLine: 1,
					lineCount: 1,
					codeSnippet: "const a = 1",
					displayOrder: 1,
				},
			],
		})
		expect(secondBody.changedFiles[0].committedSnapshotContent).toBeUndefined()
		expect(await store.getQueuedReportsForTests()).toHaveLength(0)
	})

	it("uploads queued lifecycle reports and acknowledges them", async () => {
		await store.queueCommitLifecycleReport(buildQueuedLifecycleReport())

		const fetchMock = vi.fn(acceptedIngestResponseForRequest)
		vi.stubGlobal("fetch", fetchMock)

		const result = await uploader.uploadQueuedLifecycleReports({
			enabled: true,
			webhookUrl: "https://example.com/webhook",
		})

		expect(result).toMatchObject({ uploadedReports: 1, failedReports: 0 })
		expect(result.rawPayloadBytes).toBeGreaterThan(0)
		expect(fetchMock.mock.calls).toHaveLength(1)
		expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
			"X-Ai-Code-Stats-Wire-Version": "v3",
			"X-Ai-Code-Stats-Report-Id": "report-lifecycle-1",
			"X-Ai-Code-Stats-Commit-Hash": "old-commit",
		})
		const body = await parseJsonBody(
			fetchMock.mock.calls[0][1].body as BodyInit,
			fetchMock.mock.calls[0][1].headers as Record<string, string>,
		)
		expect(body).toMatchObject({
			mode: "commit_lifecycle",
			eventId: "lifecycle-1",
			reportId: "report-lifecycle-1",
			eventType: "commit_replaced",
			reason: "amend",
			confidence: "strong",
			oldCommitHash: "old-commit",
			newCommitHash: "new-commit",
			commitHashes: ["old-commit"],
			replacementCommitHashes: ["new-commit"],
		})
		expect(await store.getQueuedCommitLifecycleReportsForTests()).toHaveLength(0)
	})

	it("does not turn an acknowledged commit report into a failure when success diagnostics cannot persist", async () => {
		await store.queueCommitReport(buildQueuedReport())
		vi.spyOn(store, "appendDiagnosticEvent").mockRejectedValueOnce(new Error("diagnostics disk unavailable"))
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined)
		vi.stubGlobal("fetch", vi.fn(acceptedIngestResponseForRequest))

		const result = await uploader.uploadQueuedReports({
			enabled: true,
			webhookUrl: "https://example.com/webhook",
			userEmail: "current.user@example.com",
		})

		expect(result).toMatchObject({ uploadedReports: 1, failedReports: 0 })
		expect(await store.getQueuedReportsForTests()).toHaveLength(0)
		expect(warnSpy).toHaveBeenCalledWith(
			"[AiCodeStats] Failed to persist upload success diagnostics:",
			expect.objectContaining({ message: "diagnostics disk unavailable" }),
		)
	})

	it("does not turn an acknowledged lifecycle report into a failure when success diagnostics cannot persist", async () => {
		await store.queueCommitLifecycleReport(buildQueuedLifecycleReport())
		vi.spyOn(store, "appendDiagnosticEvent").mockRejectedValueOnce(new Error("diagnostics disk unavailable"))
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined)
		vi.stubGlobal("fetch", vi.fn(acceptedIngestResponseForRequest))

		const result = await uploader.uploadQueuedLifecycleReports({
			enabled: true,
			webhookUrl: "https://example.com/webhook",
		})

		expect(result).toMatchObject({ uploadedReports: 1, failedReports: 0 })
		expect(await store.getQueuedCommitLifecycleReportsForTests()).toHaveLength(0)
		expect(warnSpy).toHaveBeenCalledWith(
			"[AiCodeStats] Failed to persist upload success diagnostics:",
			expect.objectContaining({ message: "diagnostics disk unavailable" }),
		)
	})

	it("bounds automatic lifecycle work so later outboxes receive a turn", async () => {
		for (let index = 1; index <= 3; index += 1) {
			await store.queueCommitLifecycleReport(
				buildQueuedLifecycleReport({
					createdAt: index,
					report: buildLifecycleReport({
						eventId: `lifecycle-budget-${index}`,
						reportId: `report-lifecycle-budget-${index}`,
						oldCommitHash: `old-budget-${index}`,
						newCommitHash: `new-budget-${index}`,
						commitHashes: [`old-budget-${index}`],
						replacementCommitHashes: [`new-budget-${index}`],
					}),
				}),
			)
		}
		const fetchMock = vi.fn(acceptedIngestResponseForRequest)
		vi.stubGlobal("fetch", fetchMock)

		const result = await uploader.uploadQueuedLifecycleReports(
			{
				enabled: true,
				webhookUrl: "https://example.com/webhook",
			},
			{ maxReports: 1, requestRetries: 0 },
		)

		expect(result).toMatchObject({ uploadedReports: 1, failedReports: 0 })
		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect((await store.getQueuedCommitLifecycleReportsForTests()).map((item) => item.report.eventId)).toEqual([
			"lifecycle-budget-2",
			"lifecycle-budget-3",
		])
	})

	it("stops lifecycle work after a global endpoint failure", async () => {
		for (let index = 1; index <= 2; index += 1) {
			await store.queueCommitLifecycleReport(
				buildQueuedLifecycleReport({
					createdAt: index,
					report: buildLifecycleReport({
						eventId: `lifecycle-circuit-${index}`,
						reportId: `report-lifecycle-circuit-${index}`,
					}),
				}),
			)
		}
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response("backend stopped", { status: 503, statusText: "Service Unavailable" }))
		vi.stubGlobal("fetch", fetchMock)

		const result = await uploader.uploadQueuedLifecycleReports(
			{
				enabled: true,
				webhookUrl: "https://example.com/webhook",
			},
			{ requestRetries: 0, stopOnGlobalFailure: true },
		)

		expect(result).toMatchObject({ uploadedReports: 0, failedReports: 1 })
		expect(result.failedReportErrors[0]?.errorCategory).toBe("server_error")
		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(await store.getQueuedCommitLifecycleReportsForTests()).toHaveLength(2)
	})

	it("does not start a lifecycle request after the run deadline", async () => {
		await store.queueCommitLifecycleReport(buildQueuedLifecycleReport())
		const fetchMock = vi.fn(acceptedIngestResponseForRequest)
		vi.stubGlobal("fetch", fetchMock)

		const result = await uploader.uploadQueuedLifecycleReports(
			{
				enabled: true,
				webhookUrl: "https://example.com/webhook",
			},
			{ deadlineAt: Date.now() - 1, requestRetries: 0 },
		)

		expect(result).toMatchObject({ uploadedReports: 0, failedReports: 0 })
		expect(fetchMock).not.toHaveBeenCalled()
		expect(await store.getQueuedCommitLifecycleReportsForTests()).toHaveLength(1)
	})

	it("resumes a commit report using its persisted identity after current settings are cleared", async () => {
		const acceptedBlock = {
			...buildCommitReport().acceptedBlocks![0],
			userEmail: "persisted.user@example.com",
		}
		await store.queueCommitReport(
			buildQueuedReport({
				report: buildCommitReport({
					reportId: "report-persisted-identity",
					commitHash: "commit-persisted-identity",
					acceptedBlocks: [acceptedBlock],
				}),
			}),
		)
		const fetchMock = vi.fn(acceptedIngestResponseForRequest)
		vi.stubGlobal("fetch", fetchMock)

		const result = await uploader.uploadQueuedReports({
			enabled: true,
			webhookUrl: "https://example.com/webhook",
		})

		expect(result).toMatchObject({ uploadedReports: 1, failedReports: 0 })
		const body = await parseJsonBody(
			fetchMock.mock.calls[0][1].body as BodyInit,
			fetchMock.mock.calls[0][1].headers as Record<string, string>,
		)
		expect(body.defaults.userEmail).toBe("persisted.user@example.com")
		expect(await store.getQueuedReportsForTests()).toHaveLength(0)
	})

	it("does not substitute the Git author for a missing enterprise user identity", async () => {
		await store.queueCommitReport(
			buildQueuedReport({
				report: buildCommitReport({
					reportId: "report-author-is-not-enterprise-user",
					commitHash: "commit-author-is-not-enterprise-user",
					authorEmail: "git.author@example.com",
				}),
			}),
		)
		const fetchMock = vi.fn(acceptedIngestResponseForRequest)
		vi.stubGlobal("fetch", fetchMock)

		const result = await uploader.uploadQueuedReports({
			enabled: true,
			webhookUrl: "https://example.com/webhook",
		})

		expect(result).toMatchObject({ uploadedReports: 0, failedReports: 1 })
		expect(result.failedReportErrors[0]?.message).toContain("no persisted user email")
		expect(fetchMock).not.toHaveBeenCalled()
		expect(await store.getQueuedReportsForTests()).toHaveLength(1)
	})

	it("uploads unrelated lifecycle reports while a commit-specific lifecycle remains blocked", async () => {
		await store.queueCommitLifecycleReport(buildQueuedLifecycleReport())
		await store.queueCommitLifecycleReport(
			buildQueuedLifecycleReport({
				report: buildLifecycleReport({
					eventId: "lifecycle-unrelated",
					reportId: "report-lifecycle-unrelated",
					oldCommitHash: "old-unrelated",
					newCommitHash: "new-unrelated",
					commitHashes: ["old-unrelated"],
					replacementCommitHashes: ["new-unrelated"],
				}),
			}),
		)
		await store.queueCommitLifecycleReport(
			buildQueuedLifecycleReport({
				report: buildLifecycleReport({
					eventId: "lifecycle-same-hash-other-repo",
					reportId: "report-lifecycle-same-hash-other-repo",
					repoRoot: "/workspace/other-project",
				}),
			}),
		)

		const uploadedEventIds: string[] = []
		const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
			const body = await parseJsonBody(
				init?.body as BodyInit,
				init?.headers as Record<string, string> | undefined,
			)
			uploadedEventIds.push(body.eventId)
			return acceptedIngestResponseForRequestWith(init!, {
				kind: "commit_lifecycle",
				reportId: body.reportId,
				insertedEvents: 1,
				duplicateEvents: 0,
			})
		})
		vi.stubGlobal("fetch", fetchMock)

		const result = await uploader.uploadQueuedLifecycleReports(
			{
				enabled: true,
				webhookUrl: "https://example.com/webhook",
				userEmail: "current.user@example.com",
			},
			{ blockedRepoCommitKeys: new Set([buildRepoCommitKey("/workspace/project", "new-commit")]) },
		)

		expect(result).toMatchObject({ uploadedReports: 2, failedReports: 0 })
		expect(uploadedEventIds.sort()).toEqual(["lifecycle-same-hash-other-repo", "lifecycle-unrelated"])
		expect((await store.getQueuedCommitLifecycleReportsForTests()).map((item) => item.report.eventId)).toEqual([
			"lifecycle-1",
		])
	})

	it("uploads standalone generated events from the local queue", async () => {
		const event: AiCodeStatsEvent = {
			eventId: "event-1",
			timestamp: Date.now(),
			semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
			sourceType: "agent_insert",
			ide: "goland",
			metricType: "generated",
			projectKey: "project-key",
			projectName: "repo",
			repoRoot: "/workspace/project",
			repoRelativePath: "src/rejected.ts",
			filePath: "/workspace/project/src/rejected.ts",
			relativePath: "src/rejected.ts",
			lineStart: 2,
			lineEnd: 2,
			lineCount: 1,
			codeSnippet: "const rejected = true",
		}
		await store.appendEvent(event)

		const fetchMock = vi.fn(acceptedIngestResponseForRequest)
		vi.stubGlobal("fetch", fetchMock)

		const result = await uploader.upload(
			{ enabled: true, webhookUrl: "https://example.com/webhook", userEmail: "current.user@example.com" },
			{ client: { ide: "goland", machineId: "machine-1" } },
		)

		expect(result).toEqual({ uploaded: 1 })
		expect(fetchMock.mock.calls).toHaveLength(1)
		const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string)
		expect(body.mode).toBe("incremental")
		expect(body.client.ide).toBe("goland")
		expect(body.events).toHaveLength(1)
		expect(body.events[0]).toMatchObject({
			eventId: "event-1",
			ide: "goland",
			sourceType: "agent_insert",
			metricType: "generated",
			userEmail: "current.user@example.com",
			relativePath: "src/rejected.ts",
		})
		expect(body.events[0]).not.toHaveProperty("workspaceName")
		expect(body.events[0]).not.toHaveProperty("workspacePath")
		expect(await store.getPendingEvents()).toHaveLength(0)
	})

	it("limits each incremental request and leaves the remaining events queued", async () => {
		const now = Date.now()
		await store.appendEvents(
			["event-batch-1", "event-batch-2", "event-batch-3"].map(
				(eventId, index): AiCodeStatsEvent => ({
					eventId,
					timestamp: now + index,
					semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
					sourceType: "agent_insert",
					ide: "vscode",
					metricType: "generated",
					projectKey: "project-key",
					projectName: "repo",
					repoRoot: "/workspace/project",
					repoRelativePath: "src/batch.ts",
					filePath: "/workspace/project/src/batch.ts",
					relativePath: "src/batch.ts",
					lineStart: index + 1,
					lineEnd: index + 1,
					lineCount: 1,
					codeSnippet: `const value${index} = true`,
				}),
			),
		)
		const uploadedEventIds: string[] = []
		const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body))
			uploadedEventIds.push(...body.events.map((event: AiCodeStatsEvent) => event.eventId))
			return acceptedIngestResponseForRequestWith(init!, {
				kind: "envelope",
				insertedEvents: body.events.length,
				duplicateEvents: 0,
			})
		})
		vi.stubGlobal("fetch", fetchMock)

		const result = await uploader.upload(
			{ enabled: true, webhookUrl: "https://example.com/webhook", userEmail: "current.user@example.com" },
			{ client: { ide: "vscode", machineId: "machine-1" }, maxEvents: 2 },
		)

		expect(result).toEqual({ uploaded: 2 })
		expect(uploadedEventIds).toEqual(["event-batch-1", "event-batch-2"])
		expect((await store.getPendingEvents()).map((event) => event.eventId)).toEqual(["event-batch-3"])
	})

	it("never sends more than the server limit of 1000 incremental events", async () => {
		const now = Date.now()
		await store.appendEvents(
			Array.from({ length: 1001 }, (_, index) =>
				buildIncrementalEvent(`event-server-cap-${String(index).padStart(4, "0")}`, {
					timestamp: now + index,
				}),
			),
		)
		const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body))
			return acceptedIngestResponseForRequestWith(init!, {
				kind: "envelope",
				insertedEvents: body.events.length,
				duplicateEvents: 0,
			})
		})
		vi.stubGlobal("fetch", fetchMock)

		const result = await uploader.upload(
			{ enabled: true, webhookUrl: "https://example.com/webhook", userEmail: "current.user@example.com" },
			{
				client: { ide: "vscode", machineId: "machine-1" },
				maxEvents: 2000,
			},
		)

		expect(result).toEqual({ uploaded: 1000 })
		const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string)
		expect(body.events).toHaveLength(1000)
		expect((await store.getPendingEvents()).map((event) => event.eventId)).toEqual(["event-server-cap-1000"])
	})

	it("batches against the complete serialized incremental envelope", async () => {
		const now = Date.now()
		await store.appendEvents([
			buildIncrementalEvent("event-envelope-1", {
				timestamp: now,
				codeSnippet: "a".repeat(2048),
			}),
			buildIncrementalEvent("event-envelope-2", {
				timestamp: now + 1,
				codeSnippet: "b".repeat(2048),
			}),
		])
		const uploadedBodies: Array<{ events: AiCodeStatsEvent[] }> = []
		const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body))
			uploadedBodies.push(body)
			return acceptedIngestResponseForRequestWith(init!, {
				kind: "envelope",
				insertedEvents: body.events.length,
				duplicateEvents: 0,
			})
		})
		vi.stubGlobal("fetch", fetchMock)

		const context = {
			client: { ide: "vscode" as const, machineId: "machine-1" },
			maxEnvelopeBytes: 4096,
		}
		expect(
			await uploader.upload(
				{ enabled: true, webhookUrl: "https://example.com/webhook", userEmail: "current.user@example.com" },
				context,
			),
		).toEqual({ uploaded: 1 })
		expect(Buffer.byteLength(JSON.stringify(uploadedBodies[0]), "utf8")).toBeLessThanOrEqual(4096)
		expect(uploadedBodies[0].events.map((event) => event.eventId)).toEqual(["event-envelope-1"])

		expect(
			await uploader.upload(
				{ enabled: true, webhookUrl: "https://example.com/webhook", userEmail: "current.user@example.com" },
				context,
			),
		).toEqual({ uploaded: 1 })
		expect(uploadedBodies[1].events.map((event) => event.eventId)).toEqual(["event-envelope-2"])
		expect(await store.getPendingEvents()).toHaveLength(0)
	})

	it("isolates an oversized incremental event without blocking later valid events", async () => {
		const now = Date.now()
		await store.appendEvents([
			buildIncrementalEvent("event-oversized-snippet", {
				timestamp: now,
				codeSnippet: "x".repeat(8 * 1024 * 1024 + 1),
			}),
			buildIncrementalEvent("event-after-oversized-snippet", {
				timestamp: now + 1,
			}),
		])
		const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body))
			expect(body.events.map((event: AiCodeStatsEvent) => event.eventId)).toEqual([
				"event-after-oversized-snippet",
			])
			return acceptedIngestResponseForRequestWith(init!, {
				kind: "envelope",
				insertedEvents: 1,
				duplicateEvents: 0,
			})
		})
		vi.stubGlobal("fetch", fetchMock)

		expect(
			await uploader.upload(
				{ enabled: true, webhookUrl: "https://example.com/webhook", userEmail: "current.user@example.com" },
				{ client: { ide: "vscode", machineId: "machine-1" } },
			),
		).toMatchObject({
			uploaded: 1,
			blockedEvents: [
				expect.objectContaining({
					eventId: "event-oversized-snippet",
					category: "invalid_local_payload",
					retryable: false,
				}),
			],
		})
		expect((await store.getPendingEvents()).map((event) => event.eventId)).toEqual(["event-oversized-snippet"])
	})

	it("does not let a legacy event without identity block later persisted-identity events", async () => {
		const now = Date.now()
		const baseEvent: Omit<AiCodeStatsEvent, "eventId" | "timestamp" | "userEmail"> = {
			semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
			sourceType: "agent_insert",
			ide: "vscode",
			metricType: "generated",
			projectKey: "project-key",
			projectName: "repo",
			repoRoot: "/workspace/project",
			repoRelativePath: "src/batch.ts",
			filePath: "/workspace/project/src/batch.ts",
			relativePath: "src/batch.ts",
			lineStart: 1,
			lineEnd: 1,
			lineCount: 1,
			codeSnippet: "const value = true",
		}
		await store.appendEvents([
			{ ...baseEvent, eventId: "legacy-without-identity", timestamp: now },
			{
				...baseEvent,
				eventId: "persisted-identity",
				timestamp: now + 1,
				userEmail: "persisted.user@example.com",
			},
		])
		const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body))
			expect(body.events.map((event: AiCodeStatsEvent) => event.eventId)).toEqual(["persisted-identity"])
			return acceptedIngestResponseForRequestWith(init!, {
				kind: "envelope",
				insertedEvents: body.events.length,
				duplicateEvents: 0,
			})
		})
		vi.stubGlobal("fetch", fetchMock)

		const result = await uploader.upload(
			{ enabled: true, webhookUrl: "https://example.com/webhook" },
			{ client: { ide: "vscode", machineId: "machine-1" }, maxEvents: 1 },
		)

		expect(result).toMatchObject({
			uploaded: 1,
			blockedEvents: [
				expect.objectContaining({
					eventId: "legacy-without-identity",
					category: "missing_identity",
					retryable: true,
				}),
			],
		})
		expect((await store.getPendingEvents()).map((event) => event.eventId)).toEqual(["legacy-without-identity"])
	})

	it("persists a missing-identity block and retries it after user configuration is supplied", async () => {
		await store.appendEvent(
			buildIncrementalEvent("identity-config-retry", {
				userEmail: undefined,
			}),
		)
		const fetchMock = vi.fn(acceptedIngestResponseForRequest)
		vi.stubGlobal("fetch", fetchMock)

		const blocked = await uploader.upload(
			{ enabled: true, webhookUrl: "https://example.com/webhook" },
			{ client: { ide: "vscode", machineId: "machine-1" } },
		)

		expect(blocked).toMatchObject({
			uploaded: 0,
			blockedEvents: [
				expect.objectContaining({
					eventId: "identity-config-retry",
					category: "missing_identity",
					retryable: true,
				}),
			],
		})
		expect(fetchMock).not.toHaveBeenCalled()
		expect((await store.getRawStateForTests()).blockedEvents).toMatchObject({
			"identity-config-retry": expect.objectContaining({
				category: "missing_identity",
				retryable: true,
			}),
		})
		expect(await new AiCodeStatsStore(tmpDir).getBlockedEvents()).toEqual([
			expect.objectContaining({
				eventId: "identity-config-retry",
				category: "missing_identity",
				retryable: true,
			}),
		])

		expect(
			await uploader.upload(
				{
					enabled: true,
					webhookUrl: "https://example.com/webhook",
					userEmail: "configured.user@example.com",
				},
				{ client: { ide: "vscode", machineId: "machine-1" } },
			),
		).toMatchObject({ uploaded: 1 })
		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(await store.getPendingEvents()).toHaveLength(0)
		expect((await store.getRawStateForTests()).blockedEvents).toEqual({})
	})

	it("never replaces a valid persisted event identity with a different current configuration", async () => {
		await store.appendEvent(
			buildIncrementalEvent("persisted-identity-wins", {
				userEmail: "owner.a@example.com",
			}),
		)
		const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body))
			expect(body.events).toHaveLength(1)
			expect(body.events[0].userEmail).toBe("owner.a@example.com")
			return acceptedIngestResponseForRequestWith(init!, {
				kind: "envelope",
				insertedEvents: 1,
				duplicateEvents: 0,
			})
		})
		vi.stubGlobal("fetch", fetchMock)

		expect(
			await uploader.upload(
				{
					enabled: true,
					webhookUrl: "https://example.com/webhook",
					userEmail: "owner.b@example.com",
				},
				{ client: { ide: "vscode", machineId: "machine-1" } },
			),
		).toEqual({ uploaded: 1 })
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it("does not let an invalid persisted email poison later incremental events", async () => {
		const now = Date.now()
		await store.appendEvents([
			buildIncrementalEvent("invalid-email", {
				timestamp: now,
				userEmail: "not-an-email",
			}),
			buildIncrementalEvent("valid-after-invalid-email", {
				timestamp: now + 1,
				userEmail: "valid.user@example.com",
			}),
		])
		const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body))
			expect(body.events.map((event: AiCodeStatsEvent) => event.eventId)).toEqual(["valid-after-invalid-email"])
			return acceptedIngestResponseForRequestWith(init!, {
				kind: "envelope",
				insertedEvents: 1,
				duplicateEvents: 0,
			})
		})
		vi.stubGlobal("fetch", fetchMock)

		expect(
			await uploader.upload(
				{
					enabled: true,
					webhookUrl: "https://example.com/webhook",
					userEmail: "different.current@example.com",
				},
				{ client: { ide: "vscode", machineId: "machine-1" } },
			),
		).toMatchObject({
			uploaded: 1,
			blockedEvents: [
				expect.objectContaining({
					eventId: "invalid-email",
					category: "invalid_identity",
					retryable: false,
				}),
			],
		})
		expect((await store.getPendingEvents()).map((event) => event.eventId)).toEqual(["invalid-email"])
	})

	it.each([
		["event timestamp", { timestamp: Date.parse("1000-01-01T00:00:00.000Z") }],
		[
			"commit timestamp",
			{
				timestamp: Date.now(),
				commitOccurredAt: Date.parse("1000-01-01T00:00:00.000Z"),
			},
		],
	])("does not let an invalid persisted %s poison later incremental events", async (_label, invalidTimes) => {
		const now = Date.now()
		await store.appendEvents([
			buildIncrementalEvent("invalid-database-timestamp", {
				...invalidTimes,
				userEmail: "valid.user@example.com",
			}),
			buildIncrementalEvent("valid-after-invalid-database-timestamp", {
				timestamp: now,
				userEmail: "valid.user@example.com",
			}),
		])
		const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body))
			expect(body.events.map((event: AiCodeStatsEvent) => event.eventId)).toEqual([
				"valid-after-invalid-database-timestamp",
			])
			return acceptedIngestResponseForRequestWith(init!, {
				kind: "envelope",
				insertedEvents: 1,
				duplicateEvents: 0,
			})
		})
		vi.stubGlobal("fetch", fetchMock)

		expect(
			await uploader.upload(
				{ enabled: true, webhookUrl: "https://example.com/webhook" },
				{ client: { ide: "vscode", machineId: "machine-1" } },
			),
		).toMatchObject({
			uploaded: 1,
			blockedEvents: [
				expect.objectContaining({
					eventId: "invalid-database-timestamp",
					category: "invalid_local_payload",
					retryable: false,
				}),
			],
		})
		expect((await store.getPendingEvents()).map((event) => event.eventId)).toEqual(["invalid-database-timestamp"])
	})

	it("keeps a permanent invalid block stable across later automatic scans", async () => {
		await store.appendEvent(
			buildIncrementalEvent("permanently-invalid-timestamp", {
				timestamp: Date.parse("1000-01-01T00:00:00.000Z"),
				userEmail: "valid.user@example.com",
			}),
		)
		const fetchMock = vi.fn()
		vi.stubGlobal("fetch", fetchMock)
		const settings = { enabled: true, webhookUrl: "https://example.com/webhook" }
		const context = { client: { ide: "vscode" as const, machineId: "machine-1" } }

		expect(await uploader.upload(settings, context)).toMatchObject({
			uploaded: 0,
			blockedEvents: [
				expect.objectContaining({
					eventId: "permanently-invalid-timestamp",
					category: "invalid_local_payload",
					retryable: false,
				}),
			],
		})
		const firstBlock = (await store.getRawStateForTests()).blockedEvents?.["permanently-invalid-timestamp"]
		expect(firstBlock).toBeTruthy()

		expect(await uploader.upload(settings, context)).toMatchObject({ uploaded: 0 })
		expect((await store.getRawStateForTests()).blockedEvents?.["permanently-invalid-timestamp"]).toEqual(firstBlock)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it("persists a single-event envelope block and clears it when the next request has room", async () => {
		await store.appendEvent(
			buildIncrementalEvent("single-envelope-too-large", {
				userEmail: "valid.user@example.com",
				codeSnippet: "const envelope = true",
			}),
		)
		const fetchMock = vi.fn(acceptedIngestResponseForRequest)
		vi.stubGlobal("fetch", fetchMock)

		const blocked = await uploader.upload(
			{ enabled: true, webhookUrl: "https://example.com/webhook" },
			{ client: { ide: "vscode", machineId: "machine-1" }, maxEnvelopeBytes: 1 },
		)

		expect(blocked).toMatchObject({
			uploaded: 0,
			blockedEvents: [
				expect.objectContaining({
					eventId: "single-envelope-too-large",
					category: "payload_too_large",
					retryable: true,
				}),
			],
		})
		expect(fetchMock).not.toHaveBeenCalled()

		expect(
			await uploader.upload(
				{ enabled: true, webhookUrl: "https://example.com/webhook" },
				{ client: { ide: "vscode", machineId: "machine-1" } },
			),
		).toMatchObject({ uploaded: 1 })
		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect((await store.getRawStateForTests()).blockedEvents).toEqual({})
	})

	it("uses a size-aware timeout for incremental envelopes", async () => {
		await store.appendEvent(
			buildIncrementalEvent("incremental-size-aware-timeout", {
				userEmail: "valid.user@example.com",
			}),
		)
		const timeoutSpy = vi.spyOn(AbortSignal, "timeout")
		vi.stubGlobal("fetch", vi.fn(acceptedIngestResponseForRequest))

		await uploader.upload(
			{ enabled: true, webhookUrl: "https://example.com/webhook" },
			{ client: { ide: "vscode", machineId: "machine-1" } },
		)

		expect(timeoutSpy).toHaveBeenCalledWith(30_000)
	})

	it("does not upload client-side committed events from the local queue", async () => {
		await store.appendEvent({
			eventId: "client-committed",
			timestamp: Date.now(),
			semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
			sourceType: "agent_insert",
			ide: "vscode",
			metricType: "committed",
			projectKey: "project-key",
			projectName: "repo",
			repoRoot: "/workspace/project",
			repoRelativePath: "src/a.ts",
			filePath: "/workspace/project/src/a.ts",
			relativePath: "src/a.ts",
			lineStart: 1,
			lineEnd: 1,
			lineCount: 1,
			codeSnippet: "const committed = true",
		} as any)

		const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }))
		vi.stubGlobal("fetch", fetchMock)

		const result = await uploader.upload(
			{ enabled: true, webhookUrl: "https://example.com/webhook", userEmail: "current.user@example.com" },
			{ client: { ide: "vscode", machineId: "machine-1" } },
		)

		expect(result).toEqual({ uploaded: 0 })
		expect(fetchMock).not.toHaveBeenCalled()
		expect(await store.getPendingEvents()).toHaveLength(0)
	})

	it("keeps standalone events pending when a 200 response rejects the ingest", async () => {
		await store.appendEvent({
			eventId: "event-business-failed",
			timestamp: Date.now(),
			semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
			sourceType: "agent_insert",
			ide: "vscode",
			metricType: "generated",
			projectKey: "project-key",
			projectName: "repo",
			repoRoot: "/workspace/project",
			repoRelativePath: "src/rejected.ts",
			filePath: "/workspace/project/src/rejected.ts",
			relativePath: "src/rejected.ts",
			lineStart: 2,
			lineEnd: 2,
			lineCount: 1,
			codeSnippet: "const rejected = true",
		})

		const fetchMock = vi
			.fn()
			.mockImplementation(() => Promise.resolve(rejectedIngestResponse({ msg: "gzip payload解压失败" })))
		vi.stubGlobal("fetch", fetchMock)

		await expect(
			uploader.upload(
				{ enabled: true, webhookUrl: "https://example.com/webhook", userEmail: "current.user@example.com" },
				{ client: { ide: "vscode", machineId: "machine-1" } },
			),
		).rejects.toThrow("gzip payload解压失败")
		expect(await store.getPendingEvents()).toHaveLength(1)
	})

	it("keeps queued commit reports when a 200 response rejects the ingest", async () => {
		await store.queueCommitReport(
			buildQueuedReport({
				report: buildCommitReport({
					reportId: "report-business-failed",
					commitHash: "commit-business-failed",
				}),
			}),
		)

		const fetchMock = vi
			.fn()
			.mockImplementation(() => Promise.resolve(rejectedIngestResponse({ msg: "gzip payload解压失败" })))
		vi.stubGlobal("fetch", fetchMock)

		const result = await uploader.uploadQueuedReports({
			enabled: true,
			webhookUrl: "https://example.com/webhook",
			userEmail: "current.user@example.com",
		})

		expect(result).toMatchObject({
			uploadedReports: 0,
			uploadedBlocks: 0,
			failedReports: 1,
		})
		expect(result.failedReportErrors[0]).toMatchObject({
			reportId: "report-business-failed",
			commitHash: "commit-business-failed",
			message: expect.stringContaining("gzip payload解压失败"),
		})
		expect(await store.getQueuedReportsForTests()).toHaveLength(1)
	})

	it.each([
		[
			"the wrong route kind",
			{
				accepted: true,
				kind: "webhook_test",
				reportId: "report-ack-strict",
				insertedEvents: 2,
				duplicateEvents: 0,
			},
		],
		[
			"another report id",
			{
				accepted: true,
				kind: "commit_report",
				reportId: "report-other",
				insertedEvents: 2,
				duplicateEvents: 0,
			},
		],
		[
			"the wrong event count",
			{
				accepted: true,
				kind: "commit_report",
				reportId: "report-ack-strict",
				insertedEvents: 0,
				duplicateEvents: 0,
			},
		],
		[
			"no request digest",
			{
				accepted: true,
				kind: "commit_report",
				reportId: "report-ack-strict",
				insertedEvents: 2,
				duplicateEvents: 0,
			},
		],
		[
			"another request digest",
			{
				accepted: true,
				kind: "commit_report",
				reportId: "report-ack-strict",
				insertedEvents: 2,
				duplicateEvents: 0,
				payloadSha256: "0".repeat(64),
			},
		],
	])("keeps a commit report queued when a 2xx acknowledgement names %s", async (_label, acknowledgement) => {
		await store.queueCommitReport(
			buildQueuedReport({
				report: buildCommitReport({
					reportId: "report-ack-strict",
					commitHash: "commit-ack-strict",
				}),
			}),
		)
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify(acknowledgement), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			),
		)

		const result = await uploader.uploadQueuedReports({
			enabled: true,
			webhookUrl: "https://example.com/webhook",
			userEmail: "current.user@example.com",
		})

		expect(result).toMatchObject({ uploadedReports: 0, failedReports: 1 })
		expect(result.failedReportErrors[0]?.message).toContain("acknowledgement")
		expect(await store.getQueuedReportsForTests()).toHaveLength(1)
	})

	it("keeps a lifecycle report queued when its acknowledgement names another report", async () => {
		await store.queueCommitLifecycleReport(buildQueuedLifecycleReport())
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				acceptedIngestResponse({
					kind: "commit_lifecycle",
					reportId: "another-lifecycle-report",
					insertedEvents: 1,
					duplicateEvents: 0,
				}),
			),
		)

		const result = await uploader.uploadQueuedLifecycleReports({
			enabled: true,
			webhookUrl: "https://example.com/webhook",
		})

		expect(result).toMatchObject({ uploadedReports: 0, failedReports: 1 })
		expect(result.failedReportErrors[0]?.message).toContain("acknowledgement reportId")
		expect(await store.getQueuedCommitLifecycleReportsForTests()).toHaveLength(1)
	})

	it("keeps a lifecycle report queued when its acknowledgement has the wrong event count", async () => {
		await store.queueCommitLifecycleReport(buildQueuedLifecycleReport())
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				acceptedIngestResponse({
					kind: "commit_lifecycle",
					reportId: "report-lifecycle-1",
					insertedEvents: 0,
					duplicateEvents: 0,
				}),
			),
		)

		const result = await uploader.uploadQueuedLifecycleReports({
			enabled: true,
			webhookUrl: "https://example.com/webhook",
		})

		expect(result).toMatchObject({ uploadedReports: 0, failedReports: 1 })
		expect(result.failedReportErrors[0]?.message).toContain("acknowledgement event count")
		expect(await store.getQueuedCommitLifecycleReportsForTests()).toHaveLength(1)
	})

	it("isolates an overlong lifecycle branch without blocking a later report", async () => {
		await store.queueCommitLifecycleReport(
			buildQueuedLifecycleReport({
				createdAt: 1,
				report: buildLifecycleReport({
					eventId: "lifecycle-overlong-branch",
					reportId: "report-overlong-branch",
					gitBranch: "x".repeat(256),
				}),
			}),
		)
		await store.queueCommitLifecycleReport(
			buildQueuedLifecycleReport({
				createdAt: 2,
				report: buildLifecycleReport({
					eventId: "lifecycle-valid-after-overlong",
					reportId: "report-valid-after-overlong",
				}),
			}),
		)
		const fetchMock = vi.fn(acceptedIngestResponseForRequest)
		vi.stubGlobal("fetch", fetchMock)

		const result = await uploader.uploadQueuedLifecycleReports({
			enabled: true,
			webhookUrl: "https://example.com/webhook",
		})

		expect(result).toMatchObject({ uploadedReports: 1, failedReports: 1 })
		expect(result.failedReportErrors[0]).toMatchObject({
			reportId: "report-overlong-branch",
			message: expect.stringContaining("branch exceeds"),
		})
		expect(fetchMock).toHaveBeenCalledTimes(1)
		const remaining = await store.getQueuedCommitLifecycleReportsForTests()
		expect(remaining.map((item) => item.report.eventId)).toEqual(["lifecycle-overlong-branch"])
		expect(remaining[0].blockedReason).toContain("branch exceeds")

		expect(
			await uploader.uploadQueuedLifecycleReports({
				enabled: true,
				webhookUrl: "https://example.com/webhook",
			}),
		).toMatchObject({ uploadedReports: 0, failedReports: 0 })
		expect(fetchMock).toHaveBeenCalledTimes(1)

		expect(
			await uploader.uploadQueuedLifecycleReports(
				{
					enabled: true,
					webhookUrl: "https://example.com/webhook",
				},
				{ eventId: "lifecycle-overlong-branch" },
			),
		).toMatchObject({ uploadedReports: 0, failedReports: 1 })
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it.each([
		[
			"reportId",
			(report: AiCodeCommitLifecycleReport) => {
				report.reportId = "x".repeat(129)
			},
		],
		[
			"repoRoot",
			(report: AiCodeCommitLifecycleReport) => {
				report.repoRoot = `/${"x".repeat(4096)}`
			},
		],
		[
			"oldCommitHash",
			(report: AiCodeCommitLifecycleReport) => {
				report.oldCommitHash = "x".repeat(129)
			},
		],
		[
			"client machineId",
			(report: AiCodeCommitLifecycleReport) => {
				report.client = { ide: "vscode", machineId: "x".repeat(129) }
			},
		],
	])("rejects an overlong lifecycle %s before serialization", (_label, corrupt) => {
		const report = buildLifecycleReport()
		corrupt(report)
		expect(() => (uploader as any).assertLifecyclePayloadWithinServerLimits(report)).toThrow("exceeds")
	})

	it("blocks a persisted lifecycle report above the atomic hash limit before upload", async () => {
		await store.queueCommitLifecycleReport(
			buildQueuedLifecycleReport({
				report: buildLifecycleReport({
					eventId: "lifecycle-too-many-hashes",
					reportId: "report-too-many-hashes",
					commitHashes: Array.from({ length: 32_769 }, (_, index) => `old-${index}`),
					replacementCommitHashes: [],
					newCommitHash: undefined,
				}),
			}),
		)
		const fetchMock = vi.fn(acceptedIngestResponseForRequest)
		vi.stubGlobal("fetch", fetchMock)

		const result = await uploader.uploadQueuedLifecycleReports({
			enabled: true,
			webhookUrl: "https://example.com/webhook",
		})

		expect(result).toMatchObject({ uploadedReports: 0, failedReports: 1 })
		expect(result.failedReportErrors[0]).toMatchObject({
			errorCategory: "invalid_local_payload",
			message: expect.stringContaining("32768 hashes"),
		})
		expect(fetchMock).not.toHaveBeenCalled()
		expect((await store.getQueuedCommitLifecycleReportsForTests())[0].blockedReason).toContain("32768 hashes")
	})

	it.each([
		["the webhook-test route", { accepted: true, kind: "webhook_test", insertedEvents: 0, duplicateEvents: 0 }],
		["the wrong event count", { accepted: true, kind: "envelope", insertedEvents: 0, duplicateEvents: 0 }],
		["no request digest", { accepted: true, kind: "envelope", insertedEvents: 1, duplicateEvents: 0 }],
		[
			"another request digest",
			{
				accepted: true,
				kind: "envelope",
				insertedEvents: 1,
				duplicateEvents: 0,
				payloadSha256: "f".repeat(64),
			},
		],
	])("keeps incremental events pending when a 2xx acknowledgement names %s", async (_label, acknowledgement) => {
		await store.appendEvent({
			eventId: "event-ack-strict",
			timestamp: Date.now(),
			semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
			sourceType: "agent_insert",
			ide: "vscode",
			metricType: "generated",
			userEmail: "current.user@example.com",
			projectKey: "project-key",
			projectName: "repo",
			repoRoot: "/workspace/project",
			repoRelativePath: "src/ack.ts",
			filePath: "/workspace/project/src/ack.ts",
			relativePath: "src/ack.ts",
			lineStart: 1,
			lineEnd: 1,
			lineCount: 1,
			codeSnippet: "const ack = true",
		})
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify(acknowledgement), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			),
		)

		await expect(
			uploader.upload(
				{ enabled: true, webhookUrl: "https://example.com/webhook" },
				{ client: { ide: "vscode", machineId: "machine-1" } },
			),
		).rejects.toThrow("acknowledgement")
		expect(await store.getPendingEvents()).toHaveLength(1)
	})

	it("keeps queued commit reports frozen when upload fails and retries them later", async () => {
		await store.queueCommitReport(
			buildQueuedReport({
				report: buildCommitReport({
					reportId: "report-retry",
					commitHash: "commit-retry",
				}),
			}),
		)

		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response("fail", { status: 400, statusText: "bad request" }))
			.mockImplementationOnce(acceptedIngestResponseForRequest)
		vi.stubGlobal("fetch", fetchMock)

		const failedResult = await uploader.uploadQueuedReports({
			enabled: true,
			webhookUrl: "https://example.com/webhook",
			userEmail: "current.user@example.com",
		})
		expect(failedResult).toMatchObject({
			uploadedReports: 0,
			uploadedBlocks: 0,
			failedReports: 1,
		})
		expect(failedResult.failedReportErrors[0]).toMatchObject({
			reportId: "report-retry",
			commitHash: "commit-retry",
			encoding: "identity",
			message: expect.stringContaining("400"),
		})
		expect(await store.getQueuedReportsForTests()).toHaveLength(1)

		const retryResult = await uploader.uploadQueuedReports({
			enabled: true,
			webhookUrl: "https://example.com/webhook",
			userEmail: "current.user@example.com",
		})
		expect(retryResult).toMatchObject({ uploadedReports: 1, uploadedBlocks: 1 })
		expect(await store.getQueuedReportsForTests()).toHaveLength(0)
		expect(fetchMock.mock.calls).toHaveLength(2)
	})

	it("rejects commit payloads above the server raw or wire limits before upload", () => {
		const validate = (prepared: { rawPayloadBytes: number; compressedPayloadBytes: number }) =>
			(uploader as any).assertPreparedPayloadWithinServerLimits(prepared)

		expect(() =>
			validate({
				rawPayloadBytes: 256 * 1024 * 1024 + 1,
				compressedPayloadBytes: 1,
			}),
		).toThrow("raw bytes")
		expect(() =>
			validate({
				rawPayloadBytes: 1,
				compressedPayloadBytes: 128 * 1024 * 1024 + 1,
			}),
		).toThrow("wire bytes")
	})

	it.each(["payload_too_large", "invalid_local_payload"])(
		"does not auto-retry a report frozen as %s but allows a targeted retry",
		async (lastErrorCategory) => {
			const queued = buildQueuedReport({
				report: buildCommitReport({
					reportId: "report-frozen",
					commitHash: "commit-frozen",
				}),
			})
			await store.queueCommitReport(queued)
			await store.upsertCommitUploadRecord({
				reportId: queued.report.reportId,
				commitHash: queued.report.commitHash,
				repoRoot: queued.report.repoRoot,
				status: "upload_failed",
				lastErrorCategory,
			})
			const fetchMock = vi.fn(acceptedIngestResponseForRequest)
			vi.stubGlobal("fetch", fetchMock)
			const settings = {
				enabled: true,
				webhookUrl: "https://example.com/webhook",
				userEmail: "current.user@example.com",
			}

			expect(await uploader.uploadQueuedReports(settings)).toMatchObject({
				uploadedReports: 0,
				failedReports: 0,
			})
			expect(fetchMock).not.toHaveBeenCalled()
			expect(await store.getQueuedReportsForTests()).toHaveLength(1)

			expect(
				await uploader.uploadQueuedReports(settings, {
					reportId: queued.report.reportId,
				}),
			).toMatchObject({ uploadedReports: 1, failedReports: 0 })
			expect(fetchMock).toHaveBeenCalledTimes(1)
			expect(await store.getQueuedReportsForTests()).toHaveLength(0)
		},
	)

	it.each([
		[
			"top-level commit time",
			(report: AiCodeCommitReport) => {
				report.commitOccurredAt = Date.parse("1000-01-01T00:00:00.000Z")
			},
		],
		[
			"baseline time",
			(report: AiCodeCommitReport) => {
				report.acceptedBlocks![0].timestamp = Date.parse("1000-01-01T00:00:00.000Z")
			},
		],
		[
			"candidate source time",
			(report: AiCodeCommitReport) => {
				report.candidateLines![0].sourceTimestamp = Date.parse("1000-01-01T00:00:00.000Z")
			},
		],
		[
			"client field length",
			(report: AiCodeCommitReport) => {
				report.client.machineId = "x".repeat(129)
			},
		],
		[
			"changed-file path length",
			(report: AiCodeCommitReport) => {
				report.changedFiles[0].relativePath = "x".repeat(513)
			},
		],
	])("isolates a report with an invalid %s without blocking later reports", async (_label, corrupt) => {
		const invalid = buildCommitReport({
			reportId: "report-invalid-time",
			commitHash: "commit-invalid-time",
		})
		invalid.candidateLines = [
			{
				clientLineId: "candidate-1",
				generatedBlockId: "generated-1",
				baselineEventId: "generated-1",
				baselineMetricType: "accepted",
				sourceTimestamp: Date.now(),
				sourceType: "agent_insert",
				ide: "vscode",
				userEmail: "current.user@example.com",
				projectKey: "project-key",
				projectName: "repo",
				filePath: "/workspace/project/src/a.ts",
				relativePath: "src/a.ts",
				repoRoot: "/workspace/project",
				repoRelativePath: "src/a.ts",
				lineNumber: 1,
				rawLine: "const a = 1",
				blockLineIndex: 1,
				blockLineCount: 1,
				lineHash: "hash",
				occurrenceIndex: 1,
			},
		]
		corrupt(invalid)
		await store.queueCommitReport(
			buildQueuedReport({
				createdAt: 1,
				report: invalid,
			}),
		)
		await store.queueCommitReport(
			buildQueuedReport({
				createdAt: 2,
				report: buildCommitReport({
					reportId: "report-valid-after-invalid-time",
					commitHash: "commit-valid-after-invalid-time",
				}),
			}),
		)
		const fetchMock = vi.fn(acceptedIngestResponseForRequest)
		vi.stubGlobal("fetch", fetchMock)

		const result = await uploader.uploadQueuedReports({
			enabled: true,
			webhookUrl: "https://example.com/webhook",
			userEmail: "current.user@example.com",
		})

		expect(result).toMatchObject({ uploadedReports: 1, failedReports: 1 })
		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect((await store.getQueuedReportsForTests()).map((item) => item.report.reportId)).toEqual([
			"report-invalid-time",
		])
	})

	it("rejects a malformed 2xx commit-status response instead of treating it as an empty result", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ code: 200, message: "proxy fallback" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			),
		)

		await expect(
			uploader.queryCommitStatuses(
				{ enabled: true, webhookUrl: "https://example.com/webhook" },
				{
					client: { ide: "vscode", machineId: "machine-1" },
					commits: [{ commitHash: "commit-1" }],
				},
			),
		).rejects.toThrow("invalid response")
	})

	it("continues uploading later queued reports when one report fails", async () => {
		await store.queueCommitReport(
			buildQueuedReport({
				report: buildCommitReport({
					reportId: "report-fails",
					commitHash: "commit-fails",
				}),
			}),
		)
		await store.queueCommitReport(
			buildQueuedReport({
				report: buildCommitReport({
					reportId: "report-succeeds",
					commitHash: "commit-succeeds",
				}),
			}),
		)

		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response("fail", { status: 400, statusText: "bad request" }))
			.mockImplementationOnce(acceptedIngestResponseForRequest)
		vi.stubGlobal("fetch", fetchMock)

		const result = await uploader.uploadQueuedReports({
			enabled: true,
			webhookUrl: "https://example.com/webhook",
			userEmail: "current.user@example.com",
		})

		expect(result).toMatchObject({
			uploadedReports: 1,
			uploadedBlocks: 1,
			failedReports: 1,
		})
		expect(result.failedReportErrors[0]).toMatchObject({
			reportId: "report-fails",
			commitHash: "commit-fails",
		})
		const remainingReports = await store.getQueuedReportsForTests()
		expect(remainingReports.map((report) => report.report.reportId)).toEqual(["report-fails"])
		expect(fetchMock.mock.calls[1][1].headers).toMatchObject({
			"X-Ai-Code-Stats-Report-Id": "report-succeeds",
			"X-Ai-Code-Stats-Commit-Hash": "commit-succeeds",
		})
	})

	it("bounds automatic commit-report work and prefers reports that have never been attempted", async () => {
		for (let index = 1; index <= 3; index += 1) {
			await store.queueCommitReport(
				buildQueuedReport({
					createdAt: index,
					report: buildCommitReport({
						reportId: `report-budget-${index}`,
						commitHash: `commit-budget-${index}`,
					}),
				}),
			)
		}
		await store.markCommitUploadRecordStatus({
			reportId: "report-budget-1",
			commitHash: "commit-budget-1",
			repoRoot: "/workspace/project",
			status: "upload_failed",
			lastError: "previous failure",
		})
		const fetchMock = vi.fn(acceptedIngestResponseForRequest)
		vi.stubGlobal("fetch", fetchMock)

		const result = await uploader.uploadQueuedReports(
			{
				enabled: true,
				webhookUrl: "https://example.com/webhook",
				userEmail: "current.user@example.com",
			},
			{ maxReports: 1, requestRetries: 0 },
		)

		expect(result).toMatchObject({ uploadedReports: 1, failedReports: 0 })
		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
			"X-Ai-Code-Stats-Report-Id": "report-budget-2",
		})
		expect((await store.getQueuedReportsForTests()).map((item) => item.report.reportId).sort()).toEqual([
			"report-budget-1",
			"report-budget-3",
		])
	})

	it("does not start another commit report after a global endpoint failure", async () => {
		for (let index = 1; index <= 2; index += 1) {
			await store.queueCommitReport(
				buildQueuedReport({
					createdAt: index,
					report: buildCommitReport({
						reportId: `report-circuit-${index}`,
						commitHash: `commit-circuit-${index}`,
					}),
				}),
			)
		}
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response("backend stopped", { status: 503, statusText: "Service Unavailable" }))
		vi.stubGlobal("fetch", fetchMock)

		const result = await uploader.uploadQueuedReports(
			{
				enabled: true,
				webhookUrl: "https://example.com/webhook",
				userEmail: "current.user@example.com",
			},
			{ requestRetries: 0, stopOnGlobalFailure: true },
		)

		expect(result).toMatchObject({ uploadedReports: 0, failedReports: 1 })
		expect(result.failedReportErrors[0]?.errorCategory).toBe("server_error")
		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(await store.getQueuedReportsForTests()).toHaveLength(2)
	})

	it("does not start a commit report after the run deadline has expired", async () => {
		await store.queueCommitReport(
			buildQueuedReport({
				report: buildCommitReport({
					reportId: "report-deadline",
					commitHash: "commit-deadline",
				}),
			}),
		)
		const fetchMock = vi.fn(acceptedIngestResponseForRequest)
		vi.stubGlobal("fetch", fetchMock)

		const result = await uploader.uploadQueuedReports(
			{
				enabled: true,
				webhookUrl: "https://example.com/webhook",
				userEmail: "current.user@example.com",
			},
			{ deadlineAt: Date.now() - 1, requestRetries: 0 },
		)

		expect(result).toMatchObject({ uploadedReports: 0, failedReports: 0 })
		expect(fetchMock).not.toHaveBeenCalled()
		expect(await store.getQueuedReportsForTests()).toHaveLength(1)
	})

	it("keeps oversized historical candidate clientLineIds compatible with backend hash normalization", async () => {
		const report = buildCommitReport({
			reportId: "report-long-candidate-id",
			commitHash: "commit-long-candidate-id",
		})
		report.candidateLines = [
			{
				clientLineId: "x".repeat(129),
				generatedBlockId: "generated-1",
				baselineEventId: "generated-1",
				baselineMetricType: "accepted",
				sourceTimestamp: Date.now(),
				sourceType: "agent_insert",
				ide: "vscode",
				userEmail: "current.user@example.com",
				projectKey: "project-key",
				projectName: "repo",
				filePath: "/workspace/project/src/a.ts",
				relativePath: "src/a.ts",
				repoRoot: "/workspace/project",
				repoRelativePath: "src/a.ts",
				lineNumber: 1,
				rawLine: "const a = 1",
				blockLineIndex: 1,
				blockLineCount: 1,
				lineHash: "hash",
				occurrenceIndex: 1,
			},
		]
		await store.queueCommitReport(buildQueuedReport({ report }))
		const fetchMock = vi.fn(acceptedIngestResponseForRequest)
		vi.stubGlobal("fetch", fetchMock)

		expect(
			await uploader.uploadQueuedReports({
				enabled: true,
				webhookUrl: "https://example.com/webhook",
				userEmail: "current.user@example.com",
			}),
		).toMatchObject({ uploadedReports: 1, failedReports: 0 })
		const payload = await parseJsonBody(
			fetchMock.mock.calls[0][1]?.body as BodyInit,
			fetchMock.mock.calls[0][1]?.headers as Record<string, string>,
		)
		expect(payload.candidateLines[0].clientLineId).toHaveLength(129)
	})

	it("deduplicates repeated snapshots in compact commit reports", async () => {
		const repeatedContent = "public class Large {\n" + "    int value = 1;\n".repeat(130_000) + "}\n"
		const acceptedBlocks = Array.from({ length: 31 }, (_, index) => ({
			...buildCommitReport().acceptedBlocks![0],
			eventId: `accepted-${index}`,
			generatedBlockId: `generated-${index}`,
			lineStart: index + 1,
			lineEnd: index + 1,
			codeSnippet: `line ${index}`,
			fileSnapshotContent: repeatedContent,
		}))
		await store.queueCommitReport(
			buildQueuedReport({
				report: buildCommitReport({
					reportId: "report-large",
					commitHash: "commit-large",
					acceptedBlocks,
					changedFiles: [
						{
							relativePath: "src/Large.java",
							filePath: "/workspace/project/src/Large.java",
							language: "java",
							committedSnapshotContent: repeatedContent,
							changedBlocks: [],
						},
					],
				}),
				generatedBlockIds: acceptedBlocks.map((block) => block.generatedBlockId),
			}),
		)

		const fetchMock = vi.fn(acceptedIngestResponseForRequest)
		vi.stubGlobal("fetch", fetchMock)

		await uploader.uploadQueuedReports({
			enabled: true,
			webhookUrl: "https://example.com/webhook",
			userEmail: "current.user@example.com",
		})

		expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
			"Content-Encoding": "gzip",
			"X-Ai-Code-Stats-Wire-Version": "v3",
			"X-Ai-Code-Stats-Report-Id": "report-large",
			"X-Ai-Code-Stats-Commit-Hash": "commit-large",
		})
		const body = await parseJsonBody(
			fetchMock.mock.calls[0][1].body as BodyInit,
			fetchMock.mock.calls[0][1].headers as Record<string, string>,
		)
		const rawV2Bytes = Buffer.byteLength(JSON.stringify(buildCommitReport({ acceptedBlocks })), "utf8")
		const gzipBytes = (fetchMock.mock.calls[0][1].body as Uint8Array).byteLength
		expect(body.snapshots).toHaveLength(1)
		expect(body.acceptedBlocks.every((block: any) => !("fileSnapshotContent" in block))).toBe(true)
		expect(body.changedFiles[0].committedSnapshotContent).toBeUndefined()
		expect(gzipBytes).toBeLessThan(rawV2Bytes * 0.2)
	})
})
