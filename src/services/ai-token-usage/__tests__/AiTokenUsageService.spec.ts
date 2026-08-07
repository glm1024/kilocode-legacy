// kilocode_change - new file
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { createHash } from "crypto"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { setFetchRetryFactorForTests } from "../../../shared/http"
import { AiTokenUsageStore } from "../AiTokenUsageStore"
import { AI_TOKEN_USAGE_MAX_DATABASE_TIMESTAMP_MILLIS, AI_TOKEN_USAGE_MIN_DATABASE_TIMESTAMP_MILLIS } from "../types"

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

const acceptedTokenResponse = (_url: string, init?: RequestInit) => {
	const rawBody = String(init?.body)
	return new Response(
		JSON.stringify({
			accepted: true,
			kind: "envelope",
			insertedEvents: JSON.parse(rawBody).rows.length,
			duplicateEvents: 0,
			payloadSha256: createHash("sha256").update(rawBody).digest("hex"),
		}),
		{ status: 200 },
	)
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
		const fetchMock = vi.fn().mockImplementation(acceptedTokenResponse)
		vi.stubGlobal("fetch", fetchMock)
		const service = AiTokenUsageService.initialize(tmpDir, async () => ({
			webhookUrl: "https://example.com/webhook",
			userEmail: "alice@example.com",
		}))
		service.start()
		await (service as any).uploadRunPromise

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
		await (service as any).uploadRunPromise
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

	it("durably records missing-email usage under a stable installation-level anonymous identity", async () => {
		mockResolveMetadata.mockResolvedValue({
			userName: "Local User",
			sourceIp: "203.0.113.7",
			projectKey: "project-alpha",
			projectName: "project-alpha",
		})
		let service = AiTokenUsageService.initialize(tmpDir, async () => ({
			webhookUrl: "https://example.com/webhook",
		}))

		await service.recordRequestUsage({
			cwd: "/workspace/project-alpha",
			inputTokens: 12,
			outputTokens: 8,
		})
		AiTokenUsageService.disposeInstance()
		service = AiTokenUsageService.initialize(tmpDir, async () => ({
			webhookUrl: "https://example.com/webhook",
		}))
		await service.recordRequestUsage({
			cwd: "/workspace/project-alpha",
			inputTokens: 3,
			outputTokens: 2,
		})

		const rows = await new AiTokenUsageStore(tmpDir).getPendingUploadRows()
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({
			identityKind: "anonymous",
			requestCount: 2,
			inputTokens: 15,
			outputTokens: 10,
			totalTokens: 25,
			uploadIssueKind: "blocked",
			uploadIssueCode: "missing_configured_user_email",
		})
		expect(rows[0].userEmail).toBeUndefined()
		expect(rows[0].userKey).toMatch(/^anonymous-install:[0-9a-f]{32}$/)
	})

	it.each([
		["below", AI_TOKEN_USAGE_MIN_DATABASE_TIMESTAMP_MILLIS - 1],
		["above", AI_TOKEN_USAGE_MAX_DATABASE_TIMESTAMP_MILLIS + 1],
	])(
		"falls back to the current time when occurredAt is %s the database-safe range",
		async (_position, occurredAt) => {
			const fetchMock = vi.fn().mockImplementation(acceptedTokenResponse)
			vi.stubGlobal("fetch", fetchMock)
			const service = AiTokenUsageService.initialize(tmpDir, async () => ({
				webhookUrl: "https://example.com/webhook",
				userEmail: "alice@example.com",
			}))
			service.start()
			await (service as any).uploadRunPromise
			const expectedOccurredAt = Date.now()

			await service.recordRequestUsage({
				cwd: "/workspace/project-alpha",
				inputTokens: 12,
				outputTokens: 8,
				occurredAt,
			})

			await vi.advanceTimersByTimeAsync(5_000)
			await (service as any).uploadRunPromise
			expect(fetchMock).toHaveBeenCalledTimes(1)
			expect(readRequestPayload(fetchMock).rows[0]).toMatchObject({
				dateKey: "2026-03-24",
				firstOccurredAt: expectedOccurredAt,
				lastOccurredAt: expectedOccurredAt,
			})
			expect(await new AiTokenUsageStore(tmpDir).getPendingUploadRows()).toHaveLength(0)
		},
	)

	it("coalesces multiple model calls into the latest daily snapshot", async () => {
		const fetchMock = vi.fn().mockImplementation(acceptedTokenResponse)
		vi.stubGlobal("fetch", fetchMock)
		const service = AiTokenUsageService.initialize(tmpDir, async () => ({
			webhookUrl: "https://example.com/webhook",
			userEmail: "alice@example.com",
		}))
		service.start()
		await (service as any).uploadRunPromise

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
		await (service as any).uploadRunPromise
		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(readRequestPayload(fetchMock).rows[0]).toMatchObject({
			requestCount: 2,
			inputTokens: 130,
			outputTokens: 50,
			totalTokens: 180,
		})
	})

	it("commit-triggered upload flushes immediately and clears the pending debounce", async () => {
		const fetchMock = vi.fn().mockImplementation(acceptedTokenResponse)
		vi.stubGlobal("fetch", fetchMock)
		const service = AiTokenUsageService.initialize(tmpDir, async () => ({
			webhookUrl: "https://example.com/webhook",
			userEmail: "alice@example.com",
		}))
		service.start()
		await (service as any).uploadRunPromise

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

	it("resumes persisted dirty rows when the service starts", async () => {
		const persistedStore = new AiTokenUsageStore(tmpDir)
		await persistedStore.recordUsage({
			occurredAt: Date.now(),
			timezone: "Asia/Shanghai",
			userName: "Alice",
			userEmail: "alice@example.com",
			sourceIp: "203.0.113.7",
			userKey: "email:alice@example.com",
			projectKey: "project-alpha",
			projectName: "project-alpha",
			repoRoot: "/workspace/project-alpha",
			ide: "vscode",
			provider: "openai",
			model: "gpt-5.4",
			requestCount: 1,
			inputTokens: 12,
			outputTokens: 8,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			totalTokens: 20,
		})

		const fetchMock = vi.fn().mockImplementation(acceptedTokenResponse)
		vi.stubGlobal("fetch", fetchMock)
		const service = AiTokenUsageService.initialize(tmpDir, async () => ({
			webhookUrl: "https://example.com/webhook",
			userEmail: "alice@example.com",
		}))

		service.start()
		await (service as any).uploadRunPromise

		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(await new AiTokenUsageStore(tmpDir).getPendingUploadRows()).toHaveLength(0)
	})

	it("makes concurrent upload callers wait for the active pass and its follow-up", async () => {
		const service = AiTokenUsageService.initialize(tmpDir, async () => ({
			webhookUrl: "https://example.com/webhook",
			userEmail: "alice@example.com",
		}))
		let resolveFirst!: () => void
		let resolveSecond!: () => void
		const firstPass = new Promise<void>((resolve) => {
			resolveFirst = resolve
		})
		const secondPass = new Promise<void>((resolve) => {
			resolveSecond = resolve
		})
		const performUpload = vi
			.spyOn(service as any, "performIncrementalUpload")
			.mockImplementationOnce(() => firstPass)
			.mockImplementationOnce(() => secondPass)

		const firstRequest = (service as any).requestUpload() as Promise<void>
		const concurrentRequest = (service as any).requestUpload() as Promise<void>
		let concurrentSettled = false
		void concurrentRequest.then(() => {
			concurrentSettled = true
		})

		resolveFirst()
		await firstPass
		await Promise.resolve()
		expect(performUpload).toHaveBeenCalledTimes(2)
		expect(concurrentSettled).toBe(false)

		resolveSecond()
		await Promise.all([firstRequest, concurrentRequest])
		expect(concurrentSettled).toBe(true)
	})
})
