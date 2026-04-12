import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { execFile as execFileCallback } from "child_process"
import { promisify } from "util"

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
import { CURRENT_AI_CODE_STATS_SEMANTICS_VERSION, type AiCodeStatsEvent } from "../types"

const execFileAsync = promisify(execFileCallback)

const buildEvent = (overrides: Partial<AiCodeStatsEvent> = {}): AiCodeStatsEvent => ({
	eventId: overrides.eventId ?? `evt-${Math.random().toString(36).slice(2)}`,
	timestamp: overrides.timestamp ?? Date.now(),
	semanticsVersion: overrides.semanticsVersion ?? CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
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

const createGitRepo = async (): Promise<string> => {
	const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-code-stats-repo-"))
	await execFileAsync("git", ["init"], { cwd: repoDir })
	await fs.mkdir(path.join(repoDir, "src"), { recursive: true })
	return fs.realpath(repoDir)
}

const buildCommittedBlockFromGeneratedBlock = (generatedBlock: any, overrides: Record<string, any> = {}) => {
	const commitOccurredAt = overrides.commitOccurredAt ?? Date.now()
	return {
		eventId: overrides.eventId ?? `committed-${generatedBlock.generatedBlockId}`,
		generatedBlockId: generatedBlock.generatedBlockId,
		timestamp: commitOccurredAt,
		semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
		sourceType: generatedBlock.sourceType,
		ide: generatedBlock.ide,
		workspaceName: generatedBlock.workspaceName,
		workspacePath: generatedBlock.workspacePath,
		projectKey: generatedBlock.projectKey,
		filePath: generatedBlock.filePath,
		relativePath: generatedBlock.relativePath,
		language: generatedBlock.language,
		gitRemoteUrl: generatedBlock.gitRemoteUrl,
		gitBranch: overrides.gitBranch ?? generatedBlock.gitBranch ?? "feature/stats",
		lineStart: overrides.lineStart ?? generatedBlock.lineStart,
		lineEnd: overrides.lineEnd ?? generatedBlock.lineEnd,
		lineCount: overrides.lineCount ?? generatedBlock.lineCount,
		codeSnippet: overrides.codeSnippet ?? generatedBlock.codeSnippet,
		fileSnapshotContent: overrides.fileSnapshotContent ?? generatedBlock.fileSnapshotContent,
		taskId: generatedBlock.taskId,
		commitHash: overrides.commitHash ?? "commit-test",
		commitOccurredAt,
		matchStrategy: overrides.matchStrategy ?? "exact",
		matchConfidence: overrides.matchConfidence ?? 1,
		equivalentLineCount: overrides.equivalentLineCount ?? generatedBlock.lineCount,
	}
}

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

	it("stores canonical pending generated blocks before commit upload", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-code-stats-service-"))
		const repoDir = await createGitRepo()
		mockIsGitRepository.mockResolvedValue(true)
		const service = AiCodeStatsService.initialize(tmpDir, async () => ({ enabled: false }))

		await service.recordAgentFileWrite({
			cwd: repoDir,
			filePath: path.join(repoDir, "src/a.ts"),
			relativePath: "src/a.ts",
			originalContent: "const a = 1\n",
			newContent: "const a = 1\nconst b = 2\n",
		})

		const summary = await service.getSummary()
		expect(summary.total.suggestedLines).toBe(0)
		expect(summary.total.generatedLines).toBe(0)
		expect(summary.total.acceptedLines).toBe(0)
		expect(summary.total.committedLines).toBe(0)
		expect(summary.pendingEvents).toBe(3)

		const store = (service as any).store
		const pendingCommitMetricBlocks = await store.getPendingCommitMetricBlocksForTests()
		expect(pendingCommitMetricBlocks).toHaveLength(1)
		expect(pendingCommitMetricBlocks[0]).toMatchObject({
			generatedBlockId: expect.any(String),
			lineStart: 2,
			lineEnd: 2,
			lineCount: 1,
			codeSnippet: "const b = 2",
			fileSnapshotContent: "const a = 1\nconst b = 2\n",
		})
		const generatedBlocks = await store.getGeneratedBlocksForTests()
		expect(generatedBlocks).toHaveLength(1)
		expect(generatedBlocks[0]).toMatchObject({
			uploadStatus: "pending",
			lineStart: 2,
			lineEnd: 2,
			lineCount: 1,
			codeSnippet: "const b = 2",
			fileSnapshotContent: "const a = 1\nconst b = 2\n",
			originLineStart: 2,
			originLineEnd: 2,
			originLineCount: 1,
			originCodeSnippet: "const b = 2",
			originFileSnapshotContent: "const a = 1\nconst b = 2\n",
			currentLineStart: 2,
			currentLineEnd: 2,
			currentLineCount: 1,
			currentCodeSnippet: "const b = 2",
			currentFileSnapshotContent: "const a = 1\nconst b = 2\n",
		})
	})

	it("does not auto upload when only generated events are recorded", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-code-stats-service-"))
		const repoDir = await createGitRepo()
		mockIsGitRepository.mockResolvedValue(true)
		const service = AiCodeStatsService.initialize(tmpDir, async () => ({
			webhookUrl: "https://example.com/webhook",
		}))

		const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }))
		vi.stubGlobal("fetch", fetchMock)

		await service.recordAgentFileWrite({
			cwd: repoDir,
			filePath: path.join(repoDir, "src/generated.ts"),
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
	it("merges pending generated blocks across repeated writes in the same task context", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-code-stats-service-"))
		const repoDir = await createGitRepo()
		mockIsGitRepository.mockResolvedValue(true)
		const service = AiCodeStatsService.initialize(tmpDir, async () => ({ enabled: false }))

		await service.recordAgentFileWrite({
			cwd: repoDir,
			filePath: path.join(repoDir, "src/canonical.ts"),
			relativePath: "src/canonical.ts",
			originalContent: "const a = 1\n",
			newContent: "const a = 1\nconst b = 2\n",
			taskId: "task-1",
		})
		const store = (service as any).store
		const initialGeneratedBlock = (await store.getGeneratedBlocksForTests())[0]
		await service.recordAgentFileWrite({
			cwd: repoDir,
			filePath: path.join(repoDir, "src/canonical.ts"),
			relativePath: "src/canonical.ts",
			originalContent: "const a = 1\nconst b = 2\n",
			newContent: "const a = 1\nconst b = 2\nconst c = 3\n",
			taskId: "task-1",
		})

		const generatedBlocks = await store.getGeneratedBlocksForTests()
		expect(generatedBlocks).toHaveLength(1)
		expect(generatedBlocks[0]).toMatchObject({
			generatedBlockId: initialGeneratedBlock.generatedBlockId,
			lineStart: 2,
			lineEnd: 3,
			lineCount: 2,
			codeSnippet: "const b = 2\nconst c = 3",
			originLineStart: 2,
			originLineEnd: 2,
			originLineCount: 1,
			originCodeSnippet: "const b = 2",
			originFileSnapshotContent: "const a = 1\nconst b = 2\n",
			currentLineStart: 2,
			currentLineEnd: 3,
			currentLineCount: 2,
			currentCodeSnippet: "const b = 2\nconst c = 3",
			currentFileSnapshotContent: "const a = 1\nconst b = 2\nconst c = 3\n",
			uploadStatus: "pending",
		})
	})

	it("keeps generated blocks isolated across different task ids", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-code-stats-service-"))
		const repoDir = await createGitRepo()
		mockIsGitRepository.mockResolvedValue(true)
		const service = AiCodeStatsService.initialize(tmpDir, async () => ({ enabled: false }))

		await service.recordAgentFileWrite({
			cwd: repoDir,
			filePath: path.join(repoDir, "src/tasks.ts"),
			relativePath: "src/tasks.ts",
			originalContent: "const a = 1\n",
			newContent: "const a = 1\nconst b = 2\n",
			taskId: "task-1",
		})
		await service.recordAgentFileWrite({
			cwd: repoDir,
			filePath: path.join(repoDir, "src/tasks.ts"),
			relativePath: "src/tasks.ts",
			originalContent: "const a = 1\nconst b = 2\n",
			newContent: "const a = 1\nconst b = 2\nconst c = 3\n",
			taskId: "task-2",
		})

		const store = (service as any).store
		const generatedBlocks = await store.getGeneratedBlocksForTests()
		expect(generatedBlocks).toHaveLength(2)
		expect(generatedBlocks.map((block: any) => block.taskId)).toEqual(["task-1", "task-2"])
	})

	it("creates a new generated block id after an uploaded block is rewritten", async () => {
		mockIsGitRepository.mockResolvedValue(true)
		mockGetRemoteUrl.mockResolvedValue("https://github.com/example/repo.git")
		mockGetCurrentBranch.mockResolvedValue("feature/stats")

		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-code-stats-service-"))
		const repoDir = await createGitRepo()
		const service = AiCodeStatsService.initialize(tmpDir, async () => ({
			webhookUrl: "https://example.com/webhook",
		}))
		const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }))
		vi.stubGlobal("fetch", fetchMock)

		await service.recordAgentFileWrite({
			cwd: repoDir,
			filePath: path.join(repoDir, "src/rewrite.ts"),
			relativePath: "src/rewrite.ts",
			originalContent: "const a = 1\n",
			newContent: "const a = 1\nconst b = 2\n",
			taskId: "task-1",
		})

		const store = (service as any).store
		const initialGeneratedBlock = (await store.getGeneratedBlocksForTests())[0]
		await (service as any).handleCommitMatched({
			repoRoot: repoDir,
			branch: "feature/stats",
			commitHash: "commit-1",
			previousCommit: "commit-0",
			commitOccurredAt: Date.now(),
			committedBlocks: [],
			changedFiles: [],
			matchedPendingLineIds: [],
		})

		await service.recordAgentFileWrite({
			cwd: repoDir,
			filePath: path.join(repoDir, "src/rewrite.ts"),
			relativePath: "src/rewrite.ts",
			originalContent: "const a = 1\nconst b = 2\n",
			newContent: "const a = 1\nconst b = 20\n",
			taskId: "task-1",
		})

		const generatedBlocks = await store.getGeneratedBlocksForTests()
		const pendingBlock = generatedBlocks.find((block: any) => block.uploadStatus === "pending")
		expect(pendingBlock.generatedBlockId).not.toBe(initialGeneratedBlock.generatedBlockId)
		expect(
			generatedBlocks.some((block: any) => block.generatedBlockId === initialGeneratedBlock.generatedBlockId),
		).toBe(true)
	})

	it("skips report upload when a commit callback has no pending or committed blocks", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-code-stats-service-"))
		const service = AiCodeStatsService.initialize(tmpDir, async () => ({
			webhookUrl: "https://example.com/webhook",
		}))
		const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }))
		vi.stubGlobal("fetch", fetchMock)

		await (service as any).handleCommitMatched({
			repoRoot: "/tmp/no-data",
			branch: "feature/stats",
			commitHash: "commit-empty",
			previousCommit: "commit-prev",
			commitOccurredAt: Date.now(),
			committedBlocks: [],
			changedFiles: [],
			matchedPendingLineIds: [],
		})

		expect(fetchMock).not.toHaveBeenCalled()
	})

	it("queues only the generated blocks that belong to the current commit files", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-code-stats-service-"))
		const repoDir = await createGitRepo()
		mockIsGitRepository.mockResolvedValue(true)
		const service = AiCodeStatsService.initialize(tmpDir, async () => ({ enabled: false }))

		await service.recordAgentFileWrite({
			cwd: repoDir,
			filePath: path.join(repoDir, "src/a.ts"),
			relativePath: "src/a.ts",
			originalContent: "const a = 1\n",
			newContent: "const a = 1\nconst aiA = 1\n",
		})
		await service.recordAgentFileWrite({
			cwd: repoDir,
			filePath: path.join(repoDir, "src/b.ts"),
			relativePath: "src/b.ts",
			originalContent: "const b = 1\n",
			newContent: "const b = 1\nconst aiB = 2\n",
		})

		await (service as any).handleCommitMatched({
			repoRoot: repoDir,
			branch: "feature/stats",
			commitHash: "commit-filtered",
			previousCommit: "commit-prev",
			commitOccurredAt: Date.now(),
			committedBlocks: [],
			changedFiles: [
				{
					relativePath: "src/b.ts",
					filePath: path.join(repoDir, "src/b.ts"),
					language: "typescript",
					committedSnapshotContent: "const b = 1\nconst aiB = 2\nconst manual = 3\n",
					changedBlocks: [
						{
							startLine: 2,
							endLine: 3,
							lineCount: 2,
							codeSnippet: "const aiB = 2\nconst manual = 3",
							displayOrder: 1,
						},
					],
				},
			],
			matchedPendingLineIds: [],
		})

		const queuedReports = await (service as any).store.getQueuedReportsForTests()
		expect(queuedReports).toHaveLength(1)
		expect(queuedReports[0].report.generatedBlocks).toHaveLength(1)
		expect(queuedReports[0].report.acceptedBlocks).toHaveLength(1)
		expect(queuedReports[0].report.generatedBlocks?.[0]).toMatchObject({
			relativePath: "src/b.ts",
			fileSnapshotContent: "const b = 1\nconst aiB = 2\n",
		})
		expect(queuedReports[0].report.acceptedBlocks?.[0].relativePath).toBe("src/b.ts")
		expect(queuedReports[0].report.acceptedBlocks?.[0].fileSnapshotContent).toBe("const b = 1\nconst aiB = 2\n")
		expect(queuedReports[0].report.changedFiles).toHaveLength(1)
		expect(queuedReports[0].report.changedFiles[0]).toMatchObject({
			relativePath: "src/b.ts",
			changedBlocks: [
				{
					startLine: 2,
					endLine: 3,
					lineCount: 2,
					codeSnippet: "const aiB = 2\nconst manual = 3",
					displayOrder: 1,
				},
			],
		})
	})

	it("keeps frozen AI snapshots for accepted blocks instead of projecting the committed file snapshot", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-code-stats-service-"))
		const repoDir = await createGitRepo()
		mockIsGitRepository.mockResolvedValue(true)
		const service = AiCodeStatsService.initialize(tmpDir, async () => ({ enabled: false }))
		const filePath = path.join(repoDir, "math_utils.py")
		const aiWrittenContent = [
			'"""',
			"基础数学运算模块",
			"本模块提供基础的数学运算功能，包括加法和减法运算。",
			'"""',
			"",
			'"""add doc"""',
			"def add_numbers(a, b):",
			"    return a + b",
			"",
			"def subtract_numbers(a, b):",
			"    return a - b",
		].join("\n")
		const committedContent = [
			'"""',
			"基础数学运算模块",
			"本模块提供基础的数学运算功能，包括加法和减法运算。",
			'"""',
			"",
			"def add_numbers(a, b):",
			"    return a + b",
			"",
			"def subtract_numbers(a, b):",
			"    return a - b",
		].join("\n")

		await service.recordAgentFileWrite({
			cwd: repoDir,
			filePath,
			relativePath: "math_utils.py",
			originalContent: "",
			newContent: `${aiWrittenContent}\n`,
			taskId: "task-math",
		})

		await (service as any).handleCommitMatched({
			repoRoot: repoDir,
			branch: "feature/stats",
			commitHash: "commit-math",
			previousCommit: "commit-prev",
			commitOccurredAt: Date.now(),
			committedBlocks: [],
			changedFiles: [
				{
					relativePath: "math_utils.py",
					filePath,
					language: "python",
					committedSnapshotContent: `${committedContent}\n`,
					changedBlocks: [
						{
							startLine: 6,
							endLine: 6,
							lineCount: 1,
							codeSnippet: '"""add doc"""',
							displayOrder: 1,
						},
					],
				},
			],
			matchedPendingLineIds: [],
		})

		const queuedReports = await (service as any).store.getQueuedReportsForTests()
		expect(queuedReports).toHaveLength(1)
		expect(queuedReports[0].report.generatedBlocks).toHaveLength(1)
		expect(queuedReports[0].report.acceptedBlocks).toHaveLength(1)
		expect(queuedReports[0].report.generatedBlocks?.[0]).toMatchObject({
			relativePath: "math_utils.py",
			fileSnapshotContent: `${aiWrittenContent}\n`,
			codeSnippet: aiWrittenContent,
		})
		expect(queuedReports[0].report.acceptedBlocks?.[0]).toMatchObject({
			relativePath: "math_utils.py",
			fileSnapshotContent: `${aiWrittenContent}\n`,
			codeSnippet: aiWrittenContent,
			generatedBlockId: queuedReports[0].report.generatedBlocks?.[0].generatedBlockId,
		})
	})

	it("fails commit rebucketing when the frozen baseline is missing", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-code-stats-service-"))
		const repoDir = await createGitRepo()
		mockIsGitRepository.mockResolvedValue(true)
		const service = AiCodeStatsService.initialize(tmpDir, async () => ({ enabled: false }))
		const filePath = path.join(repoDir, "src/missing-baseline.ts")

		await service.recordAgentFileWrite({
			cwd: repoDir,
			filePath,
			relativePath: "src/missing-baseline.ts",
			originalContent: "const a = 1\n",
			newContent: "const a = 1\nconst b = 2\n",
			taskId: "task-missing-baseline",
		})

		const store = (service as any).store
		;(store as any).pendingCommitMetricBlocks = []

		await expect(
			(service as any).handleCommitMatched({
				repoRoot: repoDir,
				branch: "feature/stats",
				commitHash: "commit-missing-baseline",
				previousCommit: "commit-prev",
				commitOccurredAt: Date.now(),
				committedBlocks: [],
				changedFiles: [],
				matchedPendingLineIds: [],
			}),
		).rejects.toThrow("Missing pending commit metric baseline")
	})

	it("counts generated from the original proposal while accepted and committed follow retained AI lines", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-code-stats-service-"))
		const repoDir = await createGitRepo()
		mockIsGitRepository.mockResolvedValue(true)
		const service = AiCodeStatsService.initialize(tmpDir, async () => ({ enabled: false }))
		const filePath = path.join(repoDir, "src/divide.py")
		const originalContent = [
			"def add(a, b):",
			"    return a + b",
			"",
			"def divide(a, b):",
			"    return a / b",
			"",
		].join("\n")
		const rejectedHeader = ["# Generated by AI", "# Division helper"].join("\n")
		const retainedBlockLines = [
			"def modulo(a, b):",
			'    """',
			"    Return modulo.",
			"",
			"    Args:",
			"        a: dividend",
			"        b: divisor",
			'    """',
			"    if b == 0:",
			'        raise ValueError("zero")',
			"    result = a % b",
			"    return result",
			"",
			"# end modulo",
		]
		const retainedBlock = retainedBlockLines.join("\n")
		const proposedContent = [
			...originalContent.split("\n").slice(0, 3),
			...rejectedHeader.split("\n"),
			...originalContent.split("\n").slice(3),
			...retainedBlockLines,
		].join("\n")
		const finalAcceptedContent = [...originalContent.split("\n"), ...retainedBlockLines].join("\n")

		await service.recordAgentFileWrite({
			cwd: repoDir,
			filePath,
			relativePath: "src/divide.py",
			originalContent: `${originalContent}\n`,
			proposedContent: `${proposedContent}\n`,
			newContent: `${finalAcceptedContent}\n`,
			taskId: "task-divide",
		})

		const store = (service as any).store
		const pendingStandaloneEvents = await store.getPendingEvents()
		expect(pendingStandaloneEvents).toHaveLength(1)
		expect(pendingStandaloneEvents[0]).toMatchObject({
			metricType: "generated",
			lineCount: 2,
			codeSnippet: rejectedHeader,
			fileSnapshotContent: `${proposedContent}\n`,
		})

		const generatedBlock = (await store.getGeneratedBlocksForTests())[0]
		expect(generatedBlock).toMatchObject({
			lineCount: 14,
			codeSnippet: retainedBlock,
			fileSnapshotContent: `${finalAcceptedContent}\n`,
		})

		const commitOccurredAt = Date.now()
		await (service as any).handleCommitMatched({
			repoRoot: repoDir,
			branch: "feature/stats",
			commitHash: "commit-divide",
			previousCommit: "commit-prev",
			commitOccurredAt,
			committedBlocks: [
				buildCommittedBlockFromGeneratedBlock(generatedBlock, {
					eventId: "committed-divide",
					commitHash: "commit-divide",
					commitOccurredAt,
					codeSnippet: retainedBlock,
					fileSnapshotContent: `${finalAcceptedContent}\n`,
					lineCount: 14,
					equivalentLineCount: 14,
				}),
			],
			changedFiles: [
				{
					relativePath: "src/divide.py",
					filePath,
					language: "python",
					committedSnapshotContent: `${finalAcceptedContent}\n`,
					changedBlocks: [
						{
							startLine: generatedBlock.lineStart,
							endLine: generatedBlock.lineEnd,
							lineCount: 14,
							codeSnippet: retainedBlock,
							displayOrder: 1,
						},
					],
				},
			],
			matchedPendingLineIds: [],
		})

		const summary = await service.getSummary()
		expect(summary.total.generatedLines).toBe(16)
		expect(summary.total.acceptedLines).toBe(14)
		expect(summary.total.committedLines).toBe(14)

		const queuedReports = await store.getQueuedReportsForTests()
		expect(queuedReports).toHaveLength(1)
		expect(queuedReports[0].report.generatedBlocks?.[0]).toMatchObject({
			codeSnippet: retainedBlock,
			fileSnapshotContent: `${finalAcceptedContent}\n`,
		})
		expect(queuedReports[0].report.acceptedBlocks?.[0]).toMatchObject({
			codeSnippet: retainedBlock,
			fileSnapshotContent: `${finalAcceptedContent}\n`,
		})
		expect(queuedReports[0].report.committedBlocks[0]).toMatchObject({
			codeSnippet: retainedBlock,
			lineCount: 14,
		})
	})

	it("does not create generated-only events when the user rewrites AI lines but keeps them", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-code-stats-service-"))
		const repoDir = await createGitRepo()
		mockIsGitRepository.mockResolvedValue(true)
		const service = AiCodeStatsService.initialize(tmpDir, async () => ({ enabled: false }))
		const filePath = path.join(repoDir, "src/rewrite.ts")
		const originalContent = "const base = 0\n"
		const proposedLines = [
			"const ai1 = 1",
			"const ai2 = 2",
			"const ai3 = 3",
			"const ai4 = 4",
			"const ai5 = 5",
			"const ai6 = 6",
			"const ai7 = 7",
			"const ai8 = 8",
			"const ai9 = 9",
			"const ai10 = 10",
		]
		const finalLines = [
			"const ai1 = 1",
			"const ai2 = 20",
			"const ai3 = 3",
			"const ai4 = 40",
			"const ai5 = 5",
			"const ai6 = 6",
			"const ai7 = 7",
			"const ai8 = 8",
			"const ai9 = 9",
			"const ai10 = 10",
		]
		const proposedContent = `${originalContent}${proposedLines.join("\n")}\n`
		const finalAcceptedContent = `${originalContent}${finalLines.join("\n")}\n`

		await service.recordAgentFileWrite({
			cwd: repoDir,
			filePath,
			relativePath: "src/rewrite.ts",
			originalContent,
			proposedContent,
			newContent: finalAcceptedContent,
			taskId: "task-rewrite",
		})

		const store = (service as any).store
		expect(await store.getPendingEvents()).toHaveLength(0)

		const generatedBlock = (await store.getGeneratedBlocksForTests())[0]
		const commitOccurredAt = Date.now()
		await (service as any).handleCommitMatched({
			repoRoot: repoDir,
			branch: "feature/stats",
			commitHash: "commit-rewrite",
			previousCommit: "commit-prev",
			commitOccurredAt,
			committedBlocks: [
				buildCommittedBlockFromGeneratedBlock(generatedBlock, {
					eventId: "committed-rewrite",
					commitHash: "commit-rewrite",
					commitOccurredAt,
					codeSnippet: finalLines.join("\n"),
					fileSnapshotContent: finalAcceptedContent,
					lineCount: 10,
					equivalentLineCount: 10,
				}),
			],
			changedFiles: [
				{
					relativePath: "src/rewrite.ts",
					filePath,
					language: "typescript",
					committedSnapshotContent: finalAcceptedContent,
					changedBlocks: [
						{
							startLine: generatedBlock.lineStart,
							endLine: generatedBlock.lineEnd,
							lineCount: 10,
							codeSnippet: finalLines.join("\n"),
							displayOrder: 1,
						},
					],
				},
			],
			matchedPendingLineIds: [],
		})

		const summary = await service.getSummary()
		expect(summary.total.generatedLines).toBe(10)
		expect(summary.total.acceptedLines).toBe(10)
		expect(summary.total.committedLines).toBe(10)
	})

	it("records generated-only deletions from the middle of a single AI block without affecting accepted attribution", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-code-stats-service-"))
		const repoDir = await createGitRepo()
		mockIsGitRepository.mockResolvedValue(true)
		const service = AiCodeStatsService.initialize(tmpDir, async () => ({ enabled: false }))
		const filePath = path.join(repoDir, "src/middle-delete.ts")
		const originalContent = "const base = 0\n"
		const proposedLines = [
			"const ai1 = 1",
			"const ai2 = 2",
			"const ai3 = 3",
			"const ai4 = 4",
			"const ai5 = 5",
			"const ai6 = 6",
		]
		const retainedLines = ["const ai1 = 1", "const ai2 = 2", "const ai5 = 5", "const ai6 = 6"]
		const deletedLines = ["const ai3 = 3", "const ai4 = 4"].join("\n")
		const proposedContent = `${originalContent}${proposedLines.join("\n")}\n`
		const finalAcceptedContent = `${originalContent}${retainedLines.join("\n")}\n`

		await service.recordAgentFileWrite({
			cwd: repoDir,
			filePath,
			relativePath: "src/middle-delete.ts",
			originalContent,
			proposedContent,
			newContent: finalAcceptedContent,
			taskId: "task-middle-delete",
		})

		const store = (service as any).store
		const pendingStandaloneEvents = await store.getPendingEvents()
		expect(pendingStandaloneEvents).toHaveLength(1)
		expect(pendingStandaloneEvents[0]).toMatchObject({
			metricType: "generated",
			lineCount: 2,
			codeSnippet: deletedLines,
			fileSnapshotContent: proposedContent,
		})

		const generatedBlock = (await store.getGeneratedBlocksForTests())[0]
		expect(generatedBlock).toMatchObject({
			lineCount: 4,
			codeSnippet: retainedLines.join("\n"),
			fileSnapshotContent: finalAcceptedContent,
		})

		const commitOccurredAt = Date.now()
		await (service as any).handleCommitMatched({
			repoRoot: repoDir,
			branch: "feature/stats",
			commitHash: "commit-middle-delete",
			previousCommit: "commit-prev",
			commitOccurredAt,
			committedBlocks: [
				buildCommittedBlockFromGeneratedBlock(generatedBlock, {
					eventId: "committed-middle-delete",
					commitHash: "commit-middle-delete",
					commitOccurredAt,
					codeSnippet: retainedLines.join("\n"),
					fileSnapshotContent: finalAcceptedContent,
					lineCount: 4,
					equivalentLineCount: 4,
				}),
			],
			changedFiles: [
				{
					relativePath: "src/middle-delete.ts",
					filePath,
					language: "typescript",
					committedSnapshotContent: finalAcceptedContent,
					changedBlocks: [
						{
							startLine: generatedBlock.lineStart,
							endLine: generatedBlock.lineEnd,
							lineCount: 4,
							codeSnippet: retainedLines.join("\n"),
							displayOrder: 1,
						},
					],
				},
			],
			matchedPendingLineIds: [],
		})

		const summary = await service.getSummary()
		expect(summary.total.generatedLines).toBe(6)
		expect(summary.total.acceptedLines).toBe(4)
		expect(summary.total.committedLines).toBe(4)
	})

	it("records non-git writes with generated from the original proposal and accepted from the retained content", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-code-stats-service-"))
		const service = AiCodeStatsService.initialize(tmpDir, async () => ({ enabled: false }))
		const fileDir = path.join(tmpDir, "src")
		const filePath = path.join(fileDir, "non-git.ts")
		await fs.mkdir(fileDir, { recursive: true })

		const proposedLines = ["const ai1 = 1", "const ai2 = 2", "const ai3 = 3", "const ai4 = 4", "const ai5 = 5"]
		const finalLines = ["const ai3 = 3", "const ai4 = 4", "const ai5 = 5"]
		const proposedContent = `${proposedLines.join("\n")}\n`
		const finalAcceptedContent = `${finalLines.join("\n")}\n`

		await service.recordAgentFileWrite({
			cwd: tmpDir,
			filePath,
			relativePath: "src/non-git.ts",
			originalContent: "",
			proposedContent,
			newContent: finalAcceptedContent,
			taskId: "task-non-git",
		})

		const summary = await service.getSummary()
		expect(summary.total.generatedLines).toBe(5)
		expect(summary.total.acceptedLines).toBe(3)
		expect(summary.total.committedLines).toBe(0)

		const pendingEvents = await (service as any).store.getPendingEvents()
		expect(pendingEvents).toHaveLength(2)
		expect(pendingEvents.map((event: any) => [event.metricType, event.lineCount])).toEqual([
			["generated", 5],
			["accepted", 3],
		])
	})

	it("normalizes exact committed trailing blank lines before queueing the report", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-code-stats-service-"))
		const repoDir = await createGitRepo()
		mockIsGitRepository.mockResolvedValue(true)
		const service = AiCodeStatsService.initialize(tmpDir, async () => ({ enabled: false }))
		const filePath = path.join(repoDir, "src/trailing.py")
		const committedSnapshotContent = "const base = 0\nconst ai = 1\n\n\n"

		await service.recordAgentFileWrite({
			cwd: repoDir,
			filePath,
			relativePath: "src/trailing.py",
			originalContent: "const base = 0\n",
			newContent: committedSnapshotContent,
			taskId: "task-trailing-exact",
		})

		const store = (service as any).store
		const generatedBlock = (await store.getGeneratedBlocksForTests())[0]
		expect(generatedBlock).toMatchObject({
			lineStart: 2,
			lineEnd: 4,
			lineCount: 3,
			codeSnippet: "const ai = 1\n\n",
		})

		const commitOccurredAt = Date.now()
		await (service as any).handleCommitMatched({
			repoRoot: repoDir,
			branch: "feature/stats",
			commitHash: "commit-trailing-exact",
			previousCommit: "commit-prev",
			commitOccurredAt,
			committedBlocks: [
				{
					eventId: "committed-trailing-exact",
					generatedBlockId: generatedBlock.generatedBlockId,
					timestamp: commitOccurredAt,
					semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
					sourceType: generatedBlock.sourceType,
					ide: generatedBlock.ide,
					workspaceName: generatedBlock.workspaceName,
					workspacePath: generatedBlock.workspacePath,
					projectKey: generatedBlock.projectKey,
					filePath: generatedBlock.filePath,
					relativePath: generatedBlock.relativePath,
					language: generatedBlock.language,
					gitRemoteUrl: generatedBlock.gitRemoteUrl,
					gitBranch: "feature/stats",
					lineStart: 2,
					lineEnd: 2,
					lineCount: 1,
					codeSnippet: "const ai = 1",
					fileSnapshotContent: committedSnapshotContent,
					taskId: generatedBlock.taskId,
					commitHash: "commit-trailing-exact",
					commitOccurredAt,
					matchStrategy: "exact",
					matchConfidence: 1,
					equivalentLineCount: 1,
				},
			],
			changedFiles: [
				{
					relativePath: "src/trailing.py",
					filePath,
					language: "python",
					committedSnapshotContent,
					changedBlocks: [
						{
							startLine: 2,
							endLine: 4,
							lineCount: 3,
							codeSnippet: "const ai = 1\n\n",
							displayOrder: 1,
						},
					],
				},
			],
			matchedPendingLineIds: [],
		})

		const queuedReports = await store.getQueuedReportsForTests()
		expect(queuedReports).toHaveLength(1)
		expect(queuedReports[0].report.committedBlocks[0]).toMatchObject({
			lineStart: 2,
			lineEnd: 4,
			lineCount: 3,
			codeSnippet: "const ai = 1\n\n",
			matchStrategy: "exact",
			equivalentLineCount: 3,
		})
		expect(queuedReports[0].report.acceptedBlocks?.[0]).toMatchObject({
			lineStart: 2,
			lineEnd: 4,
			lineCount: 3,
			codeSnippet: "const ai = 1\n\n",
		})
		expect(queuedReports[0].report.changedFiles[0].changedBlocks[0]).toMatchObject({
			startLine: 2,
			endLine: 4,
			lineCount: 3,
			codeSnippet: "const ai = 1\n\n",
		})

		const summary = await service.getSummary()
		expect(summary.total.acceptedLines).toBe(3)
		expect(summary.total.committedLines).toBe(3)
	})

	it("does not normalize partial committed trailing blank lines before queueing the report", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-code-stats-service-"))
		const repoDir = await createGitRepo()
		mockIsGitRepository.mockResolvedValue(true)
		const service = AiCodeStatsService.initialize(tmpDir, async () => ({ enabled: false }))
		const filePath = path.join(repoDir, "src/trailing-partial.py")
		const committedSnapshotContent = "const base = 0\nconst ai = 1\n\n"

		await service.recordAgentFileWrite({
			cwd: repoDir,
			filePath,
			relativePath: "src/trailing-partial.py",
			originalContent: "const base = 0\n",
			newContent: committedSnapshotContent,
			taskId: "task-trailing-partial",
		})

		const store = (service as any).store
		const generatedBlock = (await store.getGeneratedBlocksForTests())[0]
		expect(generatedBlock).toMatchObject({
			lineStart: 2,
			lineEnd: 3,
			lineCount: 2,
			codeSnippet: "const ai = 1\n",
		})

		const commitOccurredAt = Date.now()
		await (service as any).handleCommitMatched({
			repoRoot: repoDir,
			branch: "feature/stats",
			commitHash: "commit-trailing-partial",
			previousCommit: "commit-prev",
			commitOccurredAt,
			committedBlocks: [
				{
					eventId: "committed-trailing-partial",
					generatedBlockId: generatedBlock.generatedBlockId,
					timestamp: commitOccurredAt,
					semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
					sourceType: generatedBlock.sourceType,
					ide: generatedBlock.ide,
					workspaceName: generatedBlock.workspaceName,
					workspacePath: generatedBlock.workspacePath,
					projectKey: generatedBlock.projectKey,
					filePath: generatedBlock.filePath,
					relativePath: generatedBlock.relativePath,
					language: generatedBlock.language,
					gitRemoteUrl: generatedBlock.gitRemoteUrl,
					gitBranch: "feature/stats",
					lineStart: 2,
					lineEnd: 2,
					lineCount: 1,
					codeSnippet: "const ai = 1",
					fileSnapshotContent: committedSnapshotContent,
					taskId: generatedBlock.taskId,
					commitHash: "commit-trailing-partial",
					commitOccurredAt,
					matchStrategy: "partial",
					matchConfidence: 0.75,
					equivalentLineCount: 0.75,
				},
			],
			changedFiles: [
				{
					relativePath: "src/trailing-partial.py",
					filePath,
					language: "python",
					committedSnapshotContent,
					changedBlocks: [
						{
							startLine: 2,
							endLine: 3,
							lineCount: 2,
							codeSnippet: "const ai = 1\n",
							displayOrder: 1,
						},
					],
				},
			],
			matchedPendingLineIds: [],
		})

		const queuedReports = await store.getQueuedReportsForTests()
		expect(queuedReports).toHaveLength(1)
		expect(queuedReports[0].report.committedBlocks[0]).toMatchObject({
			lineStart: 2,
			lineEnd: 2,
			lineCount: 1,
			codeSnippet: "const ai = 1",
			matchStrategy: "partial",
			equivalentLineCount: 0.75,
		})
		expect(queuedReports[0].report.acceptedBlocks?.[0]).toMatchObject({
			lineStart: 2,
			lineEnd: 3,
			lineCount: 2,
			codeSnippet: "const ai = 1\n",
		})

		const summary = await service.getSummary()
		expect(summary.total.acceptedLines).toBe(2)
		expect(summary.total.committedLines).toBe(1)
	})

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
		const repoDir = await createGitRepo()
		const service = AiCodeStatsService.initialize(tmpDir, async () => ({
			webhookUrl: "https://example.com/webhook",
			userName: "Configured User",
		}))

		await service.recordAgentFileWrite({
			cwd: repoDir,
			filePath: path.join(repoDir, "src/c.ts"),
			relativePath: "src/c.ts",
			originalContent: "const a = 1\n",
			newContent: "const a = 1\nconst d = 4\n",
		})

		const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }))
		vi.stubGlobal("fetch", fetchMock)

		await (service as any).handleCommitMatched({
			repoRoot: repoDir,
			branch: "feature/stats",
			commitHash: "commit-1",
			previousCommit: "commit-0",
			commitOccurredAt: Date.now(),
			committedBlocks: [],
			changedFiles: [],
			matchedPendingLineIds: [],
		})

		const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body as string)
		expect(firstBody.generatedBlocks[0]).toMatchObject({
			userName: "Configured User",
			userEmail: "cloud@example.com",
			organizationId: "org-1",
			organizationName: "Org 1",
			sourceIp: expect.any(String),
			language: "typescript",
			gitRemoteUrl: "https://github.com/example/repo.git",
			gitBranch: "feature/stats",
			fileSnapshotContent: "const a = 1\nconst d = 4\n",
		})
		expect(firstBody.acceptedBlocks[0]).toMatchObject({
			userName: "Configured User",
			userEmail: "cloud@example.com",
			organizationId: "org-1",
			organizationName: "Org 1",
			sourceIp: expect.any(String),
			language: "typescript",
			gitRemoteUrl: "https://github.com/example/repo.git",
			gitBranch: "feature/stats",
			fileSnapshotContent: "const a = 1\nconst d = 4\n",
		})
		expect(firstBody.acceptedBlocks[0].projectKey).toHaveLength(16)
	})
	// kilocode_change end
})
