import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const {
	mockGetUserInfo,
	mockHasInstance,
	// kilocode_change start
	mockGetCurrentBranch,
	mockGetRemoteUrl,
	mockIsGitRepository,
	mockIsDetachedHead,
	// kilocode_change end
} = vi.hoisted(() => ({
	mockGetUserInfo: vi.fn(),
	mockHasInstance: vi.fn(),
	// kilocode_change start
	mockGetCurrentBranch: vi.fn(),
	mockGetRemoteUrl: vi.fn(),
	mockIsGitRepository: vi.fn(),
	mockIsDetachedHead: vi.fn(),
	// kilocode_change end
}))

vi.mock("@roo-code/cloud", () => ({
	CloudService: {
		hasInstance: mockHasInstance,
		instance: {
			getUserInfo: mockGetUserInfo,
		},
	},
}))

// kilocode_change start
vi.mock("../../code-index/managed/git-utils", () => ({
	getCurrentBranch: mockGetCurrentBranch,
	getRemoteUrl: mockGetRemoteUrl,
	isGitRepository: mockIsGitRepository,
	isDetachedHead: mockIsDetachedHead,
}))

vi.mock("../AiCodeStatsLocalIdentityResolver", () => ({
	AiCodeStatsLocalIdentityResolver: class {
		resolveUserName(configuredUserName?: string) {
			return configuredUserName?.trim() || "local-user"
		}

		resolveSourceIp() {
			return "192.168.0.24"
		}
	},
}))
// kilocode_change end

vi.mock("vscode", () => ({
	workspace: {
		getWorkspaceFolder: vi.fn(() => ({
			name: "workspace",
			uri: { fsPath: "/workspace" },
		})),
		textDocuments: [],
		workspaceFolders: [
			{
				name: "workspace",
				uri: { fsPath: "/workspace" },
			},
		],
	},
	Uri: {
		parse: (value: string) => ({
			scheme: value.startsWith("file://") ? "file" : "unknown",
			fsPath: value.replace("file://", ""),
		}),
		file: (value: string) => ({
			scheme: "file",
			fsPath: value,
		}),
	},
	env: {
		machineId: "machine-id",
		appName: "Visual Studio Code",
	},
}))

import { AiCodeStatsService } from "../AiCodeStatsService"
import { type AiCodeStatsEvent } from "../types"

const buildEvent = (overrides: Partial<AiCodeStatsEvent> = {}): AiCodeStatsEvent => ({
	eventId: overrides.eventId ?? `evt-${Math.random().toString(36).slice(2)}`,
	timestamp: overrides.timestamp ?? Date.now(),
	sourceType: overrides.sourceType ?? "agent_insert",
	ide: overrides.ide ?? "vscode",
	metricType: overrides.metricType ?? "generated",
	workspaceName: overrides.workspaceName ?? "workspace",
	workspacePath: overrides.workspacePath ?? "/workspace",
	filePath: overrides.filePath ?? "/workspace/src/a.ts",
	relativePath: overrides.relativePath ?? "src/a.ts",
	lineStart: overrides.lineStart ?? 1,
	lineEnd: overrides.lineEnd ?? 1,
	lineCount: overrides.lineCount ?? 1,
	codeSnippet: overrides.codeSnippet ?? "const value = 1",
	taskId: overrides.taskId,
})

describe("AiCodeStatsService", () => {
	beforeEach(() => {
		AiCodeStatsService.disposeInstance()
		mockHasInstance.mockReturnValue(false)
		mockGetUserInfo.mockReturnValue(undefined)
		// kilocode_change start
		mockIsGitRepository.mockResolvedValue(false)
		mockGetRemoteUrl.mockResolvedValue(undefined)
		mockGetCurrentBranch.mockResolvedValue(undefined)
		mockIsDetachedHead.mockResolvedValue(false)
		// kilocode_change end
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it("records agent insertions", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-code-stats-service-"))
		const service = AiCodeStatsService.initialize(tmpDir, async () => ({ enabled: false }))

		await service.recordAgentFileWrite({
			cwd: "/workspace",
			filePath: "/workspace/src/a.ts",
			relativePath: "src/a.ts",
			originalContent: "const a = 1\n",
			newContent: "const a = 1\nconst b = 2\n",
		})

		const summary = await service.getSummary()
		expect(summary.total.suggestedLines).toBe(0)
		expect(summary.total.generatedLines).toBe(1)
		expect(summary.total.committedLines).toBe(0)
		expect(summary.pendingEvents).toBe(1)
	})

	it("does not auto upload when only generated events are recorded", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-code-stats-service-"))
		const service = AiCodeStatsService.initialize(tmpDir, async () => ({
			webhookUrl: "https://example.com/webhook",
		}))

		const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }))
		vi.stubGlobal("fetch", fetchMock)

		await service.recordAgentFileWrite({
			cwd: "/workspace",
			filePath: "/workspace/src/generated.ts",
			relativePath: "src/generated.ts",
			originalContent: "const a = 1\n",
			newContent: "const a = 1\nconst b = 2\n",
		})

		expect(fetchMock).not.toHaveBeenCalled()
	})

	it("records suggested lines without persisting generated events", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-code-stats-service-"))
		const service = AiCodeStatsService.initialize(tmpDir, async () => ({ enabled: false }))

		await service.recordAgentSuggestion({
			originalContent: "const a = 1\n",
			newContent: "const a = 1\nconst b = 2\nconst c = 3\n",
		})

		const summary = await service.getSummary()
		expect(summary.total.suggestedLines).toBe(2)
		expect(summary.total.generatedLines).toBe(0)
		expect(summary.total.committedLines).toBe(0)
		expect(summary.pendingEvents).toBe(0)
		expect(await service.getSuggestedLines({ type: "current" })).toBe(2)
	})

	it("manual range upload updates last successful upload time", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-code-stats-service-"))
		const service = AiCodeStatsService.initialize(tmpDir, async () => ({
			webhookUrl: "https://example.com/webhook",
		}))

		await service.recordAgentFileWrite({
			cwd: "/workspace",
			filePath: "/workspace/src/b.ts",
			relativePath: "src/b.ts",
			originalContent: "const a = 1\n",
			newContent: "const a = 1\nconst c = 3\n",
		})

		const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }))
		vi.stubGlobal("fetch", fetchMock)

		const result = await service.triggerManualRangeUpload({ type: "last3days" })
		expect(result.uploadedEvents).toBe(1)

		const summary = await service.getSummary()
		expect(typeof summary.lastSuccessfulUploadAt).toBe("number")
	})

	it("uses incremental-only uploads for commit-triggered automatic uploads and coalesces a follow-up run", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-code-stats-service-"))
		const service = AiCodeStatsService.initialize(tmpDir, async () => ({
			webhookUrl: "https://example.com/webhook",
		}))
		const store = (service as any).store

		await store.appendEvent(buildEvent({ eventId: "e1" }))

		let requestTriggered = false
		const fetchMock = vi.fn(async () => {
			if (!requestTriggered) {
				requestTriggered = true
				await store.appendEvent(buildEvent({ eventId: "e2", timestamp: Date.now() + 1 }))
				void (service as any).requestCommitTriggeredUpload()
			}

			return new Response("ok", { status: 200 })
		})
		vi.stubGlobal("fetch", fetchMock)

		await (service as any).requestCommitTriggeredUpload()

		expect(fetchMock).toHaveBeenCalledTimes(2)
		const bodies = (fetchMock.mock.calls as unknown as Array<[unknown, { body: string }]>).map((call) =>
			JSON.parse(call[1].body),
		)
		expect(bodies).toHaveLength(2)
		expect(bodies.every((body) => body.mode === "incremental")).toBe(true)
		expect(await store.getPendingEventCount()).toBe(0)

		const summary = await service.getSummary()
		expect(summary.lastUpload).toMatchObject({
			status: "success",
			trigger: "commit",
			mode: "incremental",
			uploadedEvents: 1,
		})
	})

	it("rejects manual incremental uploads while another upload is already in progress", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-code-stats-service-"))
		const service = AiCodeStatsService.initialize(tmpDir, async () => ({
			webhookUrl: "https://example.com/webhook",
		}))

		;(service as any).isUploading = true

		await expect(service.triggerManualUpload()).rejects.toThrow("Upload is already in progress.")
	})

	// kilocode_change start
	it("includes cloud user and git metadata in uploaded events", async () => {
		mockHasInstance.mockReturnValue(true)
		mockGetUserInfo.mockReturnValue({
			id: "cloud-user",
			name: "Cloud User",
			email: "cloud@example.com",
			organizationId: "org-1",
			organizationName: "Org 1",
		})
		mockIsGitRepository.mockResolvedValue(true)
		mockGetRemoteUrl.mockResolvedValue("https://github.com/example/repo.git")
		mockGetCurrentBranch.mockResolvedValue("feature/stats")

		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-code-stats-service-"))
		const service = AiCodeStatsService.initialize(tmpDir, async () => ({
			webhookUrl: "https://example.com/webhook",
			userName: "Configured User",
		}))

		await service.recordAgentFileWrite({
			cwd: "/workspace",
			filePath: "/workspace/src/c.ts",
			relativePath: "src/c.ts",
			originalContent: "const a = 1\n",
			newContent: "const a = 1\nconst d = 4\n",
		})

		const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }))
		vi.stubGlobal("fetch", fetchMock)

		await service.triggerManualRangeUpload({ type: "last3days" })

		const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body as string)
		expect(firstBody.events[0]).toMatchObject({
			userName: "Configured User",
			userEmail: "cloud@example.com",
			organizationId: "org-1",
			organizationName: "Org 1",
			sourceIp: expect.any(String),
			language: "typescript",
			gitRemoteUrl: "https://github.com/example/repo.git",
			gitBranch: "feature/stats",
		})
		expect(firstBody.events[0].projectKey).toHaveLength(16)
	})
	// kilocode_change end
})
