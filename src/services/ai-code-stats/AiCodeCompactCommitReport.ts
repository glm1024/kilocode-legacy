import { createHash } from "crypto"

import {
	CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
	normalizePath,
	normalizeUserEmail,
	type AiCodeCommitCandidateLine,
	type AiCodeCommitChangedFile,
	type AiCodeCommitReport,
	type AiCodeGeneratedBlock,
	type AiCodeSourceType,
	type AiCodeStatsUploadClient,
} from "./types"

export interface AiCodeSnapshotPayload {
	contentHash: string
	content: string
	length: number
	lineCount: number
}

interface AiCodeCompactDefaults {
	sourceType?: AiCodeSourceType
	ide?: string
	userName?: string
	departmentName?: string
	officeName?: string
	teamName?: string
	userEmail?: string
	organizationId?: string
	organizationName?: string
	sourceIp?: string
	projectKey?: string
	projectName?: string
	repoRoot?: string
	gitRemoteUrl?: string
	gitBranch?: string
}

export interface AiCodeCompactBlockPayload
	extends Omit<AiCodeGeneratedBlock, "fileSnapshotContent" | "fileSnapshotHash"> {
	fileSnapshotHash?: string
}

export interface AiCodeCompactChangedFilePayload
	extends Omit<AiCodeCommitChangedFile, "committedSnapshotContent" | "committedSnapshotHash"> {
	committedSnapshotHash?: string
}

export type AiCodeCompactCandidateLinePayload = AiCodeCommitCandidateLine

export interface AiCodeCompactCommitReport {
	version: "v3"
	source: "kilocode-ai-code-stats"
	mode: "commit_report"
	semanticsVersion: 1
	attributionInputVersion?: 1
	reportId: string
	reportGeneratedAt: number
	client: AiCodeStatsUploadClient
	defaults: AiCodeCompactDefaults
	repoRoot: string
	projectKey?: string
	projectName?: string
	gitRemoteUrl?: string
	gitBranch?: string
	commitHash: string
	previousCommitHash?: string
	commitOccurredAt: number
	snapshots: AiCodeSnapshotPayload[]
	acceptedBlocks?: AiCodeCompactBlockPayload[]
	generatedBlocks?: AiCodeCompactBlockPayload[]
	changedFiles: AiCodeCompactChangedFilePayload[]
	candidateLines?: AiCodeCompactCandidateLinePayload[]
}

export function normalizeSnapshotContent(content: string): string {
	return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
}

export function hashSnapshotContent(content: string): string {
	return createHash("sha256").update(normalizeSnapshotContent(content)).digest("hex")
}

export function countSnapshotLines(content: string): number {
	if (content.length === 0) {
		return 0
	}
	return content.split("\n").length
}

export function buildCompactCommitReportPayload(
	report: AiCodeCommitReport,
	fallbackUserEmail: string,
): AiCodeCompactCommitReport {
	const normalizedFallbackUserEmail = normalizeUserEmail(fallbackUserEmail) ?? fallbackUserEmail
	const defaults = resolveDefaults(report, normalizedFallbackUserEmail)
	const snapshots = new Map<string, AiCodeSnapshotPayload>()

	const rememberSnapshot = (content?: string): string | undefined => {
		if (typeof content !== "string") {
			return undefined
		}
		const normalizedContent = normalizeSnapshotContent(content)
		if (!normalizedContent.trim()) {
			return undefined
		}
		const contentHash = hashSnapshotContent(normalizedContent)
		if (!snapshots.has(contentHash)) {
			snapshots.set(contentHash, {
				contentHash,
				content: normalizedContent,
				length: Buffer.byteLength(normalizedContent, "utf8"),
				lineCount: countSnapshotLines(normalizedContent),
			})
		}
		return contentHash
	}

	const compactBlocks = (blocks?: AiCodeGeneratedBlock[]): AiCodeCompactBlockPayload[] | undefined => {
		const result = (blocks ?? []).map((block) =>
			compactBlock(block, defaults, normalizedFallbackUserEmail, rememberSnapshot),
		)
		return result.length > 0 ? result : undefined
	}

	const payload: AiCodeCompactCommitReport = {
		version: "v3",
		source: "kilocode-ai-code-stats",
		mode: "commit_report",
		semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
		attributionInputVersion: report.attributionInputVersion,
		reportId: report.reportId,
		reportGeneratedAt: report.reportGeneratedAt,
		client: report.client,
		defaults,
		repoRoot: normalizePath(report.repoRoot),
		projectKey: report.projectKey,
		projectName: report.projectName,
		gitRemoteUrl: report.gitRemoteUrl,
		gitBranch: report.gitBranch,
		commitHash: report.commitHash,
		previousCommitHash: report.previousCommitHash,
		commitOccurredAt: report.commitOccurredAt,
		snapshots: [],
		acceptedBlocks: compactBlocks(report.acceptedBlocks),
		generatedBlocks: compactBlocks(report.generatedBlocks),
		changedFiles: (report.changedFiles || []).map((file) => compactChangedFile(file, rememberSnapshot)),
		candidateLines: compactCandidateLines(report.candidateLines, defaults, normalizedFallbackUserEmail),
	}
	payload.snapshots = [...snapshots.values()]
	return payload
}

function resolveDefaults(report: AiCodeCommitReport, fallbackUserEmail: string): AiCodeCompactDefaults {
	const firstBlock = report.acceptedBlocks?.[0] ?? report.generatedBlocks?.[0]
	const firstLine = report.candidateLines?.[0]
	return {
		sourceType: "agent_insert",
		ide: report.client.ide,
		userName: firstBlock?.userName ?? firstLine?.userName,
		departmentName: firstBlock?.departmentName ?? firstLine?.departmentName,
		officeName: firstBlock?.officeName ?? firstLine?.officeName,
		teamName: firstBlock?.teamName ?? firstLine?.teamName,
		userEmail: normalizeUserEmail(firstBlock?.userEmail ?? firstLine?.userEmail) ?? fallbackUserEmail,
		organizationId: firstBlock?.organizationId ?? firstLine?.organizationId,
		organizationName: firstBlock?.organizationName ?? firstLine?.organizationName,
		sourceIp: firstBlock?.sourceIp ?? firstLine?.sourceIp,
		projectKey: report.projectKey,
		projectName: report.projectName,
		repoRoot: normalizePath(report.repoRoot),
		gitRemoteUrl: report.gitRemoteUrl,
		gitBranch: report.gitBranch,
	}
}

function compactBlock(
	block: AiCodeGeneratedBlock,
	defaults: AiCodeCompactDefaults,
	fallbackUserEmail: string,
	rememberSnapshot: (content?: string) => string | undefined,
): AiCodeCompactBlockPayload {
	const normalized: AiCodeCompactBlockPayload = {
		eventId: block.eventId,
		generatedBlockId: block.generatedBlockId,
		timestamp: block.timestamp,
		semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
		sourceType: block.sourceType,
		ide: block.ide,
		userName: block.userName,
		departmentName: block.departmentName,
		officeName: block.officeName,
		teamName: block.teamName,
		userEmail: normalizeUserEmail(block.userEmail) ?? fallbackUserEmail,
		organizationId: block.organizationId,
		organizationName: block.organizationName,
		sourceIp: block.sourceIp,
		projectKey: block.projectKey,
		projectName: block.projectName,
		repoRoot: block.repoRoot ? normalizePath(block.repoRoot) : undefined,
		repoRelativePath: block.repoRelativePath ? normalizePath(block.repoRelativePath) : undefined,
		filePath: normalizePath(block.filePath),
		relativePath: normalizePath(block.relativePath),
		language: block.language,
		gitRemoteUrl: block.gitRemoteUrl,
		gitBranch: block.gitBranch,
		lineStart: block.lineStart,
		lineEnd: block.lineEnd,
		lineCount: block.lineCount,
		codeSnippet: block.codeSnippet,
		fileSnapshotHash: rememberSnapshot(block.fileSnapshotContent) ?? block.fileSnapshotHash,
		taskId: block.taskId,
	}
	omitDefaults(normalized, defaults)
	return dropUndefined(normalized) as AiCodeCompactBlockPayload
}

function compactChangedFile(
	file: AiCodeCommitChangedFile,
	rememberSnapshot: (content?: string) => string | undefined,
): AiCodeCompactChangedFilePayload {
	return dropUndefined({
		relativePath: normalizePath(file.relativePath),
		filePath: normalizePath(file.filePath),
		previousFilePath: file.previousFilePath ? normalizePath(file.previousFilePath) : undefined,
		language: file.language,
		committedSnapshotHash: rememberSnapshot(file.committedSnapshotContent) ?? file.committedSnapshotHash,
		changedBlocks: (file.changedBlocks || []).map((block) => ({ ...block })),
		addedLines: (file.addedLines || []).map((line) => ({ ...line })),
	}) as AiCodeCompactChangedFilePayload
}

function compactCandidateLines(
	lines: AiCodeCommitCandidateLine[] | undefined,
	defaults: AiCodeCompactDefaults,
	fallbackUserEmail: string,
): AiCodeCompactCandidateLinePayload[] | undefined {
	const result = (lines ?? []).map((line) => {
		const normalized: AiCodeCompactCandidateLinePayload = {
			...line,
			sourceType: "agent_insert",
			ide: line.ide || defaults.ide || "unknown",
			userEmail: normalizeUserEmail(line.userEmail) ?? fallbackUserEmail,
			filePath: normalizePath(line.filePath),
			relativePath: normalizePath(line.relativePath),
			repoRoot: normalizePath(line.repoRoot),
			repoRelativePath: normalizePath(line.repoRelativePath),
		}
		omitDefaults(normalized, defaults)
		return dropUndefined(normalized) as AiCodeCompactCandidateLinePayload
	})
	return result.length > 0 ? result : undefined
}

function omitDefaults(target: Record<string, unknown>, defaults: AiCodeCompactDefaults): void {
	for (const [key, value] of Object.entries(defaults)) {
		if (value !== undefined && target[key] === value) {
			delete target[key]
		}
	}
}

function dropUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
	return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>
}
