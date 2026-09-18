import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { describe, expect, it } from "vitest"

import { AiCodeUploadEventQueue } from "../AiCodeUploadEventQueue"
import { CURRENT_AI_CODE_STATS_SEMANTICS_VERSION, type AiCodeStatsEvent } from "../types"

const buildEvent = (eventId: string, timestamp: number, codeSnippet = "const value = true"): AiCodeStatsEvent => ({
	eventId,
	timestamp,
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
	codeSnippet,
})

describe("AiCodeUploadEventQueue", () => {
	it("preserves deletion and model provenance across the durable outbox", async () => {
		const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-code-upload-queue-fields-"))
		const queue = new AiCodeUploadEventQueue(baseDir)
		const event: AiCodeStatsEvent = {
			...buildEvent("deletion-event", Date.now()),
			changeType: "deletion",
			provider: "openai-compatible",
			model: "mimo-v2.5",
			fileSnapshotContent: "const oldValue = true\n",
			fileSnapshotHash: "snapshot-hash",
		}

		await queue.append([event])

		await expect(queue.getPendingEvents(new Set([event.eventId]), new Set())).resolves.toEqual([
			expect.objectContaining({
				eventId: "deletion-event",
				changeType: "deletion",
				provider: "openai-compatible",
				model: "mimo-v2.5",
				fileSnapshotContent: "const oldValue = true\n",
				fileSnapshotHash: "snapshot-hash",
			}),
		])
	})

	it("segments the outbox and compacts acknowledged records without losing pending facts", async () => {
		const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-code-upload-queue-"))
		const queue = new AiCodeUploadEventQueue(baseDir)
		const timestamp = new Date("2026-03-19T12:00:00.000Z").getTime()
		const largeSnippet = "x".repeat(2 * 1024 * 1024)
		const events = [
			buildEvent("event-1", timestamp, largeSnippet),
			buildEvent("event-2", timestamp + 1, largeSnippet),
			buildEvent("event-3", timestamp + 2, largeSnippet),
		]

		await queue.append(events)
		const queueDir = path.join(baseDir, "upload-events")
		expect((await fs.readdir(queueDir)).filter((name) => name.endsWith(".ndjson")).length).toBeGreaterThan(1)

		await queue.pruneDeliveredSegments(new Set(["event-3"]))

		expect(
			(await queue.getPendingEvents(new Set(events.map((event) => event.eventId)), new Set())).map(
				(event) => event.eventId,
			),
		).toEqual(["event-3"])
	})

	it("fsyncs an appended record before publishing its new segment directory entry", async () => {
		const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-code-upload-queue-append-sync-"))
		const operations: string[] = []
		const originalOpen = fs.open.bind(fs)
		const openFile = (async (...args: Parameters<typeof fs.open>) => {
			const targetPath = path.resolve(String(args[0]))
			const handle = await originalOpen(...args)
			const label = path.basename(targetPath)
			const originalWriteFile = handle.writeFile.bind(handle)
			const originalSync = handle.sync.bind(handle)
			;(handle as any).writeFile = async (...writeArgs: unknown[]) => {
				operations.push(`write:${label}`)
				return (originalWriteFile as any)(...writeArgs)
			}
			;(handle as any).sync = async () => {
				operations.push(`sync:${label}`)
				return originalSync()
			}
			return handle
		}) as typeof fs.open
		const queue = new AiCodeUploadEventQueue(baseDir, {
			open: openFile,
			syncDirectory: async () => {
				operations.push("sync:dir")
				return true
			},
		})

		await queue.append([buildEvent("event-durable-append", Date.now())])

		const recordWrite = operations.findIndex(
			(operation) => operation.startsWith("write:") && operation.endsWith(".ndjson"),
		)
		const recordSync = operations.findIndex(
			(operation) => operation.startsWith("sync:") && operation.endsWith(".ndjson"),
		)
		const directorySync = operations.indexOf("sync:dir")
		expect(recordWrite).toBeGreaterThanOrEqual(0)
		expect(recordSync).toBeGreaterThan(recordWrite)
		expect(directorySync).toBeGreaterThan(recordSync)
	})

	it("keeps later appends unproven while a new segment directory entry is not durable", async () => {
		const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-code-upload-queue-unproven-"))
		const queue = new AiCodeUploadEventQueue(baseDir, {
			syncDirectory: async () => false,
		})
		const timestamp = new Date("2026-03-19T12:00:00.000Z").getTime()
		const firstEvent = buildEvent("unproven-first", timestamp)
		const secondEvent = buildEvent("unproven-second", timestamp + 1)

		await expect(queue.append([firstEvent])).resolves.toBe(false)
		await expect(queue.append([secondEvent])).resolves.toBe(false)

		// A fresh queue no longer has same-process unproven state and can de-duplicate
		// the observed records. The store still requires confirmDirectoryDurability
		// before clearing its journal; if the entry was lost, appendUnique recreates
		// it and returns false again.
		const duplicateSegmentSyncs: string[] = []
		const originalOpen = fs.open.bind(fs)
		const restartedOpen = (async (...args: Parameters<typeof fs.open>) => {
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
		const restartedQueue = new AiCodeUploadEventQueue(baseDir, {
			open: restartedOpen,
			syncDirectory: async () => false,
		})
		await expect(restartedQueue.appendUnique([firstEvent, secondEvent])).resolves.toBe(true)
		expect(duplicateSegmentSyncs).toHaveLength(1)
	})

	it("publishes fsynced compacted segments before unlinking the old recovery copy", async () => {
		const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-code-upload-queue-compact-sync-"))
		const queueDir = path.join(baseDir, "upload-events")
		const queue = new AiCodeUploadEventQueue(baseDir)
		const timestamp = new Date("2026-03-19T12:00:00.000Z").getTime()
		await queue.append([buildEvent("delivered", timestamp), buildEvent("pending", timestamp + 1)])
		const originalSegment = (await fs.readdir(queueDir)).find((name) => name.endsWith(".ndjson"))!

		const operations: string[] = []
		const originalOpen = fs.open.bind(fs)
		const openFile = (async (...args: Parameters<typeof fs.open>) => {
			const targetPath = path.resolve(String(args[0]))
			const handle = await originalOpen(...args)
			const label = path.basename(targetPath)
			const originalWriteFile = handle.writeFile.bind(handle)
			const originalSync = handle.sync.bind(handle)
			;(handle as any).writeFile = async (...writeArgs: unknown[]) => {
				operations.push(`write:${label}`)
				return (originalWriteFile as any)(...writeArgs)
			}
			;(handle as any).sync = async () => {
				operations.push(`sync:${label}`)
				return originalSync()
			}
			return handle
		}) as typeof fs.open
		const originalRename = fs.rename.bind(fs)
		const renameFile = (async (oldPath, newPath) => {
			operations.push(`rename:${path.basename(String(oldPath))}->${path.basename(String(newPath))}`)
			return originalRename(oldPath, newPath)
		}) as typeof fs.rename
		const originalUnlink = fs.unlink.bind(fs)
		const unlinkFile = (async (filePath) => {
			operations.push(`unlink:${path.basename(String(filePath))}`)
			return originalUnlink(filePath)
		}) as typeof fs.unlink
		const instrumentedQueue = new AiCodeUploadEventQueue(baseDir, {
			open: openFile,
			rename: renameFile,
			unlink: unlinkFile,
			syncDirectory: async () => {
				operations.push("sync:dir")
				return true
			},
		})

		await instrumentedQueue.pruneDeliveredSegments(new Set(["pending"]))

		const tempSync = operations.findIndex(
			(operation) =>
				operation.startsWith("sync:") && operation.includes(".compact-") && operation.endsWith(".tmp"),
		)
		const rename = operations.findIndex((operation) => operation.startsWith("rename:"))
		const publishDirectorySync = operations.findIndex(
			(operation, index) => index > rename && operation === "sync:dir",
		)
		const unlink = operations.findIndex((operation) => operation === `unlink:${originalSegment}`)
		const deleteDirectorySync = operations.findIndex(
			(operation, index) => index > unlink && operation === "sync:dir",
		)
		expect(tempSync).toBeGreaterThanOrEqual(0)
		expect(rename).toBeGreaterThan(tempSync)
		expect(publishDirectorySync).toBeGreaterThan(rename)
		expect(unlink).toBeGreaterThan(publishDirectorySync)
		expect(deleteDirectorySync).toBeGreaterThan(unlink)
	})

	it("retains the old segment when directory fsync is unsupported", async () => {
		const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-code-upload-queue-degraded-"))
		const queueDir = path.join(baseDir, "upload-events")
		const queue = new AiCodeUploadEventQueue(baseDir)
		const timestamp = Date.now()
		await queue.append([buildEvent("delivered", timestamp), buildEvent("pending", timestamp + 1)])
		const originalSegments = (await fs.readdir(queueDir)).filter((name) => name.endsWith(".ndjson"))
		const renameCalls: string[] = []
		const unlinkCalls: string[] = []
		const degradedQueue = new AiCodeUploadEventQueue(baseDir, {
			rename: (async (oldPath, newPath) => {
				renameCalls.push(`${String(oldPath)}->${String(newPath)}`)
				return fs.rename(oldPath, newPath)
			}) as typeof fs.rename,
			unlink: (async (filePath) => {
				unlinkCalls.push(String(filePath))
				return fs.unlink(filePath)
			}) as typeof fs.unlink,
			syncDirectory: async () => false,
		})

		await degradedQueue.pruneDeliveredSegments(new Set(["pending"]))

		expect(renameCalls).toEqual([])
		expect(unlinkCalls).toEqual([])
		expect((await fs.readdir(queueDir)).filter((name) => name.endsWith(".ndjson"))).toEqual(originalSegments)
		expect(
			(await queue.getPendingEvents(new Set(["delivered", "pending"]), new Set())).map((event) => event.eventId),
		).toEqual(["delivered", "pending"])
	})

	it("deletes fully delivered segments but retains pending segments when directory fsync is unsupported", async () => {
		const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-code-upload-queue-degraded-delete-"))
		const queue = new AiCodeUploadEventQueue(baseDir)
		await queue.append([
			buildEvent("delivered", new Date("2026-03-18T12:00:00.000Z").getTime()),
			buildEvent("pending", new Date("2026-03-19T12:00:00.000Z").getTime()),
		])
		const degradedQueue = new AiCodeUploadEventQueue(baseDir, {
			syncDirectory: async () => false,
		})

		await degradedQueue.pruneDeliveredSegments(new Set(["pending"]))

		expect(
			(await queue.getPendingEvents(new Set(["delivered", "pending"]), new Set())).map((event) => event.eventId),
		).toEqual(["pending"])
	})

	it("prunes old delivered segments without deleting old pending evidence in degraded mode", async () => {
		const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-code-upload-queue-degraded-retention-"))
		const queue = new AiCodeUploadEventQueue(baseDir)
		await queue.append([
			buildEvent("old-delivered", new Date("2026-03-17T12:00:00.000Z").getTime()),
			buildEvent("old-pending", new Date("2026-03-18T12:00:00.000Z").getTime()),
		])
		const degradedQueue = new AiCodeUploadEventQueue(baseDir, {
			syncDirectory: async () => false,
		})

		await expect(degradedQueue.pruneBefore("2026-03-20", new Set(["old-pending"]))).resolves.toEqual([
			"old-delivered",
		])
		expect(
			(await queue.getPendingEvents(new Set(["old-delivered", "old-pending"]), new Set())).map(
				(event) => event.eventId,
			),
		).toEqual(["old-pending"])
	})

	it("keeps the old segment and published duplicates when the post-rename directory sync fails", async () => {
		const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-code-upload-queue-sync-failure-"))
		const queueDir = path.join(baseDir, "upload-events")
		const queue = new AiCodeUploadEventQueue(baseDir)
		const timestamp = Date.now()
		await queue.append([buildEvent("delivered", timestamp), buildEvent("pending", timestamp + 1)])
		const originalSegment = (await fs.readdir(queueDir)).find((name) => name.endsWith(".ndjson"))!
		let directorySyncCount = 0
		const unlinkedPaths: string[] = []
		const faultingQueue = new AiCodeUploadEventQueue(baseDir, {
			unlink: (async (filePath) => {
				unlinkedPaths.push(String(filePath))
				return fs.unlink(filePath)
			}) as typeof fs.unlink,
			syncDirectory: async () => {
				directorySyncCount += 1
				if (directorySyncCount === 2) {
					const error = new Error("directory sync I/O failure") as NodeJS.ErrnoException
					error.code = "EIO"
					throw error
				}
				return true
			},
		})

		await expect(faultingQueue.pruneDeliveredSegments(new Set(["pending"]))).rejects.toThrow(
			"directory sync I/O failure",
		)

		expect(unlinkedPaths.some((filePath) => path.basename(filePath) === originalSegment)).toBe(false)
		expect((await fs.readdir(queueDir)).filter((name) => name.endsWith(".ndjson")).length).toBeGreaterThan(1)
		expect((await queue.getPendingEvents(new Set(["pending"]), new Set())).map((event) => event.eventId)).toEqual([
			"pending",
		])
	})

	it("returns a bounded prefix from a 100,000-record legacy segment", async () => {
		const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-code-upload-queue-large-"))
		const queueDir = path.join(baseDir, "upload-events")
		await fs.mkdir(queueDir, { recursive: true })
		const timestamp = new Date("2026-03-19T12:00:00.000Z").getTime()
		const pendingIds = new Set<string>()
		const records: string[] = []
		for (let index = 0; index < 100_000; index += 1) {
			const eventId = `event-${index.toString().padStart(6, "0")}`
			pendingIds.add(eventId)
			records.push(JSON.stringify(buildEvent(eventId, timestamp + index, "x")))
		}
		await fs.writeFile(path.join(queueDir, "2026-03-19.ndjson"), `${records.join("\n")}\n`, "utf8")

		const queue = new AiCodeUploadEventQueue(baseDir)
		const bounded = await queue.getPendingEvents(pendingIds, new Set(), 5)

		expect(bounded.map((event) => event.eventId)).toEqual([
			"event-000000",
			"event-000001",
			"event-000002",
			"event-000003",
			"event-000004",
		])
	}, 15_000)
})
