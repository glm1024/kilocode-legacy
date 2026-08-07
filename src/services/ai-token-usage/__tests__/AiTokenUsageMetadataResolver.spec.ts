import { beforeEach, describe, expect, it, vi } from "vitest"

const { getCurrentBranch, getRemoteUrl, isGitRepository } = vi.hoisted(() => ({
	getCurrentBranch: vi.fn(),
	getRemoteUrl: vi.fn(),
	isGitRepository: vi.fn(),
}))

vi.mock("@roo-code/cloud", () => ({
	CloudService: {
		hasInstance: () => false,
	},
}))

vi.mock("../../code-index/managed/git-utils", () => ({
	getCurrentBranch,
	getRemoteUrl,
	isGitRepository,
}))

vi.mock("../../ai-code-stats/AiCodeStatsLocalIdentityResolver", () => ({
	AiCodeStatsLocalIdentityResolver: class {
		resolveUserName(value?: string) {
			return value ?? "Alice"
		}

		resolveSourceIp() {
			return "127.0.0.1"
		}
	},
}))

import { AiTokenUsageMetadataResolver } from "../AiTokenUsageMetadataResolver"

describe("AiTokenUsageMetadataResolver", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		isGitRepository.mockResolvedValue(true)
		getRemoteUrl.mockResolvedValue("https://example.com/team/project.git")
		getCurrentBranch.mockResolvedValueOnce("main").mockResolvedValueOnce("feature/token-fix")
	})

	it("resolves the current branch for every request instead of caching the first branch", async () => {
		const resolver = new AiTokenUsageMetadataResolver()

		await expect(
			resolver.resolve("/workspace/project", {
				userName: "Alice",
				userEmail: "alice@example.com",
			}),
		).resolves.toMatchObject({ gitBranch: "main" })
		await expect(
			resolver.resolve("/workspace/project", {
				userName: "Alice",
				userEmail: "alice@example.com",
			}),
		).resolves.toMatchObject({ gitBranch: "feature/token-fix" })

		expect(getCurrentBranch).toHaveBeenCalledTimes(2)
	})
})
