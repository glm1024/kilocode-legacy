import crypto from "crypto"
import * as path from "path"
import { CloudService } from "@roo-code/cloud"

import { getCurrentBranch, getRemoteUrl, isGitRepository } from "../code-index/managed/git-utils"
import { AiCodeStatsLocalIdentityResolver } from "../ai-code-stats/AiCodeStatsLocalIdentityResolver"
import { normalizePath, type AiTokenUsageUploadSettings } from "./types"

interface AiTokenUsageGitMetadata {
	gitRemoteUrl?: string
	gitBranch?: string
	projectKey: string
}

export interface AiTokenUsageResolvedMetadata extends AiTokenUsageGitMetadata {
	userName?: string
	organizationId?: string
	organizationName?: string
	sourceIp?: string
}

export class AiTokenUsageMetadataResolver {
	private readonly gitMetadataCache = new Map<string, Promise<AiTokenUsageGitMetadata>>()

	constructor(private readonly localIdentityResolver = new AiCodeStatsLocalIdentityResolver()) {}

	async resolve(workspacePath: string, settings: AiTokenUsageUploadSettings): Promise<AiTokenUsageResolvedMetadata> {
		const normalizedWorkspacePath = normalizePath(path.resolve(workspacePath))
		const identity = this.resolveIdentity(settings)
		const gitMetadata = await this.resolveGitMetadata(normalizedWorkspacePath)
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
			organizationId: cloudUserInfo?.organizationId,
			organizationName: cloudUserInfo?.organizationName,
			sourceIp,
		}
	}

	private async resolveGitMetadata(workspacePath: string): Promise<AiTokenUsageGitMetadata> {
		const cached = this.gitMetadataCache.get(workspacePath)
		if (cached) {
			return cached
		}

		const pending = this.loadGitMetadata(workspacePath)
		this.gitMetadataCache.set(workspacePath, pending)
		return pending
	}

	private async loadGitMetadata(workspacePath: string): Promise<AiTokenUsageGitMetadata> {
		const fallbackProjectKey = this.buildProjectKey(workspacePath)
		try {
			const inGitRepository = await isGitRepository(workspacePath)
			if (!inGitRepository) {
				return { projectKey: fallbackProjectKey }
			}

			const [gitRemoteUrl, gitBranch] = await Promise.all([
				getRemoteUrl(workspacePath).catch(() => undefined),
				getCurrentBranch(workspacePath).catch(() => undefined),
			])

			return {
				gitRemoteUrl,
				gitBranch,
				projectKey: this.buildProjectKey(gitRemoteUrl || workspacePath),
			}
		} catch {
			return { projectKey: fallbackProjectKey }
		}
	}

	private buildProjectKey(seed: string): string {
		return crypto.createHash("sha256").update(normalizePath(seed)).digest("hex").slice(0, 16)
	}
}
