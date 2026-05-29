import { HTMLAttributes, useEffect, useState } from "react"
import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"

import { useAppTranslation } from "@/i18n/TranslationContext"
import { vscode } from "@/utils/vscode"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@src/components/ui"

import { SearchableSetting } from "./SearchableSetting"
import { Section } from "./Section"
import { SectionHeader } from "./SectionHeader"
import { SetCachedStateField } from "./types"

// kilocode_change start
export interface StatisticsOfficeOption {
	name: string
	teams: string[]
}

export interface StatisticsDepartmentOption {
	name: string
	offices: StatisticsOfficeOption[]
}

export interface StatisticsIdentityFields {
	departmentName?: string
	officeName?: string
	teamName?: string
	userName?: string
	userEmail?: string
}

export type StatisticsIdentityValidationField = "department" | "office" | "team" | "userName" | "userEmail"

type CommitUploadRecordStatus =
	| "queued"
	| "uploaded"
	| "upload_failed"
	| "needs_reanalysis"
	| "reanalysis_failed"
	| "processing"
	| "server_processing"
	| "server_failed"

interface CommitUploadRecord {
	id: string
	commitHash: string
	repoRoot: string
	gitRemoteUrl?: string
	gitBranch?: string
	commitOccurredAt?: number
	status: CommitUploadRecordStatus
	reportId?: string
	lastError?: string
	lastUserMessage?: string
	addedLineCount?: number
	changedFileCount?: number
	repoName?: string
}

const STATISTICS_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export const normalizeStatisticsEmail = (value?: string): string => value?.trim().toLowerCase() ?? ""

const CLOUD_STORAGE_TEAM_OPTIONS = [
	"研发一组",
	"研发二组",
	"研发三组",
	"研发四组",
	"研发五组",
	"研发六组",
	"研发七组",
	"研发八组",
]

export const STATISTICS_DEPARTMENT_OPTIONS: StatisticsDepartmentOption[] = [
	{
		name: "云计算研发部",
		offices: [
			{ name: "经理室", teams: [] },
			{ name: "研发一处", teams: ["经理室", "研发一组", "研发二组", "研发三组", "研发四组", "研发五组"] },
			{ name: "研发二处", teams: ["经理室", "研发一组", "研发二组", "研发三组"] },
			{ name: "研发三处", teams: ["经理室", "研发一组", "研发二组", "研发三组"] },
			{
				name: "研发四处",
				teams: ["经理室", "研发一组", "研发二组", "研发三组", "研发四组", "研发五组", "研发六组"],
			},
			{ name: "研发五处", teams: ["经理室", "研发一组", "研发二组", "研发三组", "研发四组"] },
		],
	},
	{
		name: "云存储研发部",
		offices: [
			{ name: "经理室", teams: [] },
			{ name: "架设处", teams: CLOUD_STORAGE_TEAM_OPTIONS },
			{ name: "核心软件处", teams: CLOUD_STORAGE_TEAM_OPTIONS },
			{ name: "研发保障处", teams: CLOUD_STORAGE_TEAM_OPTIONS },
			{ name: "管理软件处", teams: CLOUD_STORAGE_TEAM_OPTIONS },
			{ name: "硬件开发处", teams: CLOUD_STORAGE_TEAM_OPTIONS },
			{ name: "测试验证处", teams: CLOUD_STORAGE_TEAM_OPTIONS },
			{ name: "服务支持处", teams: [] },
			{ name: "项目管理处", teams: CLOUD_STORAGE_TEAM_OPTIONS },
		],
	},
]

export const getStatisticsOfficeOptions = (departmentName?: string): StatisticsOfficeOption[] =>
	STATISTICS_DEPARTMENT_OPTIONS.find((department) => department.name === departmentName)?.offices ?? []

export const getStatisticsTeamOptions = (departmentName?: string, officeName?: string): string[] =>
	getStatisticsOfficeOptions(departmentName).find((office) => office.name === officeName)?.teams ?? []

export const getStatisticsIdentityValidationKey = ({
	departmentName,
	officeName,
	teamName,
	userName,
	userEmail,
}: StatisticsIdentityFields): string | undefined => {
	if (!departmentName?.trim()) {
		return "settings:statistics.validation.departmentRequired"
	}
	if (!officeName?.trim()) {
		return "settings:statistics.validation.officeRequired"
	}
	if (getStatisticsTeamOptions(departmentName, officeName).length > 0 && !teamName?.trim()) {
		return "settings:statistics.validation.teamRequired"
	}
	if (!userName?.trim()) {
		return "settings:statistics.validation.nameRequired"
	}
	const normalizedUserEmail = normalizeStatisticsEmail(userEmail)
	if (!normalizedUserEmail) {
		return "settings:statistics.validation.emailRequired"
	}
	if (!STATISTICS_EMAIL_PATTERN.test(normalizedUserEmail)) {
		return "settings:statistics.validation.emailInvalid"
	}
	return undefined
}

const visibleCommitUploadStatuses = new Set<CommitUploadRecordStatus>([
	"upload_failed",
	"needs_reanalysis",
	"reanalysis_failed",
	"processing",
	"server_failed",
])

const formatCommitShortHash = (commitHash: string): string => commitHash.slice(0, 7)

const formatCommitTime = (timestamp?: number): string => {
	if (!timestamp) {
		return "--"
	}
	const date = new Date(timestamp)
	const month = String(date.getMonth() + 1).padStart(2, "0")
	const day = String(date.getDate()).padStart(2, "0")
	const hours = String(date.getHours()).padStart(2, "0")
	const minutes = String(date.getMinutes()).padStart(2, "0")
	return `${month}-${day} ${hours}:${minutes}`
}

const formatCommitUploadFailureReason = (lastError?: string): string => {
	const error = lastError?.trim()
	if (!error) {
		return "上报失败"
	}
	const normalized = error.toLowerCase()
	if (
		normalized === "fetch failed" ||
		normalized.includes("failed to fetch") ||
		normalized.includes("networkerror") ||
		normalized.includes("load failed") ||
		normalized.includes("econnrefused") ||
		normalized.includes("enotfound") ||
		normalized.includes("ehostunreach") ||
		normalized.includes("econnreset")
	) {
		return "无法连接上报服务器，请检查后台服务是否启动、服务器地址是否正确，或网络是否可达。"
	}
	if (normalized.includes("timeout") || normalized.includes("timed out") || normalized.includes("etimedout")) {
		return "连接上报服务器超时，请检查网络或后台服务状态。"
	}
	return error
}

const getCommitRecordCopy = (
	record: CommitUploadRecord,
): {
	tone: "warning" | "error" | "info"
	title: string
	action?: "retry" | "reanalyze"
	actionLabel?: string
	reason?: string
} => {
	if (record.status === "upload_failed") {
		return {
			tone: "error",
			title: "提交上报失败",
			action: "retry",
			actionLabel: "重传",
			reason: record.lastUserMessage || formatCommitUploadFailureReason(record.lastError),
		}
	}
	if (record.status === "server_failed") {
		return {
			tone: "error",
			title: "提交服务端处理失败",
			reason: record.lastError || "服务端归因失败",
		}
	}
	if (record.status === "processing") {
		return {
			tone: "info",
			title: "提交上报处理中",
			reason: "正在处理，请稍候",
		}
	}
	return {
		tone: record.status === "reanalysis_failed" ? "error" : "warning",
		title: record.status === "reanalysis_failed" ? "无法重新分析" : "提交上报未完成",
		action: "reanalyze",
		actionLabel: "重新分析并上报",
		reason:
			record.lastError ||
			(record.status === "reanalysis_failed"
				? "本地缓存或 Git diff 不足"
				: "可能由外部 Git 客户端提交或路径匹配失败导致"),
	}
}
// kilocode_change end

type StatisticsSettingsProps = HTMLAttributes<HTMLDivElement> & {
	aiCodeStatsWebhookUrl?: string
	// kilocode_change start
	aiCodeStatsDepartmentName?: string
	aiCodeStatsOfficeName?: string
	aiCodeStatsTeamName?: string
	// kilocode_change end
	aiCodeStatsUserName?: string
	aiCodeStatsUserEmail?: string
	setCachedStateField: SetCachedStateField<
		| "aiCodeStatsWebhookUrl"
		| "aiCodeStatsDepartmentName"
		| "aiCodeStatsOfficeName"
		| "aiCodeStatsTeamName"
		| "aiCodeStatsUserName"
		| "aiCodeStatsUserEmail"
	>
	webhookValidationError?: string
	// kilocode_change start
	identityValidationError?: string
	identityValidationErrorField?: StatisticsIdentityValidationField
	// kilocode_change end
}

export const StatisticsSettings = ({
	aiCodeStatsWebhookUrl,
	// kilocode_change start
	aiCodeStatsDepartmentName,
	aiCodeStatsOfficeName,
	aiCodeStatsTeamName,
	// kilocode_change end
	aiCodeStatsUserName,
	aiCodeStatsUserEmail,
	setCachedStateField,
	webhookValidationError,
	// kilocode_change start
	identityValidationError,
	identityValidationErrorField,
	// kilocode_change end
	...props
}: StatisticsSettingsProps) => {
	const { t } = useAppTranslation()
	const controlWidthClass = "w-full"
	const [commitUploadRecords, setCommitUploadRecords] = useState<CommitUploadRecord[]>([])
	const [pendingRecordId, setPendingRecordId] = useState<string | undefined>()
	// kilocode_change start
	const officeOptions = getStatisticsOfficeOptions(aiCodeStatsDepartmentName)
	const teamOptions = getStatisticsTeamOptions(aiCodeStatsDepartmentName, aiCodeStatsOfficeName)
	const selectedDepartmentName = STATISTICS_DEPARTMENT_OPTIONS.some(
		(department) => department.name === aiCodeStatsDepartmentName,
	)
		? aiCodeStatsDepartmentName
		: ""
	const selectedOfficeName = officeOptions.some((office) => office.name === aiCodeStatsOfficeName)
		? aiCodeStatsOfficeName
		: ""
	const selectedTeamName = teamOptions.includes(aiCodeStatsTeamName ?? "") ? aiCodeStatsTeamName : ""

	const handleDepartmentChange = (departmentName: string) => {
		setCachedStateField("aiCodeStatsDepartmentName", departmentName)
		setCachedStateField("aiCodeStatsOfficeName", "")
		setCachedStateField("aiCodeStatsTeamName", "")
	}

	const handleOfficeChange = (officeName: string) => {
		setCachedStateField("aiCodeStatsOfficeName", officeName)
		setCachedStateField("aiCodeStatsTeamName", "")
	}

	const identityValidationErrorTarget = identityValidationErrorField ?? "userEmail"
	const renderIdentityValidationError = (field: StatisticsIdentityValidationField) =>
		identityValidationError && identityValidationErrorTarget === field ? (
			<div
				className="text-sm leading-6 text-vscode-errorForeground"
				role="status"
				aria-live="polite"
				data-validation-field={field}
				data-testid="ai-code-stats-identity-error">
				{identityValidationError}
			</div>
		) : null

	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			const message = event.data
			if (message?.type !== "aiCodeStatsCommitUploadRecords") {
				return
			}
			const records = Array.isArray(message.values?.records) ? message.values.records : []
			setCommitUploadRecords(
				records.filter((record: CommitUploadRecord) => visibleCommitUploadStatuses.has(record.status)),
			)
			setPendingRecordId(undefined)
		}
		window.addEventListener("message", handleMessage)
		vscode.postMessage({ type: "getAiCodeStatsCommitUploadRecords" })
		return () => window.removeEventListener("message", handleMessage)
	}, [])

	const runCommitUploadAction = (record: CommitUploadRecord, action: "retry" | "reanalyze" | "diagnostics") => {
		if (pendingRecordId) {
			return
		}
		setPendingRecordId(record.id)
		const type =
			action === "retry"
				? "retryAiCodeStatsCommitUpload"
				: action === "reanalyze"
					? "reanalyzeAiCodeStatsCommitUpload"
					: "exportAiCodeStatsDiagnostics"
		vscode.postMessage({ type, text: record.id })
	}

	const renderCommitUploadRecords = () => {
		if (commitUploadRecords.length === 0) {
			return null
		}
		return (
			<div className="flex flex-col gap-2" data-testid="commit-upload-status-region">
				<div className="text-sm font-medium text-vscode-foreground">提交上报状态</div>
				{commitUploadRecords.map((record) => {
					const copy = getCommitRecordCopy(record)
					const isPending = pendingRecordId === record.id
					const toneClass =
						copy.tone === "error"
							? "border-vscode-errorForeground bg-vscode-input-background"
							: copy.tone === "info"
								? "border-vscode-textLink-foreground bg-vscode-input-background"
								: "border-vscode-editorWarning-foreground bg-vscode-input-background"
					return (
						<div
							key={record.id}
							className={`min-w-0 rounded-md border p-3 ${toneClass}`}
							data-testid="commit-upload-status-card">
							<div className="flex min-w-0 flex-col gap-2">
								<div className="min-w-0 text-sm font-semibold text-vscode-foreground">{copy.title}</div>
								<div className="flex min-w-0 flex-wrap gap-1.5 text-xs text-vscode-descriptionForeground">
									<span className="rounded bg-vscode-badge-background px-1.5 py-0.5 text-vscode-badge-foreground">
										{formatCommitShortHash(record.commitHash)}
									</span>
									<span className="min-w-0 max-w-full truncate rounded bg-vscode-input-background px-1.5 py-0.5">
										{record.repoName ||
											record.repoRoot.split(/[\\/]/).filter(Boolean).pop() ||
											"repo"}
									</span>
									<span className="rounded bg-vscode-input-background px-1.5 py-0.5">
										{formatCommitTime(record.commitOccurredAt)}
									</span>
									{typeof record.addedLineCount === "number" && record.addedLineCount > 0 && (
										<span className="rounded bg-vscode-input-background px-1.5 py-0.5 text-vscode-charts-green">
											+{record.addedLineCount} 行
										</span>
									)}
								</div>
								{copy.reason && (
									<div
										className={`break-words text-xs ${
											copy.tone === "error"
												? "text-vscode-errorForeground"
												: "text-vscode-descriptionForeground"
										}`}
										data-testid="commit-upload-status-reason">
										{copy.reason}
									</div>
								)}
								<div className="flex flex-wrap gap-2">
									{copy.action && (
										<button
											type="button"
											disabled={Boolean(pendingRecordId)}
											className="rounded bg-vscode-button-background px-2.5 py-1 text-xs text-vscode-button-foreground disabled:cursor-not-allowed disabled:opacity-60"
											onClick={() => runCommitUploadAction(record, copy.action!)}
											data-testid={`commit-upload-${copy.action}-button`}>
											{isPending ? "处理中..." : copy.actionLabel}
										</button>
									)}
									<button
										type="button"
										disabled={Boolean(pendingRecordId)}
										className="rounded border border-vscode-panel-border px-2.5 py-1 text-xs text-vscode-foreground disabled:cursor-not-allowed disabled:opacity-60"
										onClick={() => runCommitUploadAction(record, "diagnostics")}
										data-testid="commit-upload-diagnostics-button">
										诊断
									</button>
								</div>
							</div>
						</div>
					)
				})}
			</div>
		)
	}
	// kilocode_change end

	return (
		<div {...props}>
			<SectionHeader>{t("settings:sections.statistics")}</SectionHeader>
			<Section>
				<div className="flex flex-col gap-6">
					{/* kilocode_change start */}
					<SearchableSetting
						settingId="statistics-department-name"
						section="statistics"
						label={t("settings:statistics.department.label")}
						className="flex flex-col gap-2.5">
						<label className="block font-medium" htmlFor="ai-code-stats-department-name">
							{t("settings:statistics.department.label")}
						</label>
						<Select
							value={selectedDepartmentName}
							onValueChange={handleDepartmentChange}
							data-testid="ai-code-stats-department-name">
							<SelectTrigger id="ai-code-stats-department-name" className={controlWidthClass}>
								<SelectValue placeholder={t("settings:statistics.department.placeholder")} />
							</SelectTrigger>
							<SelectContent>
								<SelectGroup>
									{STATISTICS_DEPARTMENT_OPTIONS.map((department) => (
										<SelectItem key={department.name} value={department.name}>
											{department.name}
										</SelectItem>
									))}
								</SelectGroup>
							</SelectContent>
						</Select>
						{renderIdentityValidationError("department")}
					</SearchableSetting>

					<SearchableSetting
						settingId="statistics-office-name"
						section="statistics"
						label={t("settings:statistics.office.label")}
						className="flex flex-col gap-2.5">
						<label className="block font-medium" htmlFor="ai-code-stats-office-name">
							{t("settings:statistics.office.label")}
						</label>
						<Select
							value={selectedOfficeName}
							onValueChange={handleOfficeChange}
							disabled={!selectedDepartmentName}
							data-testid="ai-code-stats-office-name">
							<SelectTrigger id="ai-code-stats-office-name" className={controlWidthClass}>
								<SelectValue placeholder={t("settings:statistics.office.placeholder")} />
							</SelectTrigger>
							<SelectContent>
								<SelectGroup>
									{officeOptions.map((office) => (
										<SelectItem key={office.name} value={office.name}>
											{office.name}
										</SelectItem>
									))}
								</SelectGroup>
							</SelectContent>
						</Select>
						{renderIdentityValidationError("office")}
					</SearchableSetting>

					{teamOptions.length > 0 && (
						<SearchableSetting
							settingId="statistics-team-name"
							section="statistics"
							label={t("settings:statistics.team.label")}
							className="flex flex-col gap-2.5">
							<label className="block font-medium" htmlFor="ai-code-stats-team-name">
								{t("settings:statistics.team.label")}
							</label>
							<Select
								value={selectedTeamName}
								onValueChange={(teamName) => setCachedStateField("aiCodeStatsTeamName", teamName)}
								disabled={!selectedOfficeName}
								data-testid="ai-code-stats-team-name">
								<SelectTrigger id="ai-code-stats-team-name" className={controlWidthClass}>
									<SelectValue placeholder={t("settings:statistics.team.placeholder")} />
								</SelectTrigger>
								<SelectContent>
									<SelectGroup>
										{teamOptions.map((team) => (
											<SelectItem key={team} value={team}>
												{team}
											</SelectItem>
										))}
									</SelectGroup>
								</SelectContent>
							</Select>
							{renderIdentityValidationError("team")}
						</SearchableSetting>
					)}
					{/* kilocode_change end */}

					<SearchableSetting
						settingId="statistics-user-name"
						section="statistics"
						label={t("settings:statistics.userName.label")}
						className="flex flex-col gap-2.5">
						<label className="block font-medium" htmlFor="ai-code-stats-user-name">
							{t("settings:statistics.userName.label")}
						</label>
						<VSCodeTextField
							id="ai-code-stats-user-name"
							name="aiCodeStatsUserName"
							spellCheck={false}
							className={controlWidthClass}
							value={aiCodeStatsUserName ?? ""}
							onChange={(e: any) => setCachedStateField("aiCodeStatsUserName", e.target.value)}
							placeholder={t("settings:statistics.userName.placeholder")}
							data-testid="ai-code-stats-user-name"
						/>
						{renderIdentityValidationError("userName")}
					</SearchableSetting>

					<SearchableSetting
						settingId="statistics-user-email"
						section="statistics"
						label={t("settings:statistics.userEmail.label")}
						className="flex flex-col gap-2.5">
						<label className="block font-medium" htmlFor="ai-code-stats-user-email">
							{t("settings:statistics.userEmail.label")}
						</label>
						<VSCodeTextField
							id="ai-code-stats-user-email"
							name="aiCodeStatsUserEmail"
							type="email"
							inputMode="email"
							spellCheck={false}
							className={controlWidthClass}
							value={aiCodeStatsUserEmail ?? ""}
							onChange={(e: any) => setCachedStateField("aiCodeStatsUserEmail", e.target.value)}
							placeholder={t("settings:statistics.userEmail.placeholder")}
							data-testid="ai-code-stats-user-email"
						/>
						{renderIdentityValidationError("userEmail")}
					</SearchableSetting>

					<SearchableSetting
						settingId="statistics-webhook-url"
						section="statistics"
						label={t("settings:statistics.webhook.label")}
						className="flex flex-col gap-2.5">
						<label className="block font-medium" htmlFor="ai-code-stats-webhook-url">
							{t("settings:statistics.webhook.label")}
						</label>
						<VSCodeTextField
							id="ai-code-stats-webhook-url"
							name="aiCodeStatsWebhookUrl"
							type="url"
							inputMode="url"
							spellCheck={false}
							className={controlWidthClass}
							value={aiCodeStatsWebhookUrl ?? ""}
							onChange={(e: any) => setCachedStateField("aiCodeStatsWebhookUrl", e.target.value)}
							placeholder={t("settings:statistics.webhook.placeholder")}
							data-testid="ai-code-stats-webhook-url"
						/>
						<div className="text-sm leading-6 text-vscode-descriptionForeground">
							{t("settings:statistics.webhook.description")}
						</div>
						{webhookValidationError && (
							<div
								className="text-sm leading-6 text-vscode-errorForeground"
								role="status"
								aria-live="polite"
								data-testid="ai-code-stats-webhook-error">
								{webhookValidationError}
							</div>
						)}
					</SearchableSetting>
					{renderCommitUploadRecords()}
				</div>
			</Section>
		</div>
	)
}
