// kilocode_change - new file

import { beforeEach, describe, expect, it, vi } from "vitest"

const { mockGetUserInfo, mockHasInstance, mockGetCurrentBranch, mockGetRemoteUrl, mockIsGitRepository } = vi.hoisted(
	() => ({
		mockGetUserInfo: vi.fn(),
		mockHasInstance: vi.fn(),
		mockGetCurrentBranch: vi.fn(),
		mockGetRemoteUrl: vi.fn(),
		mockIsGitRepository: vi.fn(),
	}),
)

vi.mock("@roo-code/cloud", () => ({
	CloudService: {
		hasInstance: mockHasInstance,
		instance: {
			getUserInfo: mockGetUserInfo,
		},
	},
}))

vi.mock("../../code-index/managed/git-utils", () => ({
	getCurrentBranch: mockGetCurrentBranch,
	getRemoteUrl: mockGetRemoteUrl,
	isGitRepository: mockIsGitRepository,
}))

vi.mock("vscode", () => ({
	workspace: {
		textDocuments: [],
	},
}))

import { AiCodeStatsMetadataResolver } from "../AiCodeStatsMetadataResolver"
import { AiCodeStatsLocalIdentityResolver } from "../AiCodeStatsLocalIdentityResolver"

describe("AiCodeStatsMetadataResolver", () => {
	beforeEach(() => {
		mockHasInstance.mockReturnValue(false)
		mockGetUserInfo.mockReturnValue(undefined)
		mockIsGitRepository.mockResolvedValue(false)
		mockGetRemoteUrl.mockResolvedValue(undefined)
		mockGetCurrentBranch.mockResolvedValue(undefined)
	})

	it("uses configured user name and local source ip metadata", async () => {
		const resolver = new AiCodeStatsMetadataResolver({
			resolveUserName: vi.fn(() => "Configured User"),
			resolveSourceIp: vi.fn(() => "192.168.0.24"),
		} as unknown as AiCodeStatsLocalIdentityResolver)

		const metadata = await resolver.resolve("/workspace/project", "/workspace/project/src/index.ts", {
			userName: "Configured User",
		})

		expect(metadata.userName).toBe("Configured User")
		expect(metadata.sourceIp).toBe("192.168.0.24")
		expect(metadata.language).toBe("typescript")
		expect(metadata.projectKey).toHaveLength(16)
	})

	it("keeps local identity while attaching cloud org metadata and git metadata", async () => {
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

		const resolver = new AiCodeStatsMetadataResolver({
			resolveUserName: vi.fn(() => "Local Operator"),
			resolveSourceIp: vi.fn(() => "10.10.1.8"),
		} as unknown as AiCodeStatsLocalIdentityResolver)
		const metadata = await resolver.resolve("/workspace/project", "/workspace/project/src/index.ts", {
			userName: "",
		})

		expect(metadata.userName).toBe("Local Operator")
		expect(metadata.sourceIp).toBe("10.10.1.8")
		expect(metadata.userEmail).toBe("cloud@example.com")
		expect(metadata.organizationId).toBe("org-1")
		expect(metadata.organizationName).toBe("Org 1")
		expect(metadata.gitRemoteUrl).toBe("https://github.com/example/repo.git")
		expect(metadata.gitBranch).toBe("feature/stats")
		expect(metadata.projectKey).toHaveLength(16)
	})
})
