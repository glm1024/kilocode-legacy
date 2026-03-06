// kilocode_change - new file
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("vscode", () => ({
	workspace: {
		getWorkspaceFolder: vi.fn(() => ({
			name: "workspace",
			uri: { fsPath: "/workspace" },
		})),
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
})
