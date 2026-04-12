import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { beforeEach, describe, expect, it } from "vitest"

import { AiTokenUsageStore } from "../AiTokenUsageStore"

describe("AiTokenUsageStore", () => {
	let tmpDir: string
	let store: AiTokenUsageStore

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-token-usage-store-"))
		store = new AiTokenUsageStore(tmpDir)
	})

	const recordUsage = async (occurredAt: string, totals: { input: number; output: number; total?: number }) => {
		const timestamp = new Date(occurredAt).getTime()
		await store.recordUsage({
			occurredAt: timestamp,
			timezone: "Asia/Shanghai",
			userName: "glm7",
			sourceIp: "127.0.0.1",
			userKey: "glm7|127.0.0.1",
			workspaceName: "workspace",
			projectKey: "project-alpha",
			ide: "vscode",
			provider: "openai",
			model: "gpt-5.4",
			requestCount: 1,
			inputTokens: totals.input,
			outputTokens: totals.output,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			totalTokens: totals.total ?? totals.input + totals.output,
		})
	}

	it("aggregates token usage by today, week, month, all, and custom ranges", async () => {
		const now = new Date("2026-03-19T12:00:00.000Z").getTime()
		await recordUsage("2026-02-28T09:00:00.000Z", { input: 90, output: 10 })
		await recordUsage("2026-03-01T09:00:00.000Z", { input: 80, output: 20 })
		await recordUsage("2026-03-16T09:00:00.000Z", { input: 70, output: 30 })
		await recordUsage("2026-03-19T09:00:00.000Z", { input: 40, output: 60 })

		await expect(store.getSummaryForRange({ type: "current" }, now)).resolves.toEqual({
			inputTokens: 40,
			outputTokens: 60,
			totalTokens: 100,
		})

		await expect(store.getSummaryForRange({ type: "last7days" }, now)).resolves.toEqual({
			inputTokens: 110,
			outputTokens: 90,
			totalTokens: 200,
		})

		await expect(store.getSummaryForRange({ type: "last30days" }, now)).resolves.toEqual({
			inputTokens: 190,
			outputTokens: 110,
			totalTokens: 300,
		})

		await expect(store.getSummaryForRange({ type: "all" }, now)).resolves.toEqual({
			inputTokens: 280,
			outputTokens: 120,
			totalTokens: 400,
		})

		await expect(
			store.getSummaryForRange({ type: "custom", startDate: "2026-03-01", endDate: "2026-03-16" }, now),
		).resolves.toEqual({
			inputTokens: 150,
			outputTokens: 50,
			totalTokens: 200,
		})
	})

	it("returns zeros when custom range dates are invalid", async () => {
		await recordUsage("2026-03-19T09:00:00.000Z", { input: 40, output: 60 })

		await expect(store.getSummaryForRange({ type: "custom", startDate: "2026-03-19" })).resolves.toEqual({
			inputTokens: 0,
			outputTokens: 0,
			totalTokens: 0,
		})
	})
})
