import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { setFetchRetryFactorForTests } from "../../../shared/http"
import { AiTokenUsageStore } from "../AiTokenUsageStore"
import { AiTokenUsageUploader } from "../AiTokenUsageUploader"
import { toLocalDateKey } from "../types"

describe("AiTokenUsageUploader", () => {
	let tmpDir: string
	let store: AiTokenUsageStore
	let uploader: AiTokenUsageUploader
	let unsetRetryFactor: (() => void) | undefined

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-token-usage-uploader-"))
		store = new AiTokenUsageStore(tmpDir)
		uploader = new AiTokenUsageUploader(store)
		unsetRetryFactor = setFetchRetryFactorForTests().unset
	})

	afterEach(() => {
		unsetRetryFactor?.()
		vi.unstubAllGlobals()
	})

	it("uploads dirty rows for the current day on commit-triggered uploads", async () => {
		const occurredAt = Date.now()
		await store.recordUsage({
			occurredAt,
			timezone: "Asia/Shanghai",
			userName: "alice",
			userEmail: "alice@example.com",
			departmentName: "云存储研发部",
			officeName: "架设处",
			teamName: "研发一组",
			sourceIp: "203.0.113.7",
			userKey: "email:alice@example.com",
			organizationId: "org-1",
			organizationName: "Example Org",
			projectKey: "project-alpha",
			projectName: "project-alpha",
			repoRoot: "/workspace/project-alpha",
			gitRemoteUrl: "https://github.com/example/project-alpha.git",
			gitBranch: "main",
			ide: "vscode",
			provider: "openai",
			model: "gpt-5.4",
			requestCount: 1,
			inputTokens: 120,
			outputTokens: 80,
			cacheReadTokens: 10,
			cacheWriteTokens: 5,
			totalTokens: 200,
		})

		const pendingBeforeUpload = await store.getPendingUploadRows()
		expect(pendingBeforeUpload).toHaveLength(1)
		expect(pendingBeforeUpload[0].dateKey).toBe(toLocalDateKey(occurredAt))

		const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }))
		vi.stubGlobal("fetch", fetchMock)

		const result = await uploader.upload(
			{ webhookUrl: "https://example.com/webhook", userEmail: "fallback@example.com" },
			{
				client: { ide: "vscode", machineId: "machine-1" },
			},
		)

		expect(result.uploaded).toBe(1)
		expect(fetchMock).toHaveBeenCalledTimes(1)

		const payload = JSON.parse(fetchMock.mock.calls[0][1].body as string)
		expect(payload.rows).toHaveLength(1)
		expect(payload.rows[0]).toMatchObject({
			dateKey: toLocalDateKey(occurredAt),
			userName: "alice",
			userEmail: "alice@example.com",
			departmentName: "云存储研发部",
			officeName: "架设处",
			teamName: "研发一组",
			sourceIp: "203.0.113.7",
			userKey: "email:alice@example.com",
			projectName: "project-alpha",
			repoRoot: "/workspace/project-alpha",
			gitRemoteUrl: "https://github.com/example/project-alpha.git",
			provider: "openai",
			model: "gpt-5.4",
			totalTokens: 200,
		})

		expect(await store.getPendingUploadRows()).toHaveLength(0)
	})
})
