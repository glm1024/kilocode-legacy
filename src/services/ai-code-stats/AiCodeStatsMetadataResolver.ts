// kilocode_change - new file

import crypto from "crypto"
import * as path from "path"
import * as vscode from "vscode"
import { CloudService } from "@roo-code/cloud"

import { languageForFilepath } from "../autocomplete/continuedev/core/autocomplete/constants/AutocompleteLanguageInfo"
import { getCurrentBranch, getRemoteUrl, isGitRepository } from "../code-index/managed/git-utils"
import { AiCodeStatsLocalIdentityResolver } from "./AiCodeStatsLocalIdentityResolver"
import { normalizePath, normalizeUserEmail, type AiCodeStatsUploadSettings } from "./types"

interface AiCodeStatsGitMetadata {
	gitRemoteUrl?: string
	gitBranch?: string
	projectKey: string
	projectName: string
}

interface AiCodeStatsStableGitMetadata {
	gitRemoteUrl?: string
	projectKey: string
	projectName: string
	inGitRepository: boolean
}

export interface AiCodeStatsResolvedMetadata extends AiCodeStatsGitMetadata {
	userName?: string
	departmentName?: string
	officeName?: string
	teamName?: string
	userEmail?: string
	organizationId?: string
	organizationName?: string
	sourceIp?: string
	language?: string
}

const normalizeLanguage = (value?: string): string | undefined => {
	if (!value?.trim()) {
		return undefined
	}

	return value
		.trim()
		.toLowerCase()
		.replace(/\+/g, "plus")
		.replace(/#/g, "sharp")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
}

export class AiCodeStatsMetadataResolver {
	private readonly stableGitMetadataCache = new Map<string, Promise<AiCodeStatsStableGitMetadata>>()
	constructor(private readonly localIdentityResolver = new AiCodeStatsLocalIdentityResolver()) {}

	async resolve(
		repoRoot: string,
		filePath: string,
		settings: AiCodeStatsUploadSettings,
	): Promise<AiCodeStatsResolvedMetadata> {
		const identity = this.resolveIdentity(settings)
		const language = this.resolveLanguage(filePath)
		const gitMetadata = await this.resolveGitMetadata(repoRoot)

		return {
			...identity,
			...gitMetadata,
			language,
		}
	}

	private resolveIdentity(
		settings: AiCodeStatsUploadSettings,
	): Omit<AiCodeStatsResolvedMetadata, keyof AiCodeStatsGitMetadata | "language"> {
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

	private resolveLanguage(filePath: string): string | undefined {
		const normalizedFilePath = normalizePath(path.resolve(filePath))
		const openDocument = vscode.workspace.textDocuments.find((document) => {
			if (document.uri.scheme !== "file") {
				return false
			}

			return normalizePath(path.resolve(document.uri.fsPath)) === normalizedFilePath
		})

		if (openDocument?.languageId) {
			return normalizeLanguage(openDocument.languageId)
		}

		return normalizeLanguage(languageForFilepath(filePath).name)
	}

	private async resolveGitMetadata(repoRoot: string): Promise<AiCodeStatsGitMetadata> {
		const normalizedRepoRoot = normalizePath(path.resolve(repoRoot))
		const cached = this.stableGitMetadataCache.get(normalizedRepoRoot)
		if (cached) {
			return this.attachCurrentBranch(normalizedRepoRoot, await cached)
		}

		const pending = this.loadStableGitMetadata(normalizedRepoRoot)
		this.stableGitMetadataCache.set(normalizedRepoRoot, pending)

		return this.attachCurrentBranch(normalizedRepoRoot, await pending)
	}

	private async loadStableGitMetadata(repoRoot: string): Promise<AiCodeStatsStableGitMetadata> {
		const fallbackProjectKey = this.buildProjectKey(repoRoot)

		try {
			const inGitRepository = await isGitRepository(repoRoot)
			if (!inGitRepository) {
				return {
					projectKey: fallbackProjectKey,
					projectName: this.buildProjectName(undefined, repoRoot),
					inGitRepository: false,
				}
			}

			const gitRemoteUrl = await getRemoteUrl(repoRoot).catch(() => undefined)

			return {
				gitRemoteUrl,
				projectKey: this.buildProjectKey(gitRemoteUrl || repoRoot),
				projectName: this.buildProjectName(gitRemoteUrl, repoRoot),
				inGitRepository: true,
			}
		} catch {
			return {
				projectKey: fallbackProjectKey,
				projectName: this.buildProjectName(undefined, repoRoot),
				inGitRepository: false,
			}
		}
	}

	private async attachCurrentBranch(
		repoRoot: string,
		metadata: AiCodeStatsStableGitMetadata,
	): Promise<AiCodeStatsGitMetadata> {
		if (!metadata.inGitRepository) {
			return {
				gitRemoteUrl: metadata.gitRemoteUrl,
				projectKey: metadata.projectKey,
				projectName: metadata.projectName,
			}
		}

		const gitBranch = await getCurrentBranch(repoRoot).catch(() => undefined)
		return {
			gitRemoteUrl: metadata.gitRemoteUrl,
			gitBranch,
			projectKey: metadata.projectKey,
			projectName: metadata.projectName,
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
