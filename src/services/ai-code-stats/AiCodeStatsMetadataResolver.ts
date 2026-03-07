// kilocode_change - new file

import crypto from "crypto"
import * as path from "path"
import * as vscode from "vscode"
import { CloudService } from "@roo-code/cloud"

import { languageForFilepath } from "../autocomplete/continuedev/core/autocomplete/constants/AutocompleteLanguageInfo"
import { getCurrentBranch, getRemoteUrl, isGitRepository } from "../code-index/managed/git-utils"
import { AiCodeStatsLocalIdentityResolver } from "./AiCodeStatsLocalIdentityResolver"
import { normalizePath, type AiCodeStatsUploadSettings } from "./types"

interface AiCodeStatsGitMetadata {
	gitRemoteUrl?: string
	gitBranch?: string
	projectKey: string
}

export interface AiCodeStatsResolvedMetadata extends AiCodeStatsGitMetadata {
	userName?: string
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
	private readonly gitMetadataCache = new Map<string, Promise<AiCodeStatsGitMetadata>>()
	constructor(private readonly localIdentityResolver = new AiCodeStatsLocalIdentityResolver()) {}

	async resolve(
		workspacePath: string,
		filePath: string,
		settings: AiCodeStatsUploadSettings,
	): Promise<AiCodeStatsResolvedMetadata> {
		const identity = this.resolveIdentity(settings)
		const language = this.resolveLanguage(filePath)
		const gitMetadata = await this.resolveGitMetadata(workspacePath)

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
			userEmail: cloudUserInfo?.email,
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

	private async resolveGitMetadata(workspacePath: string): Promise<AiCodeStatsGitMetadata> {
		const normalizedWorkspacePath = normalizePath(path.resolve(workspacePath))
		const cached = this.gitMetadataCache.get(normalizedWorkspacePath)
		if (cached) {
			return cached
		}

		const pending = this.loadGitMetadata(normalizedWorkspacePath)
		this.gitMetadataCache.set(normalizedWorkspacePath, pending)

		return pending
	}

	private async loadGitMetadata(workspacePath: string): Promise<AiCodeStatsGitMetadata> {
		const fallbackProjectKey = this.buildProjectKey(workspacePath)

		try {
			const inGitRepository = await isGitRepository(workspacePath)
			if (!inGitRepository) {
				return {
					projectKey: fallbackProjectKey,
				}
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
			return {
				projectKey: fallbackProjectKey,
			}
		}
	}

	private buildProjectKey(seed: string): string {
		return crypto.createHash("sha256").update(normalizePath(seed)).digest("hex").slice(0, 16)
	}
}
