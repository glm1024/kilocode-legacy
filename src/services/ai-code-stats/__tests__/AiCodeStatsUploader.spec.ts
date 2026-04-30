// kilocode_change - new file
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { gunzip } from "zlib"
import { promisify } from "util"

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

const gunzipAsync = promisify(gunzip)

const parseJsonBody = async (body: BodyInit | null | undefined, headers?: Record<string, string>): Promise<any> => {
	const buffer =
		body instanceof Uint8Array
			? Buffer.from(body)
			: typeof body === "string"
				? Buffer.from(body)
				: Buffer.from(body as ArrayBuffer)
	if (headers?.["Content-Encoding"] === "gzip") {
		return JSON.parse((await gunzipAsync(buffer)).toString("utf8"))
	}
	return JSON.parse(buffer.toString("utf8"))
}

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

		const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }))
		vi.stubGlobal("fetch", fetchMock)

		const result = await uploader.uploadQueuedReports({
			enabled: true,
			webhookUrl: "https://example.com/webhook",
			userEmail: "current.user@example.com",
		})

		expect(result).toMatchObject({ uploadedReports: 2, uploadedBlocks: 2 })
		expect(result.rawPayloadBytes).toBeGreaterThan(0)
		expect(result.compressedPayloadBytes).toBeGreaterThan(0)
		expect(result.timeoutMs).toBe(10 * 60 * 1000)
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

		const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }))
		vi.stubGlobal("fetch", fetchMock)

		const result = await uploader.upload(
			{ enabled: true, webhookUrl: "https://example.com/webhook", userEmail: "current.user@example.com" },
			{ client: { ide: "goland", machineId: "machine-1" } },
		)

		expect(result).toEqual({ uploaded: 1 })
		expect(fetchMock.mock.calls).toHaveLength(1)
		const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
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
			.mockResolvedValueOnce(new Response("ok", { status: 200 }))
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

		const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }))
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
