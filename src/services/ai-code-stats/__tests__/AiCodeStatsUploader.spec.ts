// kilocode_change - new file
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { setFetchRetryFactorForTests } from "../../../shared/http"
import { AiCodeStatsStore } from "../AiCodeStatsStore"
import { AiCodeStatsUploader } from "../AiCodeStatsUploader"
import { type AiCodeStatsEvent } from "../types"

const buildEvent = (overrides: Partial<AiCodeStatsEvent> = {}): AiCodeStatsEvent => ({
	eventId: overrides.eventId ?? `evt-${Math.random().toString(36).slice(2)}`,
	timestamp: overrides.timestamp ?? Date.now(),
	sourceType: overrides.sourceType ?? "agent_insert",
	ide: overrides.ide ?? "vscode",
	workspaceName: overrides.workspaceName ?? "project",
	workspacePath: overrides.workspacePath ?? "/workspace/project",
	filePath: overrides.filePath ?? "/workspace/project/src/a.ts",
	relativePath: overrides.relativePath ?? "src/a.ts",
	lineStart: overrides.lineStart ?? 1,
	lineEnd: overrides.lineEnd ?? 1,
	lineCount: overrides.lineCount ?? 1,
	codeSnippet: overrides.codeSnippet ?? "const x = 1",
	taskId: overrides.taskId,
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

	it("uploads incremental and backfill envelopes", async () => {
		const now = Date.now()
		await store.appendEvent(buildEvent({ eventId: "e1", timestamp: now }))
		await store.appendEvent(buildEvent({ eventId: "e2", timestamp: now }))

		const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }))
		vi.stubGlobal("fetch", fetchMock)

		const result = await uploader.upload(
			{ enabled: true, webhookUrl: "https://example.com/webhook" },
			{
				backfillDays: 3,
				client: {
					ide: "vscode",
				},
			},
		)

		expect(result.incrementalUploaded).toBe(2)
		expect(result.backfillUploaded).toBe(2)

		const bodies = fetchMock.mock.calls.map((call) => JSON.parse(call[1].body as string))
		expect(bodies.some((body) => body.mode === "incremental")).toBe(true)
		expect(bodies.some((body) => body.mode === "backfill")).toBe(true)

		const pendingAfter = await store.getPendingEventCount()
		expect(pendingAfter).toBe(0)
	})

	it("uploads only agent events when autocomplete events exist in history", async () => {
		const now = Date.now()
		await store.appendEvent(buildEvent({ eventId: "e-auto", timestamp: now, sourceType: "autocomplete" }))
		await store.appendEvent(buildEvent({ eventId: "e-agent", timestamp: now, sourceType: "agent_insert" }))

		const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }))
		vi.stubGlobal("fetch", fetchMock)

		const result = await uploader.upload(
			{ enabled: true, webhookUrl: "https://example.com/webhook" },
			{
				backfillDays: 3,
				client: {
					ide: "vscode",
				},
			},
		)

		expect(result.incrementalUploaded).toBe(1)
		expect(result.backfillUploaded).toBe(1)
		expect(await store.getPendingEventCount()).toBe(0)

		const rawState = await store.getRawStateForTests()
		expect(rawState.pendingEventIds).toContain("e-auto")

		const bodies = fetchMock.mock.calls.map((call) => JSON.parse(call[1].body as string))
		for (const body of bodies) {
			expect(body.events.every((event: AiCodeStatsEvent) => event.sourceType === "agent_insert")).toBe(true)
		}
	})

	it("keeps pending events when incremental upload fails", async () => {
		await store.appendEvent(buildEvent({ eventId: "e1" }))

		const fetchMock = vi.fn().mockResolvedValue(new Response("fail", { status: 500, statusText: "err" }))
		vi.stubGlobal("fetch", fetchMock)

		await expect(
			uploader.upload(
				{ enabled: true, webhookUrl: "https://example.com/webhook" },
				{
					backfillDays: 3,
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
				backfillDays: 1,
				client: { ide: "vscode" },
			},
		)

		expect(result.incrementalUploaded).toBe(1)
		expect(fetchMock).toHaveBeenCalled()
	})

	it("re-uploads history by range without advancing pending cursor", async () => {
		const day1 = new Date("2026-03-01T10:00:00.000Z").getTime()
		const day5 = new Date("2026-03-05T10:00:00.000Z").getTime()

		await store.appendEvent(buildEvent({ eventId: "e-old", timestamp: day1 }))
		await store.appendEvent(buildEvent({ eventId: "e-new", timestamp: day5 }))

		const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }))
		vi.stubGlobal("fetch", fetchMock)

		const result = await uploader.uploadRange(
			{ webhookUrl: "https://example.com/webhook" },
			{
				range: { type: "custom", startDate: "2026-03-05", endDate: "2026-03-05" },
				client: { ide: "vscode" },
			},
		)

		expect(result.uploaded).toBe(1)
		const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
		expect(body.mode).toBe("backfill")
		expect(body.events).toHaveLength(1)
		expect(body.events[0].eventId).toBe("e-new")

		expect(await store.getPendingEventCount()).toBe(2)
	})
})
