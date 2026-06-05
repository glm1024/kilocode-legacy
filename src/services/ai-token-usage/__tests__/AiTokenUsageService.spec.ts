// kilocode_change - new file
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { setFetchRetryFactorForTests } from "../../../shared/http"

const { mockResolveMetadata } = vi.hoisted(() => ({
	mockResolveMetadata: vi.fn(),
}))

vi.mock("vscode", () => ({
	workspace: {
		workspaceFolders: [],
	},
	env: {
		machineId: "machine-1",
		appName: "Visual Studio Code",
	},
}))

vi.mock("../../../core/kilocode/wrapper", () => ({
	getKiloCodeWrapperProperties: () => ({
		kiloCodeWrapped: false,
		kiloCodeWrapperJetbrains: false,
	}),
}))

vi.mock("../../../shared/GitWatcher", () => ({
	GitWatcher: class {
		onEvent() {}
		start() {
			return Promise.resolve()
		}
		dispose() {}
	},
}))

vi.mock("../AiTokenUsageMetadataResolver", () => ({
	AiTokenUsageMetadataResolver: class {
		resolve(repoRoot: string | undefined, settings: unknown) {
			return mockResolveMetadata(repoRoot, settings)
		}
	},
}))

import { AiTokenUsageService } from "../AiTokenUsageService"

const readRequestPayload = (fetchMock: ReturnType<typeof vi.fn>, callIndex = 0) => {
	return JSON.parse(fetchMock.mock.calls[callIndex][1].body as string)
}

describe("AiTokenUsageService", () => {
	let tmpDir: string
	let unsetRetryFactor: (() => void) | undefined

	beforeEach(async () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date("2026-03-24T10:00:00.000+08:00"))
		AiTokenUsageService.disposeInstance()
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-token-usage-service-"))
		unsetRetryFactor = setFetchRetryFactorForTests().unset
		mockResolveMetadata.mockResolvedValue({
			userName: "Alice",
			userEmail: "alice@example.com",
			departmentName: "云存储研发部",
			officeName: "架设处",
			teamName: "研发一组",
			sourceIp: "203.0.113.7",
			organizationId: "org-1",
			organizationName: "Example Org",
			projectKey: "project-alpha",
			projectName: "project-alpha",
		})
	})

	afterEach(() => {
		AiTokenUsageService.disposeInstance()
		unsetRetryFactor?.()
		vi.unstubAllGlobals()
		vi.useRealTimers()
	})

	it("uploads token usage after the debounce window", async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }))
		vi.stubGlobal("fetch", fetchMock)
		const service = AiTokenUsageService.initialize(tmpDir, async () => ({
			webhookUrl: "https://example.com/webhook",
			userEmail: "alice@example.com",
		}))
		service.start()

		await service.recordRequestUsage({
			cwd: "/workspace/project-alpha",
			inputTokens: 120,
			outputTokens: 80,
			cacheReadTokens: 10,
			cacheWriteTokens: 5,
		})

		await vi.advanceTimersByTimeAsync(4_999)
		expect(fetchMock).not.toHaveBeenCalled()

		await vi.advanceTimersByTimeAsync(1)
		expect(fetchMock).toHaveBeenCalledTimes(1)
		const payload = readRequestPayload(fetchMock)
		expect(payload.client).toMatchObject({
			ide: "vscode",
			machineId: "machine-1",
		})
		expect(payload.rows).toHaveLength(1)
		expect(payload.rows[0]).toMatchObject({
			dateKey: "2026-03-24",
			userEmail: "alice@example.com",
			requestCount: 1,
			inputTokens: 120,
			outputTokens: 80,
			cacheReadTokens: 10,
			cacheWriteTokens: 5,
			totalTokens: 200,
		})
	})

	it("coalesces multiple model calls into the latest daily snapshot", async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }))
		vi.stubGlobal("fetch", fetchMock)
		const service = AiTokenUsageService.initialize(tmpDir, async () => ({
			webhookUrl: "https://example.com/webhook",
			userEmail: "alice@example.com",
		}))
		service.start()

		await service.recordRequestUsage({
			cwd: "/workspace/project-alpha",
			inputTokens: 100,
			outputTokens: 40,
		})
		await vi.advanceTimersByTimeAsync(4_000)
		await service.recordRequestUsage({
			cwd: "/workspace/project-alpha",
			inputTokens: 30,
			outputTokens: 10,
		})

		await vi.advanceTimersByTimeAsync(4_999)
		expect(fetchMock).not.toHaveBeenCalled()

		await vi.advanceTimersByTimeAsync(1)
		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(readRequestPayload(fetchMock).rows[0]).toMatchObject({
			requestCount: 2,
			inputTokens: 130,
			outputTokens: 50,
			totalTokens: 180,
		})
	})

	it("commit-triggered upload flushes immediately and clears the pending debounce", async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }))
		vi.stubGlobal("fetch", fetchMock)
		const service = AiTokenUsageService.initialize(tmpDir, async () => ({
			webhookUrl: "https://example.com/webhook",
			userEmail: "alice@example.com",
		}))
		service.start()

		await service.recordRequestUsage({
			cwd: "/workspace/project-alpha",
			inputTokens: 60,
			outputTokens: 20,
		})
		await (service as any).requestCommitTriggeredUpload()

		expect(fetchMock).toHaveBeenCalledTimes(1)
		await vi.advanceTimersByTimeAsync(5_000)
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})
})
