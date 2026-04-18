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
import { hashLineFingerprint } from "../AiCodeLineFingerprint"
import { CURRENT_AI_CODE_STATS_SEMANTICS_VERSION } from "../types"

const execFileAsync = promisify(execFileCallback)

const createGitRepo = async (): Promise<string> => {
	const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-code-stats-repo-"))
	await execFileAsync("git", ["init"], { cwd: repoDir })
	await fs.mkdir(path.join(repoDir, "src"), { recursive: true })
	return fs.realpath(repoDir)
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

		const store = (service as any).store
		expect(await store.getPendingEventCount()).toBe(3)
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

	it("queues rejected agent suggestions as generated events", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-code-stats-service-"))
		const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-code-stats-workspace-"))
		const service = AiCodeStatsService.initialize(tmpDir, async () => ({ enabled: false, userName: "tester" }))

		await service.recordRejectedAgentSuggestion({
			cwd: workspaceDir,
			filePath: path.join(workspaceDir, "src/rejected.ts"),
			relativePath: "src/rejected.ts",
			originalContent: "const a = 1\n",
			newContent: "const a = 1\nconst rejected = true\n",
			taskId: "task-rejected",
		})

		const store = (service as any).store
		const events = await store.getPendingEvents()
		expect(events).toHaveLength(1)
		expect(events[0]).toMatchObject({
			sourceType: "agent_insert",
			metricType: "generated",
			userName: "tester",
			relativePath: "src/rejected.ts",
			lineStart: 2,
			lineEnd: 2,
			lineCount: 1,
			codeSnippet: "const rejected = true",
			taskId: "task-rejected",
		})
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
		await (service as any).handleCommitCollected({
			repoRoot: repoDir,
			branch: "feature/stats",
			commitHash: "commit-1",
			previousCommit: "commit-0",
			commitOccurredAt: Date.now(),
			changedFiles: [],
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

	it("skips report upload when a commit callback has no pending AI facts or changed files", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-code-stats-service-"))
		const service = AiCodeStatsService.initialize(tmpDir, async () => ({
			webhookUrl: "https://example.com/webhook",
		}))
		const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }))
		vi.stubGlobal("fetch", fetchMock)

		await (service as any).handleCommitCollected({
			repoRoot: "/tmp/no-data",
			branch: "feature/stats",
			commitHash: "commit-empty",
			previousCommit: "commit-prev",
			commitOccurredAt: Date.now(),
			changedFiles: [],
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

		await (service as any).handleCommitCollected({
			repoRoot: repoDir,
			branch: "feature/stats",
			commitHash: "commit-filtered",
			previousCommit: "commit-prev",
			commitOccurredAt: Date.now(),
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

		await (service as any).handleCommitCollected({
			repoRoot: repoDir,
			branch: "feature/stats",
			commitHash: "commit-math",
			previousCommit: "commit-prev",
			commitOccurredAt: Date.now(),
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
			(service as any).handleCommitCollected({
				repoRoot: repoDir,
				branch: "feature/stats",
				commitHash: "commit-missing-baseline",
				previousCommit: "commit-prev",
				commitOccurredAt: Date.now(),
				changedFiles: [],
			}),
		).rejects.toThrow("Missing pending commit metric baseline")
	})

	it("queues commit facts only for retained AI lines", async () => {
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

		const generatedBlock = (await store.getGeneratedBlocksForTests())[0]
		expect(generatedBlock).toMatchObject({
			lineCount: 14,
			codeSnippet: retainedBlock,
			fileSnapshotContent: `${finalAcceptedContent}\n`,
		})

		const commitOccurredAt = Date.now()
		await (service as any).handleCommitCollected({
			repoRoot: repoDir,
			branch: "feature/stats",
			commitHash: "commit-divide",
			previousCommit: "commit-prev",
			commitOccurredAt,
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
		})

		const queuedReports = await store.getQueuedReportsForTests()
		expect(queuedReports).toHaveLength(1)
		expect(queuedReports[0].report.attributionInputVersion).toBe(1)
		expect(queuedReports[0].report.generatedBlocks?.[0]).toMatchObject({
			codeSnippet: retainedBlock,
			fileSnapshotContent: `${finalAcceptedContent}\n`,
		})
		expect(queuedReports[0].report.acceptedBlocks?.[0]).toMatchObject({
			codeSnippet: retainedBlock,
			fileSnapshotContent: `${finalAcceptedContent}\n`,
		})
		expect(queuedReports[0].report.candidateLines).toHaveLength(14)
		expect(queuedReports[0].report.candidateLines?.[0]).toMatchObject({
			baselineMetricType: "accepted",
			sourceTimestamp: generatedBlock.timestamp,
			repoRelativePath: "src/divide.py",
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

		const generatedBlock = (await store.getGeneratedBlocksForTests())[0]
		const commitOccurredAt = Date.now()
		await (service as any).handleCommitCollected({
			repoRoot: repoDir,
			branch: "feature/stats",
			commitHash: "commit-rewrite",
			previousCommit: "commit-prev",
			commitOccurredAt,
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
		})

		const queuedReports = await store.getQueuedReportsForTests()
		expect(queuedReports).toHaveLength(1)
		expect(queuedReports[0].report.candidateLines).toHaveLength(10)
	})

	it("ignores generated-only deletions while preserving accepted attribution", async () => {
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

		const generatedBlock = (await store.getGeneratedBlocksForTests())[0]
		expect(generatedBlock).toMatchObject({
			lineCount: 4,
			codeSnippet: retainedLines.join("\n"),
			fileSnapshotContent: finalAcceptedContent,
		})

		const commitOccurredAt = Date.now()
		await (service as any).handleCommitCollected({
			repoRoot: repoDir,
			branch: "feature/stats",
			commitHash: "commit-middle-delete",
			previousCommit: "commit-prev",
			commitOccurredAt,
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
		})

		const queuedReports = await store.getQueuedReportsForTests()
		expect(queuedReports).toHaveLength(1)
		expect(queuedReports[0].report.candidateLines).toHaveLength(4)
	})

	it("queues duplicate candidate line occurrence facts without client committed attribution fields", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-code-stats-service-"))
		const repoDir = await createGitRepo()
		mockIsGitRepository.mockResolvedValue(true)
		const service = AiCodeStatsService.initialize(tmpDir, async () => ({ enabled: false }))
		const filePath = path.join(repoDir, "src/duplicates.ts")
		const newContent = [
			"const base = 0",
			"const repeated = true",
			"const repeated = true",
			"const done = true",
			"",
		].join("\n")

		await service.recordAgentFileWrite({
			cwd: repoDir,
			filePath,
			relativePath: "src/duplicates.ts",
			originalContent: "const base = 0\n",
			newContent,
			taskId: "task-duplicates",
		})

		await (service as any).handleCommitCollected({
			repoRoot: repoDir,
			branch: "feature/stats",
			commitHash: "commit-duplicates",
			previousCommit: "commit-prev",
			commitOccurredAt: Date.now(),
			changedFiles: [
				{
					relativePath: "src/duplicates.ts",
					filePath,
					language: "typescript",
					committedSnapshotContent: newContent,
					changedBlocks: [
						{
							startLine: 2,
							endLine: 4,
							lineCount: 3,
							codeSnippet: "const repeated = true\nconst repeated = true\nconst done = true",
							displayOrder: 1,
						},
					],
					addedLines: [
						{
							addedIndex: 0,
							lineNumber: 2,
							content: "const repeated = true",
							lineHash: hashLineFingerprint("const repeated = true"),
						},
						{
							addedIndex: 1,
							lineNumber: 3,
							content: "const repeated = true",
							lineHash: hashLineFingerprint("const repeated = true"),
						},
						{
							addedIndex: 2,
							lineNumber: 4,
							content: "const done = true",
							lineHash: hashLineFingerprint("const done = true"),
						},
					],
				},
			],
		})

		const queuedReports = await (service as any).store.getQueuedReportsForTests()
		expect(queuedReports).toHaveLength(1)
		const report = queuedReports[0].report
		expect((report as any).committedBlocks).toBeUndefined()
		expect((report as any).matchedPendingLineIds).toBeUndefined()
		expect(report.attributionInputVersion).toBe(1)
		expect(report.candidateLines).toHaveLength(3)
		expect(report.candidateLines?.map((line: any) => line.rawLine)).toEqual([
			"const repeated = true",
			"const repeated = true",
			"const done = true",
		])
		expect(report.candidateLines?.map((line: any) => line.occurrenceIndex)).toEqual([1, 2, 1])
		expect(report.candidateLines?.map((line: any) => line.blockLineIndex)).toEqual([1, 2, 3])
		expect(report.candidateLines?.[0]).toMatchObject({
			baselineMetricType: "accepted",
			lineHash: hashLineFingerprint("const repeated = true"),
			repoRelativePath: "src/duplicates.ts",
		})
		expect(report.changedFiles[0].addedLines).toEqual([
			{
				addedIndex: 0,
				lineNumber: 2,
				content: "const repeated = true",
				lineHash: hashLineFingerprint("const repeated = true"),
			},
			{
				addedIndex: 1,
				lineNumber: 3,
				content: "const repeated = true",
				lineHash: hashLineFingerprint("const repeated = true"),
			},
			{
				addedIndex: 2,
				lineNumber: 4,
				content: "const done = true",
				lineHash: hashLineFingerprint("const done = true"),
			},
		])
	})

	it("keeps old-path candidates when commit facts report a rename", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-code-stats-service-"))
		const repoDir = await createGitRepo()
		mockIsGitRepository.mockResolvedValue(true)
		const service = AiCodeStatsService.initialize(tmpDir, async () => ({ enabled: false }))
		const oldPath = path.join(repoDir, "src/oldName.ts")
		const newPath = path.join(repoDir, "src/newName.ts")

		await service.recordAgentFileWrite({
			cwd: repoDir,
			filePath: oldPath,
			relativePath: "src/oldName.ts",
			originalContent: "",
			newContent: "export const renamedValue = 1\n",
			taskId: "task-rename",
		})

		await (service as any).handleCommitCollected({
			repoRoot: repoDir,
			branch: "feature/stats",
			commitHash: "commit-rename",
			previousCommit: "commit-prev",
			commitOccurredAt: Date.now(),
			changedFiles: [
				{
					relativePath: "src/newName.ts",
					filePath: newPath,
					previousFilePath: oldPath,
					language: "typescript",
					committedSnapshotContent: "export const renamedValue = 1\n",
					changedBlocks: [
						{
							startLine: 1,
							endLine: 1,
							lineCount: 1,
							codeSnippet: "export const renamedValue = 1",
							displayOrder: 1,
						},
					],
					addedLines: [
						{
							addedIndex: 0,
							lineNumber: 1,
							content: "export const renamedValue = 1",
							lineHash: hashLineFingerprint("export const renamedValue = 1"),
						},
					],
				},
			],
		})

		const queuedReports = await (service as any).store.getQueuedReportsForTests()
		expect(queuedReports).toHaveLength(1)
		const report = queuedReports[0].report
		expect(report.generatedBlocks?.[0]).toMatchObject({
			relativePath: "src/oldName.ts",
			filePath: oldPath,
		})
		expect(report.candidateLines?.[0]).toMatchObject({
			repoRelativePath: "src/oldName.ts",
			relativePath: "src/oldName.ts",
			rawLine: "export const renamedValue = 1",
		})
		expect(report.changedFiles[0]).toMatchObject({
			relativePath: "src/newName.ts",
			filePath: newPath,
			previousFilePath: oldPath,
			addedLines: [
				{
					addedIndex: 0,
					lineNumber: 1,
					content: "export const renamedValue = 1",
					lineHash: hashLineFingerprint("export const renamedValue = 1"),
				},
			],
		})
	})

	it("ignores non-git writes", async () => {
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

		const store = (service as any).store
		expect(await store.getPendingEventCount()).toBe(0)
		expect(await store.getGeneratedBlocksForTests()).toHaveLength(0)
		expect(await store.getQueuedReportsForTests()).toHaveLength(0)
	})

	it("queues trailing blank lines exactly as generated and changed facts", async () => {
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
		await (service as any).handleCommitCollected({
			repoRoot: repoDir,
			branch: "feature/stats",
			commitHash: "commit-trailing-exact",
			previousCommit: "commit-prev",
			commitOccurredAt,
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
		})

		const queuedReports = await store.getQueuedReportsForTests()
		expect(queuedReports).toHaveLength(1)
		expect(queuedReports[0].report.attributionInputVersion).toBe(1)
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
	})

	it("preserves shorter trailing blank line facts before queueing the report", async () => {
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
		await (service as any).handleCommitCollected({
			repoRoot: repoDir,
			branch: "feature/stats",
			commitHash: "commit-trailing-partial",
			previousCommit: "commit-prev",
			commitOccurredAt,
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
		})

		const queuedReports = await store.getQueuedReportsForTests()
		expect(queuedReports).toHaveLength(1)
		expect(queuedReports[0].report.attributionInputVersion).toBe(1)
		expect(queuedReports[0].report.acceptedBlocks?.[0]).toMatchObject({
			lineStart: 2,
			lineEnd: 3,
			lineCount: 2,
			codeSnippet: "const ai = 1\n",
		})
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

		await (service as any).handleCommitCollected({
			repoRoot: repoDir,
			branch: "feature/stats",
			commitHash: "commit-1",
			previousCommit: "commit-0",
			commitOccurredAt: Date.now(),
			changedFiles: [],
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
