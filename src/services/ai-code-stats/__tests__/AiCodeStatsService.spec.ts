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
	// kilocode_change end
} = vi.hoisted(() => ({
	mockGetUserInfo: vi.fn(),
	mockHasInstance: vi.fn(),
	// kilocode_change start
	mockGetCurrentBranch: vi.fn(),
	mockGetRemoteUrl: vi.fn(),
	mockIsGitRepository: vi.fn(),
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

describe("AiCodeStatsService", () => {
	beforeEach(() => {
		AiCodeStatsService.disposeInstance()
		mockHasInstance.mockReturnValue(false)
		mockGetUserInfo.mockReturnValue(undefined)
		// kilocode_change start
		mockIsGitRepository.mockResolvedValue(false)
		mockGetRemoteUrl.mockResolvedValue(undefined)
		mockGetCurrentBranch.mockResolvedValue(undefined)
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
		expect(summary.total.agentLines).toBe(1)
		expect(summary.total.totalLines).toBe(1)
		expect(summary.pendingEvents).toBe(1)
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
