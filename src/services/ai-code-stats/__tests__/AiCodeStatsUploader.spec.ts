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

	it("uploads queued commit reports and acknowledges them in FIFO order", async () => {
		await store.queueCommitReport(
			buildQueuedReport({
				report: buildCommitReport({
					reportId: "report-1",
					commitHash: "commit-1",
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

		const result = await uploader.uploadQueuedReports({ enabled: true, webhookUrl: "https://example.com/webhook" })

		expect(result).toEqual({ uploadedReports: 2, uploadedBlocks: 2 })
		expect(fetchMock.mock.calls).toHaveLength(2)
		const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body as string)
		expect(firstBody.reportId).toBe("report-1")
		expect(firstBody.acceptedBlocks[0].fileSnapshotContent).toBe("const a = 1\n")
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

	it("uploads standalone generated events from the local queue", async () => {
		const event: AiCodeStatsEvent = {
			eventId: "event-1",
			timestamp: Date.now(),
			semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
			sourceType: "agent_insert",
			ide: "vscode",
			metricType: "generated",
			workspaceName: "project",
			workspacePath: "/workspace/project",
			filePath: "/workspace/project/src/rejected.ts",
			relativePath: "src/rejected.ts",
			lineStart: 2,
			lineEnd: 2,
			lineCount: 1,
			codeSnippet: "const rejected = true",
		}
		await store.appendEvent(event)

		const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }))
		vi.stubGlobal("fetch", fetchMock)

		const result = await uploader.upload(
			{ enabled: true, webhookUrl: "https://example.com/webhook" },
			{ client: { ide: "vscode", machineId: "machine-1" } },
		)

		expect(result).toEqual({ uploaded: 1 })
		expect(fetchMock.mock.calls).toHaveLength(1)
		const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
		expect(body.mode).toBe("incremental")
		expect(body.events).toHaveLength(1)
		expect(body.events[0]).toMatchObject({
			eventId: "event-1",
			sourceType: "agent_insert",
			metricType: "generated",
			relativePath: "src/rejected.ts",
		})
		expect(await store.getPendingEvents()).toHaveLength(0)
	})

	it("does not upload client-side committed events from the local queue", async () => {
		await store.appendEvent({
			eventId: "client-committed",
			timestamp: Date.now(),
			semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
			sourceType: "agent_insert",
			ide: "vscode",
			metricType: "committed",
			workspaceName: "project",
			workspacePath: "/workspace/project",
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
			{ enabled: true, webhookUrl: "https://example.com/webhook" },
			{ client: { ide: "vscode", machineId: "machine-1" } },
		)

		expect(result).toEqual({ uploaded: 0 })
		expect(fetchMock).not.toHaveBeenCalled()
		expect(await store.getPendingEvents()).toHaveLength(0)
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
			uploader.uploadQueuedReports({ enabled: true, webhookUrl: "https://example.com/webhook" }),
		).rejects.toThrow()
		expect(await store.getQueuedReportsForTests()).toHaveLength(1)

		const retryResult = await uploader.uploadQueuedReports({
			enabled: true,
			webhookUrl: "https://example.com/webhook",
		})
		expect(retryResult).toEqual({ uploadedReports: 1, uploadedBlocks: 1 })
		expect(await store.getQueuedReportsForTests()).toHaveLength(0)
		expect(fetchMock.mock.calls).toHaveLength(2)
	})
})
