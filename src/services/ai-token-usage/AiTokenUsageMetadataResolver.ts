import crypto from "crypto"
import * as path from "path"
import { CloudService } from "@roo-code/cloud"

import { getCurrentBranch, getRemoteUrl, isGitRepository } from "../code-index/managed/git-utils"
import { AiCodeStatsLocalIdentityResolver } from "../ai-code-stats/AiCodeStatsLocalIdentityResolver"
import { normalizePath, normalizeUserEmail, type AiTokenUsageUploadSettings } from "./types"

interface AiTokenUsageGitMetadata {
	gitRemoteUrl?: string
	gitBranch?: string
	projectKey: string
	projectName: string
	repoRoot?: string
}

export interface AiTokenUsageResolvedMetadata extends AiTokenUsageGitMetadata {
	userName?: string
	departmentName?: string
	officeName?: string
	teamName?: string
	userEmail?: string
	organizationId?: string
	organizationName?: string
	sourceIp?: string
}

export class AiTokenUsageMetadataResolver {
	constructor(private readonly localIdentityResolver = new AiCodeStatsLocalIdentityResolver()) {}

	async resolve(
		repoRoot: string | undefined,
		settings: AiTokenUsageUploadSettings,
	): Promise<AiTokenUsageResolvedMetadata> {
		const identity = this.resolveIdentity(settings)
		const gitMetadata = repoRoot
			? await this.resolveGitMetadata(normalizePath(path.resolve(repoRoot)))
			: this.unknownProjectMetadata()
		return {
			...identity,
			...gitMetadata,
		}
	}

	private resolveIdentity(
		settings: AiTokenUsageUploadSettings,
	): Omit<AiTokenUsageResolvedMetadata, keyof AiTokenUsageGitMetadata> {
		const userName = this.localIdentityResolver.resolveUserName(settings.userName)
		const sourceIp = this.localIdentityResolver.resolveSourceIp()
		const cloudUserInfo = CloudService.hasInstance() ? CloudService.instance.getUserInfo() : undefined
		return {
			userName,
			departmentName: settings.departmentName?.trim() || undefined,
			officeName: settings.officeName?.trim() || undefined,
			teamName: settings.teamName?.trim() || undefined,
			userEmail: normalizeUserEmail(settings.userEmail),
			organizationId: cloudUserInfo?.organizationId,
			organizationName: cloudUserInfo?.organizationName,
			sourceIp,
		}
	}

	private async resolveGitMetadata(repoRoot: string): Promise<AiTokenUsageGitMetadata> {
		// Branch is a per-request fact. Keeping a process-lifetime repository
		// cache here would attribute all later requests to the branch that was
		// active during the first request.
		return this.loadGitMetadata(repoRoot)
	}

	private async loadGitMetadata(repoRoot: string): Promise<AiTokenUsageGitMetadata> {
		const fallbackProjectKey = this.buildProjectKey(repoRoot)
		try {
			const inGitRepository = await isGitRepository(repoRoot)
			if (!inGitRepository) {
				return {
					projectKey: fallbackProjectKey,
					projectName: this.buildProjectName(undefined, repoRoot),
					repoRoot,
				}
			}

			const [gitRemoteUrl, gitBranch] = await Promise.all([
				getRemoteUrl(repoRoot).catch(() => undefined),
				getCurrentBranch(repoRoot).catch(() => undefined),
			])

			return {
				gitRemoteUrl,
				gitBranch,
				projectKey: this.buildProjectKey(gitRemoteUrl || repoRoot),
				projectName: this.buildProjectName(gitRemoteUrl, repoRoot),
				repoRoot,
			}
		} catch {
			return {
				projectKey: fallbackProjectKey,
				projectName: this.buildProjectName(undefined, repoRoot),
				repoRoot,
			}
		}
	}

	private unknownProjectMetadata(): AiTokenUsageGitMetadata {
		return {
			projectKey: "unknown-project",
			projectName: "unknown-project",
		}
	}

	private buildProjectKey(seed: string): string {
		return crypto.createHash("sha256").update(normalizePath(seed)).digest("hex").slice(0, 16)
	}

	private buildProjectName(gitRemoteUrl: string | undefined, repoRoot: string): string {
		const remoteName = gitRemoteUrl
			?.trim()
			.replace(/[\\/]+$/, "")
			.split(/[\\/:]/)
			.pop()
			?.replace(/\.git$/i, "")
			.trim()
		if (remoteName) {
			return remoteName
		}
		return path.basename(normalizePath(repoRoot)) || "unknown-project"
	}
}
