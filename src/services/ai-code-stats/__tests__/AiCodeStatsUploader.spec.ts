// kilocode_change - new file
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { setFetchRetryFactorForTests } from "../../../shared/http"
import { AiCodeStatsStore } from "../AiCodeStatsStore"
import { AiCodeStatsUploader } from "../AiCodeStatsUploader"
import {
	CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
	type AiCodeCommitReport,
	type AiCodeQueuedCommitReport,
	type AiCodeStatsEvent,
} from "../types"

const buildEvent = (overrides: Partial<AiCodeStatsEvent> = {}): AiCodeStatsEvent => ({
	eventId: overrides.eventId ?? `evt-${Math.random().toString(36).slice(2)}`,
	timestamp: overrides.timestamp ?? Date.now(),
	semanticsVersion: overrides.semanticsVersion ?? CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
	sourceType: overrides.sourceType ?? "agent_insert",
	ide: overrides.ide ?? "vscode",
	metricType: overrides.metricType ?? "generated",
	workspaceName: overrides.workspaceName ?? "project",
	workspacePath: overrides.workspacePath ?? "/workspace/project",
	filePath: overrides.filePath ?? "/workspace/project/src/a.ts",
	relativePath: overrides.relativePath ?? "src/a.ts",
	lineStart: overrides.lineStart ?? 1,
	lineEnd: overrides.lineEnd ?? 1,
	lineCount: overrides.lineCount ?? 1,
	codeSnippet: overrides.codeSnippet ?? "const x = 1",
	taskId: overrides.taskId,
	matchStrategy: overrides.matchStrategy,
	matchConfidence: overrides.matchConfidence,
	equivalentLineCount: overrides.equivalentLineCount,
	commitHash: overrides.commitHash,
	commitOccurredAt: overrides.commitOccurredAt,
})

const buildCommitReport = (overrides: Partial<AiCodeCommitReport> = {}): AiCodeCommitReport => ({
	version: "v2",
	source: "kilocode-ai-code-stats",
	mode: "commit_report",
	semanticsVersion: overrides.semanticsVersion ?? CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
	reportId: overrides.reportId ?? `report-${Math.random().toString(36).slice(2)}`,
	reportGeneratedAt: overrides.reportGeneratedAt ?? Date.now(),
	client: overrides.client ?? { ide: "vscode", machineId: "machine-1" },
	repoRoot: overrides.repoRoot ?? "/workspace/project",
	workspaceName: overrides.workspaceName ?? "project",
	workspacePath: overrides.workspacePath ?? "/workspace/project",
	projectKey: overrides.projectKey ?? "project-key",
	gitRemoteUrl: overrides.gitRemoteUrl ?? "https://github.com/example/repo.git",
	gitBranch: overrides.gitBranch ?? "feature/stats",
	commitHash: overrides.commitHash ?? "commit-1",
	previousCommitHash: overrides.previousCommitHash ?? "commit-0",
	commitOccurredAt: overrides.commitOccurredAt ?? Date.now(),
	acceptedBlocks: overrides.acceptedBlocks ?? [
		{
			eventId: "generated-1",
			generatedBlockId: "generated-1",
			timestamp: Date.now(),
			semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
			sourceType: "agent_insert",
			ide: "vscode",
			workspaceName: "project",
			workspacePath: "/workspace/project",
			projectKey: "project-key",
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
	committedBlocks: overrides.committedBlocks ?? [],
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
	matchedPendingLineIds: overrides.matchedPendingLineIds ?? [],
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
		vi.unstubAllGlobals()
	})

	it("uploads incremental envelopes only and advances the pending cursor", async () => {
		const now = Date.now()
		await store.appendEvent(
			buildEvent({
				eventId: "e1",
				timestamp: now,
				metricType: "committed",
				matchStrategy: "partial",
				matchConfidence: 0.9345,
				equivalentLineCount: 2.7182,
				commitHash: "abc123",
				commitOccurredAt: now,
			}),
		)
		await store.appendEvent(buildEvent({ eventId: "e2", timestamp: now }))

		const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }))
		vi.stubGlobal("fetch", fetchMock)

		const result = await uploader.upload(
			{ enabled: true, webhookUrl: "https://example.com/webhook" },
			{
				client: {
					ide: "vscode",
				},
			},
		)

		expect(result.uploaded).toBe(2)

		const bodies = fetchMock.mock.calls.map((call) => JSON.parse(call[1].body as string))
		expect(bodies).toHaveLength(1)
		expect(bodies[0].mode).toBe("incremental")
		expect(bodies[0].events[0]).toMatchObject({
			eventId: "e1",
			matchStrategy: "partial",
			matchConfidence: 0.9345,
			equivalentLineCount: 2.7182,
			commitHash: "abc123",
			commitOccurredAt: now,
		})

		const pendingAfter = await store.getPendingEventCount()
		expect(pendingAfter).toBe(0)
	})

	it("uploads autocomplete and agent events when both exist in history", async () => {
		const now = Date.now()
		await store.appendEvent(buildEvent({ eventId: "e-auto", timestamp: now, sourceType: "autocomplete" }))
		await store.appendEvent(buildEvent({ eventId: "e-agent", timestamp: now, sourceType: "agent_insert" }))

		const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }))
		vi.stubGlobal("fetch", fetchMock)

		const result = await uploader.upload(
			{ enabled: true, webhookUrl: "https://example.com/webhook" },
			{
				client: {
					ide: "vscode",
				},
			},
		)

		expect(result.uploaded).toBe(2)
		expect(await store.getPendingEventCount()).toBe(0)

		const bodies = fetchMock.mock.calls.map((call) => JSON.parse(call[1].body as string))
		expect(bodies).toHaveLength(1)
		expect(bodies[0].events.map((event: AiCodeStatsEvent) => event.sourceType).sort()).toEqual([
			"agent_insert",
			"autocomplete",
		])
	})

	it("keeps pending events when incremental upload fails", async () => {
		await store.appendEvent(buildEvent({ eventId: "e1" }))

		const fetchMock = vi.fn().mockResolvedValue(new Response("fail", { status: 500, statusText: "err" }))
		vi.stubGlobal("fetch", fetchMock)

		await expect(
			uploader.upload(
				{ enabled: true, webhookUrl: "https://example.com/webhook" },
				{
					client: { ide: "vscode" },
				},
			),
		).rejects.toThrow()

		expect(await store.getPendingEventCount()).toBe(1)
	})

	it("uploads when webhook url is set even if enabled flag is false", async () => {
		await store.appendEvent(buildEvent({ eventId: "e1" }))

		const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }))
		vi.stubGlobal("fetch", fetchMock)

		const result = await uploader.upload(
			{ enabled: false, webhookUrl: "https://example.com/webhook" },
			{
				client: { ide: "vscode" },
			},
		)

		expect(result.uploaded).toBe(1)
		expect(fetchMock).toHaveBeenCalled()
	})

	it("appends the ingest path when only the server root URL is configured", async () => {
		await store.appendEvent(buildEvent({ eventId: "e1" }))

		const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }))
		vi.stubGlobal("fetch", fetchMock)

		const result = await uploader.upload(
			{ enabled: true, webhookUrl: "http://localhost:8081" },
			{
				client: { ide: "vscode" },
			},
		)

		expect(result.uploaded).toBe(1)
		expect(fetchMock).toHaveBeenCalledWith("http://localhost:8081/api/v1/ingest/ai-code-stats", expect.any(Object))
	})

	it("uploads queued commit reports and acknowledges them in FIFO order", async () => {
		await store.queueCommitReport(
			buildQueuedReport({
				report: buildCommitReport({
					reportId: "report-1",
					commitHash: "commit-1",
					committedBlocks: [
						{
							eventId: "committed-1",
							generatedBlockId: "generated-1",
							timestamp: Date.now(),
							sourceType: "agent_insert",
							ide: "vscode",
							workspaceName: "project",
							workspacePath: "/workspace/project",
							projectKey: "project-key",
							filePath: "/workspace/project/src/a.ts",
							relativePath: "src/a.ts",
							language: "typescript",
							gitRemoteUrl: "https://github.com/example/repo.git",
							gitBranch: "feature/stats",
							lineStart: 1,
							lineEnd: 1,
							lineCount: 1,
							codeSnippet: "const a = 1",
							fileSnapshotContent: "const a = 1\nconst b = 2\n",
							commitHash: "commit-1",
							commitOccurredAt: Date.now(),
							matchStrategy: "exact",
							matchConfidence: 1,
							equivalentLineCount: 1,
						},
					],
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
							workspaceName: "project",
							workspacePath: "/workspace/project",
							projectKey: "project-key",
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

		const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }))
		vi.stubGlobal("fetch", fetchMock)

		const result = await uploader.uploadQueuedReports(
			{ enabled: true, webhookUrl: "https://example.com/webhook" },
			{ client: { ide: "vscode" } },
		)

		expect(result).toEqual({ uploadedReports: 2, uploadedBlocks: 3 })
		expect(fetchMock.mock.calls).toHaveLength(2)
		const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body as string)
		expect(firstBody.reportId).toBe("report-1")
		expect(firstBody.acceptedBlocks[0].fileSnapshotContent).toBe("const a = 1\n")
		expect(firstBody.committedBlocks[0].fileSnapshotContent).toBe("const a = 1\nconst b = 2\n")
		const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body as string)
		expect(secondBody.reportId).toBe("report-2")
		expect(secondBody.generatedBlocks[0].fileSnapshotContent).toBe("const b = 2\n")
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
		expect(await store.getQueuedReportsForTests()).toHaveLength(0)
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
			.mockResolvedValueOnce(new Response("ok", { status: 200 }))
		vi.stubGlobal("fetch", fetchMock)

		await expect(
			uploader.uploadQueuedReports(
				{ enabled: true, webhookUrl: "https://example.com/webhook" },
				{ client: { ide: "vscode" } },
			),
		).rejects.toThrow()
		expect(await store.getQueuedReportsForTests()).toHaveLength(1)

		const retryResult = await uploader.uploadQueuedReports(
			{ enabled: true, webhookUrl: "https://example.com/webhook" },
			{ client: { ide: "vscode" } },
		)
		expect(retryResult).toEqual({ uploadedReports: 1, uploadedBlocks: 1 })
		expect(await store.getQueuedReportsForTests()).toHaveLength(0)
		expect(fetchMock.mock.calls).toHaveLength(2)
	})
})
