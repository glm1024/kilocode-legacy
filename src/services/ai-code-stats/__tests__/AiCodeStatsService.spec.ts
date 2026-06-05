import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { execFile as execFileCallback } from "child_process"
import { promisify } from "util"
import { gunzip as gunzipCallback } from "zlib"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as vscode from "vscode"

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
import { CURRENT_AI_CODE_STATS_SEMANTICS_VERSION, type AiCodeCommitCandidateLine } from "../types"

const execFileAsync = promisify(execFileCallback)
const gunzipAsync = promisify(gunzipCallback)

const parseJsonBody = async (body: BodyInit | null | undefined, headers?: Record<string, string>): Promise<any> => {
	const buffer =
		body instanceof Uint8Array
			? Buffer.from(body)
			: typeof body === "string"
				? Buffer.from(body)
				: Buffer.from(body as ArrayBuffer)
	if (headers?.["Content-Encoding"] === "gzip") {
		return JSON.parse((await gunzipAsync(buffer)).toString("utf8"))
	}
	return JSON.parse(buffer.toString("utf8"))
}

const acceptedIngestResponse = (): Response =>
	new Response(JSON.stringify({ accepted: true, kind: "commit_report" }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	})

const createGitRepo = async (parentDir?: string, name?: string): Promise<string> => {
	const repoDir =
		parentDir && name ? path.join(parentDir, name) : await fs.mkdtemp(path.join(os.tmpdir(), "ai-code-stats-repo-"))
	await fs.mkdir(repoDir, { recursive: true })
	await execFileAsync("git", ["init"], { cwd: repoDir })
	await fs.mkdir(path.join(repoDir, "src"), { recursive: true })
	return fs.realpath(repoDir)
}

const commitFile = async (repoDir: string, relativePath: string, content: string, message: string): Promise<string> => {
	const filePath = path.join(repoDir, relativePath)
	await fs.mkdir(path.dirname(filePath), { recursive: true })
	await fs.writeFile(filePath, content, "utf8")
	await execFileAsync("git", ["add", relativePath], { cwd: repoDir })
	await execFileAsync(
		"git",
		["-c", "user.name=Kilo Test", "-c", "user.email=kilo-test@example.com", "commit", "-m", message],
		{ cwd: repoDir },
	)
	const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoDir })
	return stdout.trim()
}

describe("AiCodeStatsService", () => {
	beforeEach(() => {
		AiCodeStatsService.disposeInstance()
		;(vscode.env as any).appName = "Visual Studio Code"
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

	it.each([
		["PY", "pycharm"],
		["PC", "pycharm"],
		["UNKNOWN", "jetbrains"],
	])("detects JetBrains wrapper product code %s as %s", async (wrapperCode, expectedIde) => {
		;(vscode.env as any).appName = `wrapper|jetbrains|${wrapperCode}|2025.3`
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-code-stats-service-"))
		const repoDir = await createGitRepo()
		mockIsGitRepository.mockResolvedValue(true)
		const service = AiCodeStatsService.initialize(tmpDir, async () => ({ enabled: false }))

		await service.recordAgentFileWrite({
			cwd: repoDir,
			filePath: path.join(repoDir, "src/product.ts"),
			relativePath: "src/product.ts",
			originalContent: "const base = 1\n",
			newContent: "const base = 1\nconst product = true\n",
		})

		const pendingLines = await (service as any).store.getPendingLineAttributions(repoDir)
		expect(pendingLines).toHaveLength(1)
		expect(pendingLines[0].ide).toBe(expectedIde)
	})

	it("does not auto upload when only generated events are recorded", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-code-stats-service-"))
		const repoDir = await createGitRepo()
		mockIsGitRepository.mockResolvedValue(true)
		const service = AiCodeStatsService.initialize(tmpDir, async () => ({
			webhookUrl: "https://example.com/webhook",
		}))

		const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(acceptedIngestResponse()))
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
		const repoDir = await createGitRepo()
		mockIsGitRepository.mockResolvedValue(true)
		const service = AiCodeStatsService.initialize(tmpDir, async () => ({ enabled: false, userName: "tester" }))

		await service.recordRejectedAgentSuggestion({
			cwd: repoDir,
			filePath: path.join(repoDir, "src/rejected.ts"),
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
			repoRoot: repoDir,
			repoRelativePath: "src/rejected.ts",
			relativePath: "src/rejected.ts",
			lineStart: 2,
			lineEnd: 2,
			lineCount: 1,
			codeSnippet: "const rejected = true",
			taskId: "task-rejected",
		})
	})

	// kilocode_change start
	it("keeps commit reports separated for two git repos under one parent workspace", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-code-stats-service-"))
		const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-code-stats-workspace-"))
		const repoA = await createGitRepo(workspaceDir, "repo-a")
		const repoB = await createGitRepo(workspaceDir, "repo-b")
		const remotes = new Map([
			[repoA, "git@example.com:acme/repo-a.git"],
			[repoB, "git@example.com:acme/repo-b.git"],
		])
		mockIsGitRepository.mockResolvedValue(true)
		mockGetRemoteUrl.mockImplementation(async (repoRoot: string) => remotes.get(await fs.realpath(repoRoot)))
		mockGetCurrentBranch.mockResolvedValue("main")
		const service = AiCodeStatsService.initialize(tmpDir, async () => ({ enabled: false }))

		await service.recordAgentFileWrite({
			cwd: workspaceDir,
			filePath: path.join(repoA, "src/a.ts"),
			originalContent: "const a = 1\n",
			newContent: "const a = 1\nconst aiA = 2\n",
		})
		await (service as any).handleCommitCollected({
			repoRoot: repoA,
			branch: "main",
			commitHash: "commit-a",
			previousCommit: "prev-a",
			commitOccurredAt: Date.now(),
			changedFiles: [{ relativePath: "src/a.ts", filePath: path.join(repoA, "src/a.ts"), changedBlocks: [] }],
		})

		await service.recordAgentFileWrite({
			cwd: workspaceDir,
			filePath: path.join(repoB, "src/b.ts"),
			originalContent: "const b = 1\n",
			newContent: "const b = 1\nconst aiB = 2\n",
		})
		await (service as any).handleCommitCollected({
			repoRoot: repoB,
			branch: "main",
			commitHash: "commit-b",
			previousCommit: "prev-b",
			commitOccurredAt: Date.now(),
			changedFiles: [{ relativePath: "src/b.ts", filePath: path.join(repoB, "src/b.ts"), changedBlocks: [] }],
		})

		const queuedReports = await (service as any).store.getQueuedReportsForTests()
		expect(queuedReports).toHaveLength(2)
		const reportsByCommit = new Map<string, any>(
			queuedReports.map((queued: any) => [queued.report.commitHash, queued.report]),
		)
		const reportA = reportsByCommit.get("commit-a")!
		const reportB = reportsByCommit.get("commit-b")!
		expect(reportA).toMatchObject({ repoRoot: repoA, projectName: "repo-a", gitRemoteUrl: remotes.get(repoA) })
		expect(reportB).toMatchObject({ repoRoot: repoB, projectName: "repo-b", gitRemoteUrl: remotes.get(repoB) })
		expect(reportA.projectKey).not.toBe(reportB.projectKey)
		expect(reportA.generatedBlocks[0]).toMatchObject({
			repoRoot: repoA,
			repoRelativePath: "src/a.ts",
			relativePath: "src/a.ts",
			projectName: "repo-a",
		})
		expect(reportB.generatedBlocks[0]).toMatchObject({
			repoRoot: repoB,
			repoRelativePath: "src/b.ts",
			relativePath: "src/b.ts",
			projectName: "repo-b",
		})
		expect(reportA).not.toHaveProperty("workspaceName")
		expect(reportA).not.toHaveProperty("workspacePath")
		expect(reportB).not.toHaveProperty("workspaceName")
		expect(reportB).not.toHaveProperty("workspacePath")
	})

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
			userEmail: "tester@example.com",
		}))
		const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(acceptedIngestResponse()))
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
		const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(acceptedIngestResponse()))
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
		;(vscode.env as any).appName = "wrapper|jetbrains|GO|2025.3"
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
		expect(queuedReports[0].report.client.ide).toBe("goland")
		expect(queuedReports[0].report.generatedBlocks).toHaveLength(1)
		expect(queuedReports[0].report.acceptedBlocks).toHaveLength(1)
		expect(queuedReports[0].report.generatedBlocks?.[0]).toMatchObject({
			ide: "goland",
			relativePath: "src/b.ts",
			fileSnapshotContent: "const b = 1\nconst aiB = 2\n",
		})
		expect(queuedReports[0].report.acceptedBlocks?.[0]).toMatchObject({
			ide: "goland",
			relativePath: "src/b.ts",
			fileSnapshotContent: "const b = 1\nconst aiB = 2\n",
		})
		expect(queuedReports[0].report.candidateLines?.length).toBeGreaterThan(0)
		expect(
			queuedReports[0].report.candidateLines?.every((line: AiCodeCommitCandidateLine) => line.ide === "goland"),
		).toBe(true)
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
			departmentName: "云存储研发部",
			officeName: "架设处",
			teamName: "研发一组",
			userEmail: " Configured.User@Example.COM ",
		}))

		await service.recordAgentFileWrite({
			cwd: repoDir,
			filePath: path.join(repoDir, "src/c.ts"),
			relativePath: "src/c.ts",
			originalContent: "const a = 1\n",
			newContent: "const a = 1\nconst d = 4\n",
		})

		const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(acceptedIngestResponse()))
		vi.stubGlobal("fetch", fetchMock)

		await (service as any).handleCommitCollected({
			repoRoot: repoDir,
			branch: "feature/stats",
			commitHash: "commit-1",
			previousCommit: "commit-0",
			commitOccurredAt: Date.now(),
			changedFiles: [],
		})

		const firstBody = await parseJsonBody(
			fetchMock.mock.calls[0][1].body as BodyInit,
			fetchMock.mock.calls[0][1].headers as Record<string, string>,
		)
		expect(firstBody.version).toBe("v3")
		expect(firstBody.defaults).toMatchObject({
			userName: "Configured User",
			departmentName: "云存储研发部",
			officeName: "架设处",
			teamName: "研发一组",
			userEmail: "configured.user@example.com",
			organizationId: "org-1",
			organizationName: "Org 1",
			sourceIp: expect.any(String),
			gitRemoteUrl: "https://github.com/example/repo.git",
			gitBranch: "feature/stats",
		})
		expect(firstBody.generatedBlocks[0]).toMatchObject({
			language: "typescript",
			fileSnapshotHash: firstBody.snapshots[0].contentHash,
		})
		expect(firstBody.acceptedBlocks[0]).toMatchObject({
			language: "typescript",
			fileSnapshotHash: firstBody.snapshots[0].contentHash,
		})
		expect(firstBody.generatedBlocks[0].fileSnapshotContent).toBeUndefined()
		expect(firstBody.acceptedBlocks[0].fileSnapshotContent).toBeUndefined()
		expect(firstBody.snapshots[0].content).toBe("const a = 1\nconst d = 4\n")
		expect(firstBody.defaults.projectKey).toHaveLength(16)
	})

	it("uses the commit callback branch for commit reports when pending blocks have a stale branch", async () => {
		mockIsGitRepository.mockResolvedValue(true)
		mockGetRemoteUrl.mockResolvedValue("https://github.com/example/repo.git")
		mockGetCurrentBranch.mockResolvedValue("main")

		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-code-stats-service-"))
		const repoDir = await createGitRepo()
		const service = AiCodeStatsService.initialize(tmpDir, async () => ({
			webhookUrl: "https://example.com/webhook",
			userEmail: "tester@example.com",
		}))

		await service.recordAgentFileWrite({
			cwd: repoDir,
			filePath: path.join(repoDir, "src/branch.ts"),
			relativePath: "src/branch.ts",
			originalContent: "const a = 1\n",
			newContent: "const a = 1\nconst branch = true\n",
		})

		const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(acceptedIngestResponse()))
		vi.stubGlobal("fetch", fetchMock)

		await (service as any).handleCommitCollected({
			repoRoot: repoDir,
			branch: "codex/add-sql-and-agent",
			commitHash: "commit-branch",
			previousCommit: "commit-prev",
			commitOccurredAt: Date.now(),
			changedFiles: [],
		})

		const firstBody = await parseJsonBody(
			fetchMock.mock.calls[0][1].body as BodyInit,
			fetchMock.mock.calls[0][1].headers as Record<string, string>,
		)
		expect(firstBody.gitBranch).toBe("codex/add-sql-and-agent")
		expect(firstBody.defaults.gitBranch).toBe("codex/add-sql-and-agent")
		expect(firstBody.generatedBlocks[0].gitBranch).toBeUndefined()
		expect(firstBody.acceptedBlocks[0].gitBranch).toBeUndefined()
		expect(firstBody.candidateLines[0].gitBranch).toBeUndefined()
	})

	it("continues uploading standalone events when a queued commit report fails", async () => {
		mockIsGitRepository.mockResolvedValue(true)
		mockGetRemoteUrl.mockResolvedValue("https://github.com/example/repo.git")
		mockGetCurrentBranch.mockResolvedValue("feature/stats")

		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-code-stats-service-"))
		const repoDir = await createGitRepo()
		const service = AiCodeStatsService.initialize(tmpDir, async () => ({
			webhookUrl: "https://example.com/webhook",
			userEmail: "tester@example.com",
		}))

		await service.recordAgentFileWrite({
			cwd: repoDir,
			filePath: path.join(repoDir, "src/partial.ts"),
			relativePath: "src/partial.ts",
			originalContent: "const a = 1\n",
			newContent: "const a = 1\nconst partial = true\n",
		})
		await service.recordRejectedAgentSuggestion({
			cwd: repoDir,
			filePath: path.join(repoDir, "src/rejected-partial.ts"),
			relativePath: "src/rejected-partial.ts",
			originalContent: "const rejected = false\n",
			newContent: "const rejected = false\nconst rejectedPartial = true\n",
		})

		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response("bad", { status: 400, statusText: "bad request" }))
			.mockResolvedValueOnce(acceptedIngestResponse())
		vi.stubGlobal("fetch", fetchMock)

		await (service as any).handleCommitCollected({
			repoRoot: repoDir,
			branch: "feature/stats",
			commitHash: "commit-partial-fail",
			previousCommit: "commit-prev",
			commitOccurredAt: Date.now(),
			changedFiles: [],
		})

		const store = (service as any).store
		expect(fetchMock.mock.calls).toHaveLength(2)
		const incrementalBody = JSON.parse(fetchMock.mock.calls[1][1].body as string)
		expect(incrementalBody.mode).toBe("incremental")
		expect(incrementalBody.events).toHaveLength(1)
		expect(await store.getPendingEvents()).toHaveLength(0)
		expect(await store.getQueuedReportsForTests()).toHaveLength(1)
		const state = await store.getRawStateForTests()
		expect(state.lastUpload).toMatchObject({
			status: "failed",
			uploadedEvents: 1,
			uploadedReports: 0,
			failedReports: 1,
			eventUploadFailed: false,
		})
		expect(state.lastUpload.failedReportErrors?.[0]).toMatchObject({
			commitHash: "commit-partial-fail",
			encoding: "identity",
		})
	})

	it("detects an observed uploaded commit missing on the server and replays retained candidates", async () => {
		mockIsGitRepository.mockResolvedValue(true)
		mockGetRemoteUrl.mockResolvedValue("https://github.com/example/replay.git")
		mockGetCurrentBranch.mockResolvedValue("main")

		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-code-stats-service-"))
		const repoDir = await createGitRepo()
		const service = AiCodeStatsService.initialize(tmpDir, async () => ({
			webhookUrl: "https://example.com/prod-api",
			userEmail: "tester@example.com",
		}))

		const relativePath = "src/replay.ts"
		const filePath = path.join(repoDir, relativePath)
		const originalContent = "const base = 1\n"
		const aiContent = "const base = 1\nconst aiReplay = 2\n"
		await commitFile(repoDir, relativePath, originalContent, "base")
		await service.recordAgentFileWrite({
			cwd: repoDir,
			filePath,
			relativePath,
			originalContent,
			newContent: aiContent,
			taskId: "task-replay",
		})
		const commitHash = await commitFile(repoDir, relativePath, aiContent, "ai replay")

		let serverStatus: "NOT_RECEIVED" | "RECEIVED" = "NOT_RECEIVED"
		const uploadedReports: any[] = []
		const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
			const pathname = new URL(url).pathname
			if (pathname.endsWith("/commit-status")) {
				const query = JSON.parse(String(init?.body ?? "{}"))
				return new Response(
					JSON.stringify({
						statuses: query.commits.map((commit: any) => ({
							commitHash: commit.commitHash,
							status: serverStatus,
							receivedAt: serverStatus === "NOT_RECEIVED" ? null : new Date().toISOString(),
							reportId:
								serverStatus === "NOT_RECEIVED"
									? null
									: (commit.reportId ??
										uploadedReports.find((report) => report.commitHash === commit.commitHash)
											?.reportId ??
										null),
							message: null,
						})),
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				)
			}

			const payload = await parseJsonBody(
				init?.body as BodyInit,
				init?.headers as Record<string, string> | undefined,
			)
			if (payload.mode === "commit_report") {
				uploadedReports.push(payload)
			}
			return acceptedIngestResponse()
		})
		vi.stubGlobal("fetch", fetchMock)

		const facts = await (service as any).commitAttributionService.collectCommitFactsForReplay(
			repoDir,
			commitHash,
			"main",
		)
		await (service as any).handleCommitCollected(facts)
		const store = (service as any).store
		await store.setRepoObservedCommit(repoDir, commitHash)
		expect(await store.getQueuedReportsForTests()).toHaveLength(0)
		expect(uploadedReports).toHaveLength(1)

		const missingRecords = await service.refreshCommitUploadStatus()
		expect(missingRecords).toHaveLength(1)
		expect(missingRecords[0]).toMatchObject({
			commitHash,
			status: "needs_reanalysis",
			addedLineCount: 1,
			changedFileCount: 1,
		})

		serverStatus = "RECEIVED"
		const afterReplay = await service.reanalyzeCommitUpload(missingRecords[0].id)
		expect(afterReplay).toHaveLength(0)
		const replayReport = uploadedReports.find((report) => String(report.reportId).startsWith("replay-"))
		expect(replayReport).toBeTruthy()
		expect(replayReport.commitHash).toBe(commitHash)
		expect(replayReport.candidateLines?.length).toBeGreaterThan(0)
		expect(replayReport.generatedBlocks?.length).toBeGreaterThan(0)

		const diagnosticsPath = await service.exportCommitUploadDiagnostics()
		const diagnostics = await fs.readFile(diagnosticsPath, "utf8")
		expect(diagnostics).toContain("reanalysis_uploaded")
		expect(diagnostics).not.toContain("const aiReplay = 2")
		expect(diagnostics).not.toContain("fileSnapshotContent")
	})

	it("keeps a replayed commit report retryable when reanalysis upload fails", async () => {
		mockIsGitRepository.mockResolvedValue(true)
		mockGetRemoteUrl.mockResolvedValue("https://github.com/example/replay-fail.git")
		mockGetCurrentBranch.mockResolvedValue("main")

		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-code-stats-service-"))
		const repoDir = await createGitRepo()
		const service = AiCodeStatsService.initialize(tmpDir, async () => ({
			webhookUrl: "https://example.com/prod-api",
			userEmail: "tester@example.com",
		}))

		const relativePath = "src/replay-fail.ts"
		const filePath = path.join(repoDir, relativePath)
		const originalContent = "const base = 1\n"
		const aiContent = "const base = 1\nconst replayFailAi = true\n"
		await commitFile(repoDir, relativePath, originalContent, "base")
		await service.recordAgentFileWrite({
			cwd: repoDir,
			filePath,
			relativePath,
			originalContent,
			newContent: aiContent,
			taskId: "task-replay-fail",
		})
		const commitHash = await commitFile(repoDir, relativePath, aiContent, "ai replay fail")

		const uploadedReports: any[] = []
		let failReplayReports = false
		const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
			const pathname = new URL(url).pathname
			if (pathname.endsWith("/commit-status")) {
				const query = JSON.parse(String(init?.body ?? "{}"))
				return new Response(
					JSON.stringify({
						statuses: query.commits.map((commit: any) => ({
							commitHash: commit.commitHash,
							status: "NOT_RECEIVED",
							receivedAt: null,
							reportId: null,
							message: null,
						})),
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				)
			}

			const payload = await parseJsonBody(
				init?.body as BodyInit,
				init?.headers as Record<string, string> | undefined,
			)
			if (payload.mode === "commit_report") {
				if (failReplayReports && String(payload.reportId).startsWith("replay-")) {
					return new Response("temporary upload failure", { status: 503, statusText: "Service Unavailable" })
				}
				uploadedReports.push(payload)
			}
			return acceptedIngestResponse()
		})
		vi.stubGlobal("fetch", fetchMock)

		const facts = await (service as any).commitAttributionService.collectCommitFactsForReplay(
			repoDir,
			commitHash,
			"main",
		)
		await (service as any).handleCommitCollected(facts)
		const missingRecords = await service.refreshCommitUploadStatus()
		expect(missingRecords).toHaveLength(1)
		expect(missingRecords[0].status).toBe("needs_reanalysis")

		failReplayReports = true
		const afterReplayFailure = await service.reanalyzeCommitUpload(missingRecords[0].id)
		expect(afterReplayFailure).toHaveLength(1)
		expect(afterReplayFailure[0]).toMatchObject({
			commitHash,
			status: "upload_failed",
		})
		expect(afterReplayFailure[0].reportId).toMatch(/^replay-/)
		expect(afterReplayFailure[0].lastError).toContain("503")
		expect(await (service as any).store.getQueuedReportsForTests()).toHaveLength(1)

		const diagnosticsPath = await service.exportCommitUploadDiagnostics(afterReplayFailure[0].id)
		const diagnostics = await fs.readFile(diagnosticsPath, "utf8")
		expect(diagnostics).toContain("upload_failed")
		expect(diagnostics).not.toContain("reanalysis_uploaded")
	})

	it("keeps failed commit reports retryable and hides them after retry succeeds", async () => {
		mockIsGitRepository.mockResolvedValue(true)
		mockGetRemoteUrl.mockResolvedValue("https://github.com/example/retry.git")
		mockGetCurrentBranch.mockResolvedValue("main")

		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-code-stats-service-"))
		const repoDir = await createGitRepo()
		const service = AiCodeStatsService.initialize(tmpDir, async () => ({
			webhookUrl: "https://example.com/prod-api",
			userEmail: "tester@example.com",
		}))

		const relativePath = "src/retry.ts"
		const filePath = path.join(repoDir, relativePath)
		const originalContent = "const base = 1\n"
		const aiContent = "const base = 1\nconst retryAi = true\n"
		await commitFile(repoDir, relativePath, originalContent, "base")
		await service.recordAgentFileWrite({
			cwd: repoDir,
			filePath,
			relativePath,
			originalContent,
			newContent: aiContent,
			taskId: "task-retry",
		})
		const commitHash = await commitFile(repoDir, relativePath, aiContent, "ai retry")

		let failCommitReports = true
		const uploadedReports: any[] = []
		const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
			const pathname = new URL(url).pathname
			if (pathname.endsWith("/commit-status")) {
				const query = JSON.parse(String(init?.body ?? "{}"))
				return new Response(
					JSON.stringify({
						statuses: query.commits.map((commit: any) => ({
							commitHash: commit.commitHash,
							status: "RECEIVED",
							receivedAt: new Date().toISOString(),
							reportId:
								commit.reportId ??
								uploadedReports.find((report) => report.commitHash === commit.commitHash)?.reportId ??
								null,
							message: null,
						})),
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				)
			}

			const payload = await parseJsonBody(
				init?.body as BodyInit,
				init?.headers as Record<string, string> | undefined,
			)
			if (payload.mode === "commit_report") {
				if (failCommitReports) {
					return new Response("upload timeout", { status: 504, statusText: "Gateway Timeout" })
				}
				uploadedReports.push(payload)
			}
			return acceptedIngestResponse()
		})
		vi.stubGlobal("fetch", fetchMock)

		const facts = await (service as any).commitAttributionService.collectCommitFactsForReplay(
			repoDir,
			commitHash,
			"main",
		)
		await (service as any).handleCommitCollected(facts)

		const store = (service as any).store
		let visibleRecords = await store.getVisibleCommitUploadRecords()
		expect(visibleRecords).toHaveLength(1)
		expect(visibleRecords[0]).toMatchObject({
			commitHash,
			status: "upload_failed",
		})
		expect(visibleRecords[0].lastError).toContain("504")
		expect(visibleRecords[0].lastErrorCategory).toBe("timeout")
		expect(visibleRecords[0].lastUserMessage).toBe("连接上报服务器超时，请检查网络或后台服务状态。")
		expect(await store.getQueuedReportsForTests()).toHaveLength(1)

		const failedDiagnosticsPath = await service.exportCommitUploadDiagnostics(visibleRecords[0].id)
		const failedDiagnostics = JSON.parse(await fs.readFile(failedDiagnosticsPath, "utf8"))
		const uploadFailedEvent = failedDiagnostics.events.find((event: any) => event.type === "upload_failed")
		expect(uploadFailedEvent?.details).toMatchObject({
			action: "commit",
			errorCategory: "timeout",
			userMessage: "连接上报服务器超时，请检查网络或后台服务状态。",
			targetProtocol: "https",
			targetHost: "example.com",
			targetPath: "/prod-api/api/v1/ingest/ai-code-stats",
		})
		expect(uploadFailedEvent?.details.selectedReportId).toBeUndefined()

		failCommitReports = false
		visibleRecords = await service.retryCommitUpload(visibleRecords[0].id)
		expect(visibleRecords).toHaveLength(0)
		expect(await store.getQueuedReportsForTests()).toHaveLength(0)
		expect(uploadedReports).toHaveLength(1)
		expect(uploadedReports[0].commitHash).toBe(commitHash)
	})

	it("retries only the selected failed commit report", async () => {
		mockIsGitRepository.mockResolvedValue(true)
		mockGetRemoteUrl.mockResolvedValue("https://github.com/example/retry-selected.git")
		mockGetCurrentBranch.mockResolvedValue("main")

		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-code-stats-service-"))
		const repoDir = await createGitRepo()
		const service = AiCodeStatsService.initialize(tmpDir, async () => ({
			webhookUrl: "https://example.com/prod-api",
			userEmail: "tester@example.com",
		}))

		const uploadedReports: any[] = []
		let failCommitReports = true
		const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
			const pathname = new URL(url).pathname
			if (pathname.endsWith("/commit-status")) {
				const query = JSON.parse(String(init?.body ?? "{}"))
				return new Response(
					JSON.stringify({
						statuses: query.commits.map((commit: any) => {
							const uploaded = uploadedReports.find((report) => report.commitHash === commit.commitHash)
							return {
								commitHash: commit.commitHash,
								status: uploaded ? "RECEIVED" : "NOT_RECEIVED",
								receivedAt: uploaded ? new Date().toISOString() : null,
								reportId: uploaded?.reportId ?? null,
								message: null,
							}
						}),
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				)
			}

			const payload = await parseJsonBody(
				init?.body as BodyInit,
				init?.headers as Record<string, string> | undefined,
			)
			if (payload.mode === "commit_report") {
				if (failCommitReports) {
					return new Response("backend stopped", { status: 503, statusText: "Service Unavailable" })
				}
				uploadedReports.push(payload)
			}
			return acceptedIngestResponse()
		})
		vi.stubGlobal("fetch", fetchMock)

		const firstPath = "src/retry-selected-one.ts"
		const firstOriginal = "const base = 1\n"
		const firstAiContent = "const base = 1\nconst retrySelectedOne = true\n"
		await commitFile(repoDir, firstPath, firstOriginal, "base one")
		await service.recordAgentFileWrite({
			cwd: repoDir,
			filePath: path.join(repoDir, firstPath),
			relativePath: firstPath,
			originalContent: firstOriginal,
			newContent: firstAiContent,
			taskId: "task-retry-selected-one",
		})
		const firstCommitHash = await commitFile(repoDir, firstPath, firstAiContent, "ai retry selected one")
		await (service as any).handleCommitCollected(
			await (service as any).commitAttributionService.collectCommitFactsForReplay(
				repoDir,
				firstCommitHash,
				"main",
			),
		)

		const secondPath = "src/retry-selected-two.ts"
		const secondOriginal = "const base = 2\n"
		const secondAiContent = "const base = 2\nconst retrySelectedTwo = true\n"
		await service.recordAgentFileWrite({
			cwd: repoDir,
			filePath: path.join(repoDir, secondPath),
			relativePath: secondPath,
			originalContent: secondOriginal,
			newContent: secondAiContent,
			taskId: "task-retry-selected-two",
		})
		const secondCommitHash = await commitFile(repoDir, secondPath, secondAiContent, "ai retry selected two")
		await (service as any).handleCommitCollected(
			await (service as any).commitAttributionService.collectCommitFactsForReplay(
				repoDir,
				secondCommitHash,
				"main",
			),
		)

		const store = (service as any).store
		let visibleRecords = await store.getVisibleCommitUploadRecords()
		expect(visibleRecords).toHaveLength(2)
		expect(await store.getQueuedReportsForTests()).toHaveLength(2)

		const selectedRecord = visibleRecords.find((record: any) => record.commitHash === secondCommitHash)!
		failCommitReports = false
		visibleRecords = await service.retryCommitUpload(selectedRecord.id)

		expect(uploadedReports).toHaveLength(1)
		expect(uploadedReports[0].commitHash).toBe(secondCommitHash)
		expect(await store.getQueuedReportsForTests()).toHaveLength(1)
		expect(visibleRecords).toHaveLength(1)
		expect(visibleRecords[0].commitHash).toBe(firstCommitHash)
		expect(visibleRecords[0].status).toBe("upload_failed")

		const diagnosticsPath = await service.exportCommitUploadDiagnostics(selectedRecord.id)
		const diagnostics = JSON.parse(await fs.readFile(diagnosticsPath, "utf8"))
		expect(
			diagnostics.events.some(
				(event: any) =>
					event.type === "upload_retry_requested" &&
					event.reportId === selectedRecord.reportId &&
					event.details?.action === "retry" &&
					event.details?.selectedReportId === selectedRecord.reportId,
			),
		).toBe(true)
		expect(
			diagnostics.events.some(
				(event: any) =>
					event.type === "upload_started" &&
					event.reportId === selectedRecord.reportId &&
					event.details?.action === "retry" &&
					event.details?.selectedReportId === selectedRecord.reportId &&
					event.details?.targetPath === "/prod-api/api/v1/ingest/ai-code-stats",
			),
		).toBe(true)
	})
	// kilocode_change end
})
