// kilocode_change - new file
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { AiCodeStatsStore } from "../AiCodeStatsStore"
import { hashLineFingerprint } from "../AiCodeLineFingerprint"
import {
	CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
	type AiCodeGeneratedBlockState,
	type AiCodePendingLineAttribution,
	type AiCodePendingCommitMetricBlock,
	type AiCodeQueuedCommitLifecycleReport,
	type AiCodeQueuedCommitReport,
	type AiCodeStatsEvent,
} from "../types"

const buildPendingLine = (overrides: Partial<AiCodePendingLineAttribution> = {}): AiCodePendingLineAttribution => {
	const rawLine = overrides.rawLine ?? "const value = 1"

	return {
		id: overrides.id ?? `line-${Math.random().toString(36).slice(2)}`,
		generatedEventId: overrides.generatedEventId ?? "generated-1",
		blockId: overrides.blockId ?? overrides.generatedEventId ?? "generated-1",
		timestamp: overrides.timestamp ?? Date.now(),
		sourceType: overrides.sourceType ?? "agent_insert",
		ide: overrides.ide ?? "vscode",
		projectKey: overrides.projectKey ?? "project-key",
		projectName: overrides.projectName ?? "repo",
		filePath: overrides.filePath ?? "/repo/src/a.ts",
		relativePath: overrides.relativePath ?? "src/a.ts",
		repoRoot: overrides.repoRoot ?? "/repo",
		repoRelativePath: overrides.repoRelativePath ?? "src/a.ts",
		language: overrides.language ?? "typescript",
		gitRemoteUrl: overrides.gitRemoteUrl ?? "https://github.com/example/repo.git",
		gitBranch: overrides.gitBranch ?? "feature/stats",
		taskId: overrides.taskId,
		rawLine,
		blockLineIndex: overrides.blockLineIndex ?? overrides.occurrenceIndex ?? 1,
		blockLineCount: overrides.blockLineCount ?? 1,
		lineHash: overrides.lineHash ?? hashLineFingerprint(rawLine),
		occurrenceIndex: overrides.occurrenceIndex ?? 1,
	}
}

const buildGeneratedBlockState = (overrides: Partial<AiCodeGeneratedBlockState> = {}): AiCodeGeneratedBlockState => ({
	stateId: overrides.stateId ?? "state-1",
	eventId: overrides.eventId ?? "generated-event-1",
	generatedBlockId: overrides.generatedBlockId ?? "generated-block-1",
	timestamp: overrides.timestamp ?? Date.now(),
	semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
	sourceType: "agent_insert",
	ide: "vscode",
	projectKey: "project-key",
	projectName: "repo",
	repoRoot: "/repo",
	repoRelativePath: "src/a.ts",
	filePath: "/repo/src/a.ts",
	relativePath: "src/a.ts",
	lineStart: 1,
	lineEnd: 1,
	lineCount: 1,
	codeSnippet: "const generated = true",
	uploadStatus: "pending",
	...overrides,
})

const buildPendingCommitMetricBlock = (
	overrides: Partial<AiCodePendingCommitMetricBlock> = {},
): AiCodePendingCommitMetricBlock => ({
	eventId: overrides.eventId ?? "metric-event-1",
	generatedBlockId: overrides.generatedBlockId ?? "metric-block-1",
	timestamp: overrides.timestamp ?? Date.now(),
	semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
	sourceType: "agent_insert",
	ide: "vscode",
	projectKey: "project-key",
	projectName: "repo",
	repoRoot: "/repo",
	repoRelativePath: "src/a.ts",
	filePath: "/repo/src/a.ts",
	relativePath: "src/a.ts",
	lineStart: 1,
	lineEnd: 1,
	lineCount: 1,
	codeSnippet: "const metric = true",
	...overrides,
})

const buildQueuedReport = (overrides: Partial<AiCodeQueuedCommitReport> = {}): AiCodeQueuedCommitReport => ({
	report: overrides.report ?? {
		version: "v2",
		source: "kilocode-ai-code-stats",
		mode: "commit_report",
		reportId: "report-1",
		reportGeneratedAt: Date.now(),
		semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
		client: { ide: "vscode" },
		repoRoot: "/repo",
		projectKey: "project-key",
		projectName: "repo",
		gitBranch: "feature/stats",
		commitHash: "commit-1",
		previousCommitHash: "commit-0",
		commitOccurredAt: Date.now(),
		acceptedBlocks: [],
		changedFiles: [],
	},
	createdAt: overrides.createdAt ?? Date.now(),
	generatedBlockIds: overrides.generatedBlockIds ?? [],
})

const buildQueuedLifecycleReport = (
	overrides: Partial<AiCodeQueuedCommitLifecycleReport> = {},
): AiCodeQueuedCommitLifecycleReport => ({
	report: overrides.report ?? {
		version: "v1",
		source: "kilocode-ai-code-stats",
		mode: "commit_lifecycle",
		semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
		eventId: "lifecycle-1",
		reportId: "report-lifecycle-1",
		eventOccurredAt: Date.now(),
		reportedAt: Date.now(),
		client: { ide: "vscode" },
		repoRoot: "/repo",
		projectKey: "project-key",
		projectName: "repo",
		gitBranch: "feature/stats",
		eventType: "commit_replaced",
		reason: "amend",
		confidence: "strong",
		oldCommitHash: "old-commit",
		newCommitHash: "new-commit",
		commitHashes: ["old-commit"],
		replacementCommitHashes: ["new-commit"],
	},
	createdAt: overrides.createdAt ?? Date.now(),
})

const buildUploadEvent = (eventId: string, timestamp: number = Date.now()) => ({
	eventId,
	timestamp,
	semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
	sourceType: "agent_insert" as const,
	ide: "vscode",
	metricType: "generated" as const,
	projectKey: "project-key",
	projectName: "repo",
	repoRoot: "/repo",
	repoRelativePath: "src/a.ts",
	filePath: "/repo/src/a.ts",
	relativePath: "src/a.ts",
	lineStart: 1,
	lineEnd: 1,
	lineCount: 1,
	codeSnippet: `const ${eventId.replace(/[^a-zA-Z0-9_$]/g, "_")} = true`,
})

describe("AiCodeStatsStore", () => {
	let tmpDir: string
	let store: AiCodeStatsStore

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-code-stats-store-"))
		store = new AiCodeStatsStore(tmpDir)
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("prunes old local commit facts", async () => {
		const oldTs = new Date("2026-01-01T00:00:00.000Z").getTime()
		const newTs = new Date("2026-03-05T00:00:00.000Z").getTime()
		await store.addPendingLineAttributions([
			buildPendingLine({ id: "old", timestamp: oldTs }),
			buildPendingLine({ id: "new", timestamp: newTs }),
		])

		await store.pruneOldData(30, newTs)

		const pending = await store.getPendingLineAttributions()
		expect(pending.map((line) => line.id)).toEqual(["new"])
	})

	it("retains unacknowledged upload outbox records beyond the attribution retention window", async () => {
		const oldTs = new Date("2026-01-01T00:00:00.000Z").getTime()
		const nowTs = new Date("2026-03-05T00:00:00.000Z").getTime()
		await store.appendEvent({
			eventId: "old-undelivered-event",
			timestamp: oldTs,
			semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
			sourceType: "agent_insert",
			ide: "vscode",
			metricType: "generated",
			projectKey: "project-key",
			projectName: "repo",
			repoRoot: "/repo",
			repoRelativePath: "src/a.ts",
			filePath: "/repo/src/a.ts",
			relativePath: "src/a.ts",
			lineStart: 1,
			lineEnd: 1,
			lineCount: 1,
			codeSnippet: "const retained = true",
		})
		await store.queueCommitLifecycleReport(
			buildQueuedLifecycleReport({
				createdAt: oldTs,
				report: {
					...buildQueuedLifecycleReport().report,
					eventId: "old-undelivered-lifecycle",
					reportId: "old-undelivered-lifecycle-report",
					eventOccurredAt: oldTs,
					reportedAt: oldTs,
				},
			}),
		)

		await store.pruneOldData(30, nowTs)

		expect((await store.getPendingEvents()).map((event) => event.eventId)).toEqual(["old-undelivered-event"])
		expect((await store.getQueuedCommitLifecycleReportsForTests()).map((item) => item.report.eventId)).toEqual([
			"old-undelivered-lifecycle",
		])
	})

	it("preserves last upload status in queue state", async () => {
		const nowDate = new Date("2026-03-19T12:00:00.000Z")
		const now = nowDate.getTime()

		await store.setLastUploadStatus({
			status: "success",
			timestamp: now,
			mode: "incremental",
			trigger: "commit",
			uploadedEvents: 2,
		})
		const state = await store.getRawStateForTests()
		expect(state.lastUpload).toMatchObject({
			status: "success",
			timestamp: now,
			mode: "incremental",
			trigger: "commit",
			uploadedEvents: 2,
		})
	})

	it("loads current-version state files", async () => {
		const baseDir = path.join(tmpDir, "ai-code-stats", "v1")
		await fs.mkdir(baseDir, { recursive: true })
		await fs.writeFile(
			path.join(baseDir, "state.json"),
			JSON.stringify({
				version: 1,
				lastUpload: { status: "idle" },
			}),
			"utf8",
		)

		const reloadedStore = new AiCodeStatsStore(tmpDir)
		const state = await reloadedStore.getRawStateForTests()
		expect(state.repoObservedCommits).toEqual({})
	})

	it("replays a durable pending transaction before loading store state", async () => {
		const baseDir = path.join(tmpDir, "ai-code-stats", "v1")
		const event = {
			eventId: "event-from-pending-transaction",
			timestamp: new Date("2026-03-19T12:00:00.000Z").getTime(),
			semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
			sourceType: "agent_insert" as const,
			ide: "vscode",
			metricType: "generated" as const,
			projectKey: "project-key",
			projectName: "repo",
			repoRoot: "/repo",
			repoRelativePath: "src/a.ts",
			filePath: "/repo/src/a.ts",
			relativePath: "src/a.ts",
			lineStart: 1,
			lineEnd: 1,
			lineCount: 1,
			codeSnippet: "const recovered = true",
		}
		await fs.mkdir(baseDir, { recursive: true })
		await fs.writeFile(
			path.join(baseDir, "pending-transaction.json"),
			JSON.stringify({
				version: 1,
				uploadEvents: [event],
				writes: [
					{
						key: "state",
						value: {
							version: 1,
							pendingEventIds: [event.eventId],
							supersededEventIds: [],
							repoObservedCommits: {},
							lastUpload: { status: "idle" },
						},
					},
					{
						key: "queuedReports",
						value: [buildQueuedReport()],
					},
				],
			}),
			"utf8",
		)

		const reloadedStore = new AiCodeStatsStore(tmpDir)

		expect((await reloadedStore.getPendingEvents()).map((item) => item.eventId)).toEqual([event.eventId])
		expect((await reloadedStore.getQueuedReportsForTests()).map((item) => item.report.reportId)).toEqual([
			"report-1",
		])
		await expect(fs.access(path.join(baseDir, "pending-transaction.json"))).rejects.toMatchObject({
			code: "ENOENT",
		})
	})

	it("recovers a safe-write transaction artifact before replay", async () => {
		const baseDir = path.join(tmpDir, "ai-code-stats", "v1")
		await fs.mkdir(baseDir, { recursive: true })
		await fs.writeFile(
			path.join(baseDir, ".pending-transaction.json.new_1772500000000_recovery.tmp"),
			JSON.stringify({
				version: 1,
				writes: [
					{
						key: "state",
						value: {
							version: 1,
							pendingEventIds: [],
							supersededEventIds: [],
							repoObservedCommits: {},
							lastUpload: { status: "success", timestamp: 1_772_500_000_000 },
						},
					},
				],
			}),
			"utf8",
		)

		const reloadedStore = new AiCodeStatsStore(tmpDir)

		expect((await reloadedStore.getRawStateForTests()).lastUpload).toEqual({
			status: "success",
			timestamp: 1_772_500_000_000,
		})
		await expect(fs.access(path.join(baseDir, "pending-transaction.json"))).rejects.toMatchObject({
			code: "ENOENT",
		})
	})

	it("deduplicates an upload event when transaction recovery repeats an append", async () => {
		const baseDir = path.join(tmpDir, "ai-code-stats", "v1")
		const queueDir = path.join(baseDir, "upload-events")
		const event = {
			eventId: "event-appended-before-crash",
			timestamp: new Date("2026-03-19T12:00:00.000Z").getTime(),
			semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
			sourceType: "agent_insert" as const,
			ide: "vscode",
			metricType: "accepted" as const,
			projectKey: "project-key",
			projectName: "repo",
			repoRoot: "/repo",
			repoRelativePath: "src/a.ts",
			filePath: "/repo/src/a.ts",
			relativePath: "src/a.ts",
			lineStart: 1,
			lineEnd: 1,
			lineCount: 1,
			codeSnippet: "const accepted = true",
		}
		const state = {
			version: 1,
			pendingEventIds: [event.eventId],
			supersededEventIds: [],
			repoObservedCommits: {},
			lastUpload: { status: "idle" },
		}
		await fs.mkdir(queueDir, { recursive: true })
		await fs.writeFile(path.join(baseDir, "state.json"), JSON.stringify(state), "utf8")
		await fs.writeFile(path.join(queueDir, "2026-03-19.ndjson"), `${JSON.stringify(event)}\n`, "utf8")
		await fs.writeFile(
			path.join(baseDir, "pending-transaction.json"),
			JSON.stringify({
				version: 1,
				uploadEvents: [event],
				writes: [{ key: "state", value: state }],
			}),
			"utf8",
		)

		const duplicateSegmentSyncs: string[] = []
		const originalOpen = fs.open.bind(fs)
		const openFile = (async (...args: Parameters<typeof fs.open>) => {
			const handle = await originalOpen(...args)
			if (String(args[0]).endsWith(".ndjson") && args[1] === "r+") {
				const originalSync = handle.sync.bind(handle)
				;(handle as any).sync = async () => {
					duplicateSegmentSyncs.push(path.basename(String(args[0])))
					return originalSync()
				}
			}
			return handle
		}) as typeof fs.open
		const reloadedStore = new AiCodeStatsStore(tmpDir, { open: openFile })

		expect((await reloadedStore.getPendingEvents()).map((item) => item.eventId)).toEqual([event.eventId])
		expect(duplicateSegmentSyncs).toEqual(["2026-03-19.ndjson"])
		const persistedLines = (await fs.readFile(path.join(queueDir, "2026-03-19.ndjson"), "utf8"))
			.split("\n")
			.filter(Boolean)
		expect(persistedLines).toHaveLength(1)
	})

	it("retains prepared and committed event bodies until duplicate segment file and directory barriers succeed", async () => {
		const baseDir = path.join(tmpDir, "ai-code-stats", "v1")
		const transactionPath = path.join(baseDir, "pending-transaction.json")
		const event = buildUploadEvent("event-needs-replay-file-barrier", 1_773_900_000_009)
		const originalOpen = fs.open.bind(fs)
		let failSegmentSync = true
		let directoryDurable = false
		const segmentSyncModes: string[] = []
		const openFile = (async (...args: Parameters<typeof fs.open>) => {
			const handle = await originalOpen(...args)
			if (String(args[0]).endsWith(".ndjson")) {
				const originalSync = handle.sync.bind(handle)
				;(handle as any).sync = async () => {
					segmentSyncModes.push(String(args[1]))
					if (failSegmentSync) {
						const error = new Error("segment fsync failed") as NodeJS.ErrnoException
						error.code = "EIO"
						throw error
					}
					return originalSync()
				}
			}
			return handle
		}) as typeof fs.open
		const options = {
			open: openFile,
			syncDirectory: async () => directoryDurable,
		}

		await expect(new AiCodeStatsStore(tmpDir, options).appendEvent(event)).rejects.toThrow("segment fsync failed")
		expect(JSON.parse(await fs.readFile(transactionPath, "utf8"))).toMatchObject({
			status: "prepared",
			uploadEvents: [expect.objectContaining({ eventId: event.eventId })],
		})

		await expect(new AiCodeStatsStore(tmpDir, options).getPendingEvents()).rejects.toThrow("segment fsync failed")
		expect(segmentSyncModes).toEqual(["a", "r+"])
		expect(JSON.parse(await fs.readFile(transactionPath, "utf8"))).toMatchObject({
			status: "prepared",
			uploadEvents: [expect.objectContaining({ eventId: event.eventId })],
		})

		failSegmentSync = false
		await expect(new AiCodeStatsStore(tmpDir, options).getPendingEvents()).resolves.toEqual([
			expect.objectContaining({ eventId: event.eventId }),
		])
		expect(segmentSyncModes.at(-1)).toBe("r+")
		expect(JSON.parse(await fs.readFile(transactionPath, "utf8"))).toMatchObject({
			status: "committed",
			uploadEvents: [expect.objectContaining({ eventId: event.eventId })],
			writes: [],
		})

		failSegmentSync = true
		await expect(new AiCodeStatsStore(tmpDir, options).getPendingEvents()).rejects.toThrow("segment fsync failed")
		expect(JSON.parse(await fs.readFile(transactionPath, "utf8"))).toMatchObject({
			status: "committed",
			uploadEvents: [expect.objectContaining({ eventId: event.eventId })],
		})

		failSegmentSync = false
		directoryDurable = true
		await expect(new AiCodeStatsStore(tmpDir, options).getPendingEvents()).resolves.toEqual([
			expect.objectContaining({ eventId: event.eventId }),
		])
		await expect(fs.access(transactionPath)).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("does not replay committed store writes after Windows-style directory fsync degradation", async () => {
		const baseDir = path.join(tmpDir, "ai-code-stats", "v1")
		const firstEvent = buildUploadEvent("windows-committed-before-ack", 1_773_900_000_010)
		const secondEvent = buildUploadEvent("windows-next-transaction", 1_773_900_000_011)
		let directorySyncSupported = false
		const syncDirectoryForTest = async () => directorySyncSupported
		const degradedStore = new AiCodeStatsStore(tmpDir, { syncDirectory: syncDirectoryForTest })

		await degradedStore.appendEvent(firstEvent)
		const firstTombstone = JSON.parse(await fs.readFile(path.join(baseDir, "pending-transaction.json"), "utf8"))
		expect(firstTombstone).toMatchObject({
			version: 1,
			status: "committed",
			transactionId: expect.any(String),
			writes: [],
		})

		directorySyncSupported = true
		await degradedStore.markEventsUploaded([firstEvent.eventId])
		expect(await degradedStore.getPendingEvents()).toEqual([])

		directorySyncSupported = false
		const restartedStore = new AiCodeStatsStore(tmpDir, { syncDirectory: syncDirectoryForTest })
		expect(await restartedStore.getPendingEvents()).toEqual([])

		await restartedStore.appendEvent(secondEvent)
		const nextTombstone = JSON.parse(await fs.readFile(path.join(baseDir, "pending-transaction.json"), "utf8"))
		expect(nextTombstone).toMatchObject({
			status: "committed",
			transactionId: expect.any(String),
			writes: [],
		})
		expect(nextTombstone.transactionId).not.toBe(firstTombstone.transactionId)

		const restartedAgain = new AiCodeStatsStore(tmpDir, { syncDirectory: syncDirectoryForTest })
		expect((await restartedAgain.getPendingEvents()).map((event) => event.eventId)).toEqual([secondEvent.eventId])
	})

	it("retains every event from an unproven Windows segment and replays it after the segment is lost", async () => {
		const baseDir = path.join(tmpDir, "ai-code-stats", "v1")
		const queueDir = path.join(baseDir, "upload-events")
		const syncDirectoryForTest = async () => false
		const store = new AiCodeStatsStore(tmpDir, { syncDirectory: syncDirectoryForTest })
		const firstEvent = buildUploadEvent("windows-unproven-first", 1_773_900_000_010)
		const secondEvent = buildUploadEvent("windows-unproven-second", 1_773_900_000_011)

		await store.appendEvent(firstEvent)
		await store.appendEvent(secondEvent)

		const retainedTransaction = JSON.parse(
			await fs.readFile(path.join(baseDir, "pending-transaction.json"), "utf8"),
		)
		expect(retainedTransaction).toMatchObject({
			status: "committed",
			uploadEvents: [
				expect.objectContaining({ eventId: firstEvent.eventId }),
				expect.objectContaining({ eventId: secondEvent.eventId }),
			],
			writes: [],
		})

		const concurrentHostStore = new AiCodeStatsStore(tmpDir, { syncDirectory: syncDirectoryForTest })
		expect((await concurrentHostStore.getPendingEvents()).map((event) => event.eventId)).toEqual([
			firstEvent.eventId,
			secondEvent.eventId,
		])
		const retainedAfterConcurrentHost = JSON.parse(
			await fs.readFile(path.join(baseDir, "pending-transaction.json"), "utf8"),
		)
		expect(retainedAfterConcurrentHost.uploadEvents).toHaveLength(2)

		// Emulate a crash in which the newly created segment directory entry was
		// not persisted even though its file contents had been flushed.
		await fs.rm(queueDir, { recursive: true, force: true })

		const recoveredStore = new AiCodeStatsStore(tmpDir, { syncDirectory: syncDirectoryForTest })
		expect((await recoveredStore.getPendingEvents()).map((event) => event.eventId)).toEqual([
			firstEvent.eventId,
			secondEvent.eventId,
		])

		const replayedTransaction = JSON.parse(
			await fs.readFile(path.join(baseDir, "pending-transaction.json"), "utf8"),
		)
		expect(replayedTransaction.uploadEvents.map((event: AiCodeStatsEvent) => event.eventId)).toEqual([
			firstEvent.eventId,
			secondEvent.eventId,
		])
	})

	it("separates a replayed event from an interrupted NDJSON tail", async () => {
		const baseDir = path.join(tmpDir, "ai-code-stats", "v1")
		const queueDir = path.join(baseDir, "upload-events")
		const event = {
			eventId: "event-after-partial-tail",
			timestamp: new Date("2026-03-19T12:00:00.000Z").getTime(),
			semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
			sourceType: "agent_insert" as const,
			ide: "vscode",
			metricType: "generated" as const,
			projectKey: "project-key",
			projectName: "repo",
			repoRoot: "/repo",
			repoRelativePath: "src/a.ts",
			filePath: "/repo/src/a.ts",
			relativePath: "src/a.ts",
			lineStart: 1,
			lineEnd: 1,
			lineCount: 1,
			codeSnippet: "const recovered = true",
		}
		const state = {
			version: 1,
			pendingEventIds: [event.eventId],
			supersededEventIds: [],
			repoObservedCommits: {},
			lastUpload: { status: "idle" },
		}
		await fs.mkdir(queueDir, { recursive: true })
		await fs.writeFile(path.join(queueDir, "2026-03-19.ndjson"), '{"eventId":"interrupted', "utf8")
		await fs.writeFile(
			path.join(baseDir, "pending-transaction.json"),
			JSON.stringify({
				version: 1,
				uploadEvents: [event],
				writes: [{ key: "state", value: state }],
			}),
			"utf8",
		)

		const reloadedStore = new AiCodeStatsStore(tmpDir)

		expect((await reloadedStore.getPendingEvents()).map((item) => item.eventId)).toEqual([event.eventId])
		const records = (await fs.readFile(path.join(queueDir, "2026-03-19.ndjson"), "utf8"))
			.split("\n")
			.filter(Boolean)
		expect(records).toHaveLength(2)
		expect(JSON.parse(records[1]).eventId).toBe(event.eventId)
	})

	it("archives an invalid pending transaction instead of permanently blocking the store", async () => {
		const baseDir = path.join(tmpDir, "ai-code-stats", "v1")
		await fs.mkdir(baseDir, { recursive: true })
		await fs.writeFile(path.join(baseDir, "pending-transaction.json"), '{"version":1,"writes":', "utf8")

		const reloadedStore = new AiCodeStatsStore(tmpDir)

		await expect(reloadedStore.getRawStateForTests()).resolves.toMatchObject({
			version: 1,
			pendingEventIds: [],
		})
		const files = await fs.readdir(baseDir)
		expect(files).not.toContain("pending-transaction.json")
		expect(files.some((fileName) => fileName.startsWith("pending-transaction.json.invalid-"))).toBe(true)
	})

	it("keeps automatic reanalysis records hidden from the visible failure list", async () => {
		await store.upsertCommitUploadRecord({
			commitHash: "commit-auto",
			repoRoot: "/repo",
			reportId: "replay-auto",
			status: "auto_reanalysis_pending",
			autoRetryCount: 1,
			nextAutoRetryAt: Date.now() + 5 * 60 * 1000,
		})
		await store.upsertCommitUploadRecord({
			commitHash: "commit-visible",
			repoRoot: "/repo",
			reportId: "replay-visible",
			status: "reanalysis_failed",
		})

		const allRecords = await store.getCommitUploadRecords()
		expect(allRecords.find((record) => record.commitHash === "commit-auto")).toMatchObject({
			status: "auto_reanalysis_pending",
			autoRetryCount: 1,
			nextAutoRetryAt: expect.any(Number),
		})

		const visibleRecords = await store.getVisibleCommitUploadRecords()
		expect(visibleRecords.map((record) => record.commitHash)).toEqual(["commit-visible"])
	})

	it("discards incompatible persisted state versions and cold starts", async () => {
		const baseDir = path.join(tmpDir, "ai-code-stats", "v1")
		await fs.mkdir(baseDir, { recursive: true })
		await fs.writeFile(
			path.join(baseDir, "state.json"),
			JSON.stringify({
				version: 6,
				lastUpload: { status: "success", uploadedEvents: 3 },
			}),
			"utf8",
		)

		const reloadedStore = new AiCodeStatsStore(tmpDir)
		expect(await reloadedStore.getPendingEventCount()).toBe(0)
		expect((await reloadedStore.getRawStateForTests()).lastUpload).toEqual({ status: "idle" })
		const archivedStores = (await fs.readdir(path.join(tmpDir, "ai-code-stats"))).filter((name) =>
			name.startsWith("v1.incompatible-"),
		)
		expect(archivedStores).toHaveLength(1)
		expect(
			JSON.parse(await fs.readFile(path.join(tmpDir, "ai-code-stats", archivedStores[0], "state.json"), "utf8")),
		).toMatchObject({ version: 6 })
	})

	it("recovers durable event bodies when state.json is corrupt", async () => {
		const baseDir = path.join(tmpDir, "ai-code-stats", "v1")
		const queueDir = path.join(baseDir, "upload-events")
		const event = {
			eventId: "event-recovered-from-outbox",
			timestamp: new Date("2026-03-19T12:00:00.000Z").getTime(),
			semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
			sourceType: "agent_insert" as const,
			ide: "vscode",
			metricType: "generated" as const,
			projectKey: "project-key",
			projectName: "repo",
			repoRoot: "/repo",
			repoRelativePath: "src/a.ts",
			filePath: "/repo/src/a.ts",
			relativePath: "src/a.ts",
			lineStart: 1,
			lineEnd: 1,
			lineCount: 1,
			codeSnippet: "const recovered = true",
		}
		await fs.mkdir(queueDir, { recursive: true })
		await fs.writeFile(path.join(queueDir, "2026-03-19.ndjson"), `${JSON.stringify(event)}\n`, "utf8")
		await fs.writeFile(path.join(baseDir, "state.json"), "{not-json", "utf8")

		const reloadedStore = new AiCodeStatsStore(tmpDir)

		expect((await reloadedStore.getPendingEvents()).map((item) => item.eventId)).toEqual([event.eventId])
		const archivedStateFiles = (await fs.readdir(baseDir)).filter((name) => name.startsWith("state.json.corrupt-"))
		expect(archivedStateFiles).toHaveLength(1)
	})

	it("preserves a corrupt commit-report outbox file as forensic evidence", async () => {
		const baseDir = path.join(tmpDir, "ai-code-stats", "v1")
		await fs.mkdir(baseDir, { recursive: true })
		await fs.writeFile(path.join(baseDir, "queued-reports.json"), "[broken", "utf8")

		const reloadedStore = new AiCodeStatsStore(tmpDir)

		expect(await reloadedStore.getQueuedReportsForTests()).toEqual([])
		const files = await fs.readdir(baseDir)
		expect(files.some((fileName) => fileName.startsWith("queued-reports.json.corrupt-"))).toBe(true)
		expect(JSON.parse(await fs.readFile(path.join(baseDir, "queued-reports.json"), "utf8"))).toEqual([])
	})

	it("durably quarantines unknown structural poison while dropping only explicit older semantics", async () => {
		const baseDir = path.join(tmpDir, "ai-code-stats", "v1")
		await fs.mkdir(baseDir, { recursive: true })
		const healthy = buildQueuedReport({
			report: {
				...buildQueuedReport().report,
				reportId: "healthy-structural-report",
				commitHash: "healthy-structural-commit",
			},
		})
		const missingReport = { createdAt: 1, generatedBlockIds: [] }
		const malformedSemantics = {
			...buildQueuedReport(),
			report: {
				...buildQueuedReport().report,
				reportId: "malformed-semantics-report",
				semanticsVersion: String(CURRENT_AI_CODE_STATS_SEMANTICS_VERSION),
			},
		}
		const unknownFutureSemantics = {
			...buildQueuedReport(),
			report: {
				...buildQueuedReport().report,
				reportId: "unknown-future-semantics-report",
				semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION + 1,
			},
		}
		const explicitLegacy = {
			...buildQueuedReport(),
			report: {
				...buildQueuedReport().report,
				reportId: "explicit-legacy-report",
				semanticsVersion: 1,
			},
		}
		await fs.writeFile(
			path.join(baseDir, "queued-reports.json"),
			JSON.stringify([null, missingReport, malformedSemantics, unknownFutureSemantics, explicitLegacy, healthy]),
			"utf8",
		)

		let reloadedStore = new AiCodeStatsStore(tmpDir)
		expect((await reloadedStore.getQueuedReportsForTests()).map((queued) => queued.report.reportId)).toEqual([
			"healthy-structural-report",
		])
		expect(await reloadedStore.getPendingEventCount()).toBe(4)
		expect((await reloadedStore.getQuarantinedPendingFactStatus()).count).toBe(4)
		expect((await reloadedStore.getCommitUploadDiagnostics()).quarantinedOutboxRecords).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "commit_report", sourceIndex: 0 }),
				expect.objectContaining({ kind: "commit_report", sourceIndex: 1 }),
				expect.objectContaining({ kind: "commit_report", reportId: "malformed-semantics-report" }),
				expect.objectContaining({ kind: "commit_report", reportId: "unknown-future-semantics-report" }),
			]),
		)

		await reloadedStore.queueCommitReport(
			buildQueuedReport({
				report: {
					...buildQueuedReport().report,
					reportId: "later-healthy-report",
					commitHash: "later-healthy-commit",
				},
			}),
		)
		reloadedStore = new AiCodeStatsStore(tmpDir)
		expect((await reloadedStore.getQueuedReportsForTests()).map((queued) => queued.report.reportId).sort()).toEqual(
			["healthy-structural-report", "later-healthy-report"],
		)
		expect((await reloadedStore.getQuarantinedPendingFactStatus()).count).toBe(4)
		const persisted = JSON.parse(await fs.readFile(path.join(baseDir, "queued-reports.json"), "utf8"))
		expect(persisted).toEqual(
			expect.arrayContaining([
				null,
				missingReport,
				expect.objectContaining({
					report: expect.objectContaining({ reportId: "malformed-semantics-report" }),
				}),
				expect.objectContaining({
					report: expect.objectContaining({ reportId: "unknown-future-semantics-report" }),
				}),
			]),
		)
		expect(persisted.some((queued: any) => queued?.report?.reportId === "explicit-legacy-report")).toBe(false)
	})

	it("quarantines one poisoned pending line without deleting healthy lines on later persistence", async () => {
		const baseDir = path.join(tmpDir, "ai-code-stats", "v1")
		await fs.mkdir(baseDir, { recursive: true })
		const healthy = buildPendingLine({ id: "healthy-pending-line" })
		const poisoned = {
			...buildPendingLine({
				id: "poisoned-pending-line",
				generatedEventId: "poisoned-generated-reference",
				blockId: "poisoned-generated-reference",
			}),
			filePath: { invalid: "non-string-path" },
		}
		await fs.writeFile(
			path.join(baseDir, "state.json"),
			JSON.stringify({
				version: 1,
				pendingEventIds: [],
				supersededEventIds: [],
				repoObservedCommits: { "/repo": "observed-commit" },
				lastUpload: { status: "idle" },
			}),
			"utf8",
		)
		await fs.writeFile(path.join(baseDir, "pending-lines.json"), JSON.stringify([poisoned, healthy]), "utf8")
		await fs.writeFile(
			path.join(baseDir, "generated-blocks.json"),
			JSON.stringify([
				buildGeneratedBlockState({
					stateId: "poisoned-generated-reference",
					eventId: "poisoned-generated-reference",
					generatedBlockId: "poisoned-generated-reference",
					uploadStatus: "uploaded",
				}),
			]),
			"utf8",
		)

		let reloadedStore = new AiCodeStatsStore(tmpDir)
		expect((await reloadedStore.getRawPendingLineAttributionsForTests()).map((line) => line.id)).toEqual([
			"healthy-pending-line",
		])
		expect((await reloadedStore.getCommitUploadDiagnostics()).quarantinedOutboxRecords).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "pending_line", eventId: "poisoned-generated-reference" }),
			]),
		)
		expect((await reloadedStore.getGeneratedBlocksForTests()).map((block) => block.generatedBlockId)).toEqual([
			"poisoned-generated-reference",
		])
		expect(await reloadedStore.getRepoObservedCommit("/repo")).toBe("observed-commit")

		await reloadedStore.addPendingLineAttributions([buildPendingLine({ id: "later-pending-line" })])
		reloadedStore = new AiCodeStatsStore(tmpDir)
		expect((await reloadedStore.getRawPendingLineAttributionsForTests()).map((line) => line.id).sort()).toEqual([
			"healthy-pending-line",
			"later-pending-line",
		])
		const persisted = JSON.parse(await fs.readFile(path.join(baseDir, "pending-lines.json"), "utf8"))
		expect(persisted).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "poisoned-pending-line", filePath: { invalid: "non-string-path" } }),
			]),
		)
		expect((await reloadedStore.getCommitUploadDiagnostics()).quarantinedOutboxRecords).toEqual(
			expect.arrayContaining([expect.objectContaining({ kind: "pending_line" })]),
		)
	})

	it("quarantines one poisoned generated block and protects its snapshot across restart", async () => {
		const baseDir = path.join(tmpDir, "ai-code-stats", "v1")
		const snapshotHash = "poisoned-generated-snapshot"
		await fs.mkdir(baseDir, { recursive: true })
		await fs.writeFile(
			path.join(baseDir, "snapshot-store.json"),
			JSON.stringify({
				[snapshotHash]: {
					contentHash: snapshotHash,
					content: "const poisoned = true\n",
					length: 22,
					lineCount: 1,
					createdAt: 1,
					lastUsedAt: 1,
				},
			}),
			"utf8",
		)
		const healthy = buildGeneratedBlockState({
			stateId: "healthy-generated",
			eventId: "healthy-generated",
			generatedBlockId: "healthy-generated",
		})
		const poisoned = {
			...buildGeneratedBlockState({
				stateId: "poisoned-generated",
				eventId: "poisoned-generated",
				generatedBlockId: "poisoned-generated",
				fileSnapshotHash: snapshotHash,
			}),
			filePath: { invalid: "non-string-path" },
		}
		await fs.writeFile(path.join(baseDir, "generated-blocks.json"), JSON.stringify([poisoned, healthy]), "utf8")

		let reloadedStore = new AiCodeStatsStore(tmpDir)
		expect((await reloadedStore.getGeneratedBlocksForTests()).map((block) => block.stateId)).toEqual([
			"healthy-generated",
		])
		expect((await reloadedStore.getSnapshotsForTests())[snapshotHash]).toMatchObject({ lastUsedAt: 1 })
		expect((await reloadedStore.getCommitUploadDiagnostics()).quarantinedOutboxRecords).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "generated_block", eventId: "poisoned-generated" }),
			]),
		)

		await reloadedStore.pruneOldData(30, Date.now())
		reloadedStore = new AiCodeStatsStore(tmpDir)
		expect((await reloadedStore.getGeneratedBlocksForTests()).map((block) => block.stateId)).toEqual([
			"healthy-generated",
		])
		expect((await reloadedStore.getSnapshotsForTests())[snapshotHash]).toBeDefined()
		const persisted = JSON.parse(await fs.readFile(path.join(baseDir, "generated-blocks.json"), "utf8"))
		expect(persisted).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					stateId: "poisoned-generated",
					filePath: { invalid: "non-string-path" },
					fileSnapshotHash: snapshotHash,
				}),
			]),
		)
	})

	it("quarantines one poisoned pending commit metric without deleting healthy metrics", async () => {
		const baseDir = path.join(tmpDir, "ai-code-stats", "v1")
		const snapshotHash = "poisoned-metric-snapshot"
		await fs.mkdir(baseDir, { recursive: true })
		await fs.writeFile(
			path.join(baseDir, "snapshot-store.json"),
			JSON.stringify({
				[snapshotHash]: {
					contentHash: snapshotHash,
					content: "const metricPoison = true\n",
					length: 26,
					lineCount: 1,
					createdAt: 1,
					lastUsedAt: 1,
				},
			}),
			"utf8",
		)
		const healthy = buildPendingCommitMetricBlock({
			eventId: "healthy-metric",
			generatedBlockId: "healthy-metric",
		})
		const poisoned = {
			...buildPendingCommitMetricBlock({
				eventId: "poisoned-metric",
				generatedBlockId: "poisoned-metric",
				fileSnapshotHash: snapshotHash,
			}),
			filePath: { invalid: "non-string-path" },
		}
		await fs.writeFile(
			path.join(baseDir, "pending-commit-metric-blocks.json"),
			JSON.stringify([poisoned, healthy]),
			"utf8",
		)

		let reloadedStore = new AiCodeStatsStore(tmpDir)
		expect((await reloadedStore.getPendingCommitMetricBlocksForTests()).map((block) => block.eventId)).toEqual([
			"healthy-metric",
		])
		expect((await reloadedStore.getSnapshotsForTests())[snapshotHash]).toMatchObject({ lastUsedAt: 1 })
		expect((await reloadedStore.getCommitUploadDiagnostics()).quarantinedOutboxRecords).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "pending_commit_metric_block", eventId: "poisoned-metric" }),
			]),
		)

		await reloadedStore.addPendingCommitMetricBlocks([
			buildPendingCommitMetricBlock({ eventId: "later-metric", generatedBlockId: "later-metric" }),
		])
		reloadedStore = new AiCodeStatsStore(tmpDir)
		expect(
			(await reloadedStore.getPendingCommitMetricBlocksForTests()).map((block) => block.eventId).sort(),
		).toEqual(["healthy-metric", "later-metric"])
		expect((await reloadedStore.getSnapshotsForTests())[snapshotHash]).toBeDefined()
		const persisted = JSON.parse(await fs.readFile(path.join(baseDir, "pending-commit-metric-blocks.json"), "utf8"))
		expect(persisted).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					eventId: "poisoned-metric",
					filePath: { invalid: "non-string-path" },
					fileSnapshotHash: snapshotHash,
				}),
			]),
		)
	})

	it("quarantines one poisoned commit upload record without deleting healthy diagnostics", async () => {
		const baseDir = path.join(tmpDir, "ai-code-stats", "v1")
		await fs.mkdir(baseDir, { recursive: true })
		const healthy = {
			id: "healthy-record",
			commitHash: "healthy-commit",
			repoRoot: "/repo",
			status: "upload_failed",
			createdAt: 1,
			updatedAt: 1,
		}
		const poisoned = {
			...healthy,
			id: "poisoned-record",
			commitHash: "poisoned-commit",
			repoRoot: { invalid: "non-string-path" },
		}
		await fs.writeFile(
			path.join(baseDir, "commit-upload-records.json"),
			JSON.stringify([poisoned, healthy]),
			"utf8",
		)

		let reloadedStore = new AiCodeStatsStore(tmpDir)
		expect((await reloadedStore.getCommitUploadRecords()).map((record) => record.id)).toEqual(["healthy-record"])
		expect((await reloadedStore.getCommitUploadDiagnostics()).quarantinedOutboxRecords).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "commit_upload_record", commitHash: "poisoned-commit" }),
			]),
		)

		await reloadedStore.upsertCommitUploadRecord({
			commitHash: "later-commit",
			repoRoot: "/repo",
			status: "upload_failed",
		})
		reloadedStore = new AiCodeStatsStore(tmpDir)
		expect((await reloadedStore.getCommitUploadRecords()).map((record) => record.commitHash).sort()).toEqual([
			"healthy-commit",
			"later-commit",
		])
		const persisted = JSON.parse(await fs.readFile(path.join(baseDir, "commit-upload-records.json"), "utf8"))
		expect(persisted).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "poisoned-record",
					repoRoot: { invalid: "non-string-path" },
				}),
			]),
		)
	})

	it("reloads durable state after a persistence failure instead of leaking rejected in-memory mutations", async () => {
		await store.getRawStateForTests()
		const persistTransaction = vi
			.spyOn(store as any, "persistTransaction")
			.mockRejectedValueOnce(new Error("simulated disk failure"))

		await expect(store.queueCommitReport(buildQueuedReport())).rejects.toThrow("simulated disk failure")
		persistTransaction.mockRestore()

		expect(await store.getQueuedReportsForTests()).toHaveLength(0)
	})

	it("clears repo commit cursors when a repo no longer has pending lines", async () => {
		const pendingLine: AiCodePendingLineAttribution = buildPendingLine({ id: "line-1" })

		await store.addPendingLineAttributions([pendingLine])
		await store.setRepoObservedCommit("/repo", "abc123")
		await store.setRepoObservedCommit("/repo", "branch-a-tip", "feature/a")
		await store.setRepoObservedCommit("/repo", "branch-b-tip", "feature/b")
		expect(await store.getRepoObservedCommit("/repo")).toBe("abc123")
		expect(await store.getRepoObservedCommit("/repo", "feature/a")).toBe("branch-a-tip")
		expect(await store.getRepoObservedCommit("/repo", "feature/b")).toBe("branch-b-tip")

		await store.removePendingLineAttributions(["line-1"])
		expect(await store.getRepoObservedCommit("/repo")).toBeUndefined()
		expect(await store.getRepoObservedCommit("/repo", "feature/a")).toBeUndefined()
		expect(await store.getRepoObservedCommit("/repo", "feature/b")).toBeUndefined()
	})

	it("queues and acknowledges commit lifecycle reports independently from commit reports", async () => {
		await store.queueCommitReport(buildQueuedReport())
		await store.queueCommitLifecycleReport(buildQueuedLifecycleReport())
		await store.queueCommitLifecycleReport(buildQueuedLifecycleReport())

		expect(await store.getQueuedReportsForTests()).toHaveLength(1)
		const lifecycleReports = await store.getQueuedCommitLifecycleReportsForTests()
		expect(lifecycleReports).toHaveLength(1)
		expect(lifecycleReports[0].report).toMatchObject({
			mode: "commit_lifecycle",
			eventId: "lifecycle-1",
			eventType: "commit_replaced",
			reason: "amend",
			confidence: "strong",
			commitHashes: ["old-commit"],
			replacementCommitHashes: ["new-commit"],
		})

		await store.markQueuedCommitLifecycleReportBlocked("lifecycle-1", "invalid local lifecycle payload")
		const reloadedStore = new AiCodeStatsStore(tmpDir)
		expect((await reloadedStore.getQueuedCommitLifecycleReportsForTests())[0]).toMatchObject({
			blockedReason: "invalid local lifecycle payload",
			blockedAt: expect.any(Number),
		})

		await store.acknowledgeQueuedCommitLifecycleReport("lifecycle-1")

		expect(await store.getQueuedCommitLifecycleReportsForTests()).toEqual([])
		expect(await store.getQueuedReportsForTests()).toHaveLength(1)
	})

	it("keeps pending lines while a queued report is waiting and after acknowledgement", async () => {
		await store.addPendingLineAttributions([buildPendingLine({ id: "line-1" }), buildPendingLine({ id: "line-2" })])
		await store.queueCommitReport(buildQueuedReport())

		const visiblePendingLines = await store.getPendingLineAttributions("/repo")
		expect(visiblePendingLines.map((line) => line.id)).toEqual(["line-1", "line-2"])

		await store.acknowledgeQueuedCommitReport("report-1")
		const persistedPendingLines = await store.getPendingLineAttributions("/repo")
		expect(persistedPendingLines.map((line) => line.id)).toEqual(["line-1", "line-2"])
	})

	it("queues commit reports without creating standalone upload events", async () => {
		const generationTs = new Date("2026-03-10T10:00:00.000Z").getTime()
		const commitTs = new Date("2026-03-11T10:00:00.000Z").getTime()

		await store.queueCommitReport(
			buildQueuedReport({
				report: {
					version: "v2",
					source: "kilocode-ai-code-stats",
					mode: "commit_report",
					reportId: "report-rebucket",
					reportGeneratedAt: commitTs,
					semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
					client: { ide: "vscode" },
					repoRoot: "/repo",
					projectKey: "project-key",
					projectName: "repo",
					gitBranch: "feature/stats",
					commitHash: "commit-1",
					previousCommitHash: "commit-0",
					commitOccurredAt: commitTs,
					generatedBlocks: [
						{
							eventId: "gen-baseline",
							generatedBlockId: "generated-block-1",
							timestamp: generationTs,
							semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
							sourceType: "agent_insert",
							ide: "vscode",
							projectKey: "project-key",
							projectName: "repo",
							repoRoot: "/repo",
							repoRelativePath: "src/a.ts",
							filePath: "/workspace/src/a.ts",
							relativePath: "src/a.ts",
							lineStart: 1,
							lineEnd: 4,
							lineCount: 4,
							codeSnippet: "const a = 1\nconst b = 2\nconst c = 3\nconst d = 4",
						},
					],
					acceptedBlocks: [
						{
							eventId: "acc-baseline",
							generatedBlockId: "generated-block-1",
							timestamp: commitTs,
							semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
							sourceType: "agent_insert",
							ide: "vscode",
							projectKey: "project-key",
							projectName: "repo",
							repoRoot: "/repo",
							repoRelativePath: "src/a.ts",
							filePath: "/workspace/src/a.ts",
							relativePath: "src/a.ts",
							lineStart: 1,
							lineEnd: 4,
							lineCount: 4,
							codeSnippet: "const a = 1\nconst b = 2\nconst c = 3\nconst d = 4",
						},
					],
					changedFiles: [],
				},
				createdAt: commitTs,
				generatedBlockIds: ["generated-block-1"],
			}),
		)

		const queuedReports = await store.getQueuedReportsForTests()
		expect(queuedReports.map((report) => report.report.reportId)).toEqual(["report-rebucket"])
	})

	it("preserves product-level IDE values on queued commit report candidate lines", async () => {
		const report = buildQueuedReport()
		report.report.client = { ide: "goland" }
		report.report.candidateLines = [
			{
				clientLineId: "line-goland",
				generatedBlockId: "generated-1",
				baselineEventId: "accepted-1",
				baselineMetricType: "accepted",
				sourceTimestamp: new Date("2026-03-11T10:00:00.000Z").getTime(),
				sourceType: "agent_insert",
				ide: "goland",
				provider: "openai",
				model: "gpt-5.4",
				projectKey: "project-key",
				projectName: "repo",
				filePath: "/workspace/src/a.ts",
				relativePath: "src/a.ts",
				repoRoot: "/repo",
				repoRelativePath: "src/a.ts",
				lineNumber: 1,
				rawLine: "const value = 1",
				blockLineIndex: 1,
				blockLineCount: 1,
				lineHash: hashLineFingerprint("const value = 1"),
				occurrenceIndex: 1,
			},
		]

		await store.queueCommitReport(report)

		const queuedReports = await store.getQueuedReportsForTests()
		expect(queuedReports[0].report.client.ide).toBe("goland")
		expect(queuedReports[0].report.candidateLines?.[0].ide).toBe("goland")
		expect(queuedReports[0].report.candidateLines?.[0].provider).toBe("openai")
		expect(queuedReports[0].report.candidateLines?.[0].model).toBe("gpt-5.4")
	})

	it("prunes snapshot-store entries that are no longer referenced after queued report ack", async () => {
		const firstReport = buildQueuedReport({
			report: {
				...buildQueuedReport().report,
				reportId: "report-prune-1",
				commitHash: "commit-prune-1",
				acceptedBlocks: [
					{
						eventId: "accepted-prune-1",
						generatedBlockId: "generated-prune-1",
						timestamp: Date.now(),
						semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
						sourceType: "agent_insert",
						ide: "vscode",
						projectKey: "project-key",
						projectName: "repo",
						repoRoot: "/repo",
						repoRelativePath: "src/a.ts",
						filePath: "/repo/src/a.ts",
						relativePath: "src/a.ts",
						lineStart: 1,
						lineEnd: 1,
						lineCount: 1,
						codeSnippet: "const a = 1",
						fileSnapshotContent: "const a = 1\n",
					},
				],
				changedFiles: [],
			},
			generatedBlockIds: ["generated-prune-1"],
		})
		const secondReport = buildQueuedReport({
			report: {
				...buildQueuedReport().report,
				reportId: "report-prune-2",
				commitHash: "commit-prune-2",
				acceptedBlocks: [
					{
						eventId: "accepted-prune-2",
						generatedBlockId: "generated-prune-2",
						timestamp: Date.now(),
						semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
						sourceType: "agent_insert",
						ide: "vscode",
						projectKey: "project-key",
						projectName: "repo",
						repoRoot: "/repo",
						repoRelativePath: "src/b.ts",
						filePath: "/repo/src/b.ts",
						relativePath: "src/b.ts",
						lineStart: 1,
						lineEnd: 1,
						lineCount: 1,
						codeSnippet: "const b = 2",
						fileSnapshotContent: "const b = 2\n",
					},
				],
				changedFiles: [],
			},
			generatedBlockIds: ["generated-prune-2"],
		})

		await store.queueCommitReport(firstReport)
		await store.queueCommitReport(secondReport)
		expect(
			Object.values(await store.getSnapshotsForTests())
				.map((entry) => entry.content)
				.sort(),
		).toEqual(["const a = 1\n", "const b = 2\n"])

		await store.acknowledgeQueuedCommitReport("report-prune-1")

		expect(Object.values(await store.getSnapshotsForTests()).map((entry) => entry.content)).toEqual([
			"const b = 2\n",
		])
	})

	it("compacts old v2 queued reports on load while keeping snapshot content resolvable", async () => {
		const baseDir = path.join(tmpDir, "ai-code-stats", "v1")
		await fs.mkdir(baseDir, { recursive: true })
		await fs.writeFile(
			path.join(baseDir, "state.json"),
			JSON.stringify({
				version: 1,
				pendingEventIds: [],
				supersededEventIds: [],
				repoObservedCommits: {},
				lastUpload: { status: "idle" },
			}),
			"utf8",
		)
		await fs.writeFile(
			path.join(baseDir, "queued-reports.json"),
			JSON.stringify([
				buildQueuedReport({
					report: {
						...buildQueuedReport().report,
						reportId: "report-old-v2",
						commitHash: "commit-old-v2",
						acceptedBlocks: [
							{
								eventId: "accepted-old-v2",
								generatedBlockId: "generated-old-v2",
								timestamp: Date.now(),
								semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
								sourceType: "agent_insert",
								ide: "vscode",
								projectKey: "project-key",
								projectName: "repo",
								repoRoot: "/repo",
								repoRelativePath: "src/old.ts",
								filePath: "/repo/src/old.ts",
								relativePath: "src/old.ts",
								lineStart: 1,
								lineEnd: 1,
								lineCount: 1,
								codeSnippet: "const oldValue = 1",
								fileSnapshotContent: "const oldValue = 1\n",
							},
						],
						changedFiles: [
							{
								relativePath: "src/old.ts",
								filePath: "/repo/src/old.ts",
								language: "typescript",
								committedSnapshotContent: "const oldValue = 1\n",
								changedBlocks: [],
							},
						],
					},
					generatedBlockIds: ["generated-old-v2"],
				}),
			]),
			"utf8",
		)

		const reloadedStore = new AiCodeStatsStore(tmpDir)
		const queuedReports = await reloadedStore.getQueuedReportsForTests()
		expect(queuedReports[0].report.acceptedBlocks?.[0].fileSnapshotContent).toBe("const oldValue = 1\n")
		expect(queuedReports[0].report.changedFiles[0].committedSnapshotContent).toBe("const oldValue = 1\n")

		const persistedQueuedReports = JSON.parse(await fs.readFile(path.join(baseDir, "queued-reports.json"), "utf8"))
		expect(persistedQueuedReports[0].report.acceptedBlocks[0].fileSnapshotContent).toBeUndefined()
		expect(persistedQueuedReports[0].report.acceptedBlocks[0].fileSnapshotHash).toEqual(expect.any(String))
		expect(persistedQueuedReports[0].report.changedFiles[0].committedSnapshotContent).toBeUndefined()
		expect(persistedQueuedReports[0].report.changedFiles[0].committedSnapshotHash).toEqual(expect.any(String))
		expect(Object.values(await reloadedStore.getSnapshotsForTests()).map((entry) => entry.content)).toEqual([
			"const oldValue = 1\n",
		])
	})

	it("does not enqueue client-side committed events", async () => {
		await store.appendEvent({
			eventId: "client-committed",
			timestamp: Date.now(),
			semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
			sourceType: "agent_insert",
			ide: "vscode",
			metricType: "committed",
			projectKey: "project-key",
			projectName: "repo",
			repoRoot: "/repo",
			repoRelativePath: "src/a.ts",
			filePath: "/workspace/src/a.ts",
			relativePath: "src/a.ts",
			lineStart: 1,
			lineEnd: 1,
			lineCount: 1,
			codeSnippet: "const committed = true",
		} as any)

		expect(await store.getPendingEvents()).toHaveLength(0)
		expect(await store.getPendingEventCount()).toBe(0)
	})

	it("rejects queued commit reports when candidate sourceTimestamp is missing", async () => {
		const report = buildQueuedReport().report
		report.candidateLines = [
			{
				clientLineId: "line-without-source-time",
				generatedBlockId: "generated-1",
				baselineEventId: "accepted-1",
				baselineMetricType: "accepted",
				sourceType: "agent_insert",
				ide: "vscode",
				projectKey: "project-key",
				projectName: "repo",
				filePath: "/workspace/src/a.ts",
				relativePath: "src/a.ts",
				repoRoot: "/repo",
				repoRelativePath: "src/a.ts",
				lineNumber: 1,
				rawLine: "const value = 1",
				blockLineIndex: 1,
				blockLineCount: 1,
				lineHash: hashLineFingerprint("const value = 1"),
				occurrenceIndex: 1,
			} as any,
		]

		await expect(store.queueCommitReport(buildQueuedReport({ report }))).rejects.toThrow("without sourceTimestamp")
		expect(await store.getQueuedReportsForTests()).toHaveLength(0)
	})

	it("preserves updates from multiple extension hosts sharing global storage", async () => {
		const firstHost = new AiCodeStatsStore(tmpDir)
		const secondHost = new AiCodeStatsStore(tmpDir)
		await Promise.all([firstHost.getPendingEvents(), secondHost.getPendingEvents()])

		await firstHost.appendEvent(buildUploadEvent("event-from-first-host", 1_773_900_000_000))
		await secondHost.appendEvent(buildUploadEvent("event-from-second-host", 1_773_900_000_001))
		await firstHost.addPendingLineAttributions([buildPendingLine({ id: "line-from-first-host" })])
		await secondHost.addPendingLineAttributions([buildPendingLine({ id: "line-from-second-host" })])

		const persisted = new AiCodeStatsStore(tmpDir)
		expect((await persisted.getPendingEvents()).map((event) => event.eventId)).toEqual([
			"event-from-first-host",
			"event-from-second-host",
		])
		expect((await persisted.getPendingLineAttributions()).map((line) => line.id).sort()).toEqual([
			"line-from-first-host",
			"line-from-second-host",
		])
	})

	it("does not expose an in-flight mutation to unrelated reads before it is durable", async () => {
		await store.getPendingEvents()
		const originalPersistTransaction = (store as any).persistTransaction.bind(store)
		let enterPersist!: () => void
		let releasePersist!: () => void
		const persistEntered = new Promise<void>((resolve) => {
			enterPersist = resolve
		})
		const persistReleased = new Promise<void>((resolve) => {
			releasePersist = resolve
		})
		const persistTransaction = vi
			.spyOn(store as any, "persistTransaction")
			.mockImplementation(async (...args: unknown[]) => {
				enterPersist()
				await persistReleased
				return originalPersistTransaction(...args)
			})

		const appendPromise = store.appendEvent(buildUploadEvent("event-in-flight", 1_773_900_000_002))
		await persistEntered
		let readSettled = false
		const readPromise = store.getPendingEvents().then((events) => {
			readSettled = true
			return events
		})
		await new Promise((resolve) => setTimeout(resolve, 20))
		const settledBeforeCommit = readSettled
		releasePersist()

		await appendPromise
		await expect(readPromise).resolves.toEqual([
			expect.objectContaining({
				eventId: "event-in-flight",
			}),
		])
		expect(settledBeforeCommit).toBe(false)
		persistTransaction.mockRestore()
	})
})
