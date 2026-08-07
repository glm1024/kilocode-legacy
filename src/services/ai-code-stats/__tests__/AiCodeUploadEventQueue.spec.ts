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
