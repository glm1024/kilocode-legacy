import { HTMLAttributes, useEffect, useMemo, useRef, useState } from "react"
import { VSCodeButton, VSCodeDropdown, VSCodeOption, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"

import { useAppTranslation } from "@/i18n/TranslationContext"
import { vscode } from "@/utils/vscode"

import { SearchableSetting } from "./SearchableSetting"
import { Section } from "./Section"
import { SectionHeader } from "./SectionHeader"
import { SetCachedStateField } from "./types"

type StatisticsSettingsProps = HTMLAttributes<HTMLDivElement> & {
	aiCodeStatsWebhookUrl?: string
	// kilocode_change start
	aiCodeStatsUserName?: string
	setCachedStateField: SetCachedStateField<"aiCodeStatsWebhookUrl" | "aiCodeStatsUserName">
	// kilocode_change end
	webhookValidationError?: string
}

type AiCodeStatsRangeType = "current" | "last3days" | "last7days" | "last30days" | "custom" | "all"

interface AiCodeStatsRange {
	type: AiCodeStatsRangeType
	startDate?: string
	endDate?: string
}

interface AiCodeStatsSummaryResponse {
	generatedLines: number
	lastSuccessfulUploadAt?: number
}

interface AiCodeStatsUploadTestResult {
	success: boolean
	message: string
}

const EMPTY_SUMMARY: AiCodeStatsSummaryResponse = {
	generatedLines: 0,
	lastSuccessfulUploadAt: undefined,
}

const DEFAULT_UPLOAD_RESULT: AiCodeStatsUploadTestResult = {
	success: true,
	message: "",
}

const toSafeNumber = (value: unknown): number => {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value
	}
	return 0
}

const buildRange = (type: AiCodeStatsRangeType, startDate?: string, endDate?: string): AiCodeStatsRange => {
	if (type === "custom") {
		return {
			type,
			startDate: (startDate ?? "").trim() || undefined,
			endDate: (endDate ?? "").trim() || undefined,
		}
	}
	return { type }
}

const normalizeSummary = (value: unknown): AiCodeStatsSummaryResponse => {
	if (!value || typeof value !== "object") {
		return EMPTY_SUMMARY
	}

	const raw = value as Record<string, unknown>
	return {
		generatedLines: toSafeNumber(raw.generatedLines),
		lastSuccessfulUploadAt: typeof raw.lastSuccessfulUploadAt === "number" ? raw.lastSuccessfulUploadAt : undefined,
	}
}

export const StatisticsSettings = ({
	aiCodeStatsWebhookUrl,
	// kilocode_change start
	aiCodeStatsUserName,
	// kilocode_change end
	setCachedStateField,
	webhookValidationError,
	...props
}: StatisticsSettingsProps) => {
	const { t } = useAppTranslation()
	const [summary, setSummary] = useState<AiCodeStatsSummaryResponse>(EMPTY_SUMMARY)
	const [statsRangeType, setStatsRangeType] = useState<AiCodeStatsRangeType>("current")
	const [statsCustomStartDate, setStatsCustomStartDate] = useState("")
	const [statsCustomEndDate, setStatsCustomEndDate] = useState("")
	const [uploadRangeType, setUploadRangeType] = useState<AiCodeStatsRangeType>("last3days")
	const [uploadCustomStartDate, setUploadCustomStartDate] = useState("")
	const [uploadCustomEndDate, setUploadCustomEndDate] = useState("")
	const [uploadTesting, setUploadTesting] = useState(false)
	const [uploadTestResult, setUploadTestResult] = useState<AiCodeStatsUploadTestResult>(DEFAULT_UPLOAD_RESULT)
	const requestSummaryRef = useRef<() => void>(() => undefined)
	const controlWidthClass = "w-full"

	useEffect(() => {
		const requestSummary = () => {
			vscode.postMessage({
				type: "getAiCodeStatsSummary",
				values: {
					range: buildRange(statsRangeType, statsCustomStartDate, statsCustomEndDate),
				},
			})
		}
		requestSummaryRef.current = requestSummary
		requestSummary()
		const timer = window.setInterval(requestSummary, 30_000)

		return () => {
			window.clearInterval(timer)
		}
	}, [statsRangeType, statsCustomStartDate, statsCustomEndDate])

	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			const message = event.data
			if (message?.type === "aiCodeStatsSummaryResponse") {
				setSummary(normalizeSummary(message.values))
				return
			}

			if (message?.type === "aiCodeStatsUploadTestResult") {
				const success = Boolean(message.success)
				const errorCode = (message.values as Record<string, unknown> | undefined)?.errorCode
				const text =
					errorCode === "webhook_not_configured"
						? t("settings:statistics.uploadTest.webhookRequired")
						: typeof message.text === "string" && message.text.trim().length > 0
							? message.text
							: success
								? t("settings:statistics.uploadTest.success")
								: t("settings:statistics.uploadTest.failed")

				setUploadTestResult({
					success,
					message: text,
				})
				setUploadTesting(false)

				if (success) {
					requestSummaryRef.current()
				}
			}
		}

		window.addEventListener("message", handleMessage)
		return () => window.removeEventListener("message", handleMessage)
	}, [t])

	const lastSuccessfulUploadText = useMemo(() => {
		if (typeof summary.lastSuccessfulUploadAt !== "number") {
			return t("settings:statistics.lastSuccessfulUpload.empty")
		}
		return new Date(summary.lastSuccessfulUploadAt).toLocaleString()
	}, [summary.lastSuccessfulUploadAt, t])

	const triggerUploadTest = () => {
		if (uploadTesting) {
			return
		}

		if (!(aiCodeStatsWebhookUrl ?? "").trim()) {
			setUploadTestResult({
				success: false,
				message: t("settings:statistics.uploadTest.webhookRequired"),
			})
			return
		}

		setUploadTesting(true)
		setUploadTestResult(DEFAULT_UPLOAD_RESULT)
		vscode.postMessage({
			type: "testAiCodeStatsUpload",
			values: {
				range: buildRange(uploadRangeType, uploadCustomStartDate, uploadCustomEndDate),
			},
		})
	}

	const hasGeneratedLines = summary.generatedLines > 0

	return (
		<div {...props}>
			<SectionHeader>{t("settings:sections.statistics")}</SectionHeader>
			<Section>
				<div className="flex flex-col gap-5">
					<div className="text-vscode-descriptionForeground text-sm" data-testid="ai-code-stats-tip">
						{t("settings:statistics.tip")}
					</div>

					{/* kilocode_change start */}
					<SearchableSetting
						settingId="statistics-user-name"
						section="statistics"
						label={t("settings:statistics.userName.label")}
						className="flex flex-col gap-2.5">
						<label className="block font-medium">{t("settings:statistics.userName.label")}</label>
						<VSCodeTextField
							className={controlWidthClass}
							value={aiCodeStatsUserName ?? ""}
							onChange={(e: any) => setCachedStateField("aiCodeStatsUserName", e.target.value)}
							placeholder={t("settings:statistics.userName.placeholder")}
							data-testid="ai-code-stats-user-name"
						/>
					</SearchableSetting>
					{/* kilocode_change end */}

					<SearchableSetting
						settingId="statistics-webhook-url"
						section="statistics"
						label={t("settings:statistics.webhook.label")}
						className="flex flex-col gap-2.5">
						<label className="block font-medium">{t("settings:statistics.webhook.label")}</label>
						<VSCodeTextField
							className={controlWidthClass}
							value={aiCodeStatsWebhookUrl ?? ""}
							onChange={(e: any) => setCachedStateField("aiCodeStatsWebhookUrl", e.target.value)}
							placeholder={t("settings:statistics.webhook.placeholder")}
							data-testid="ai-code-stats-webhook-url"
						/>
						<div className="text-vscode-descriptionForeground text-sm">
							{t("settings:statistics.webhook.description")}
						</div>
						{webhookValidationError && (
							<div
								className="text-vscode-errorForeground text-sm"
								data-testid="ai-code-stats-webhook-error">
								{webhookValidationError}
							</div>
						)}
					</SearchableSetting>

					<SearchableSetting
						settingId="statistics-last-successful-upload"
						section="statistics"
						label={t("settings:statistics.lastSuccessfulUpload.label")}
						className="flex flex-col gap-2.5">
						<label className="block font-medium">
							{t("settings:statistics.lastSuccessfulUpload.label")}
						</label>
						<div
							className="text-vscode-descriptionForeground text-sm"
							data-testid="ai-code-stats-last-successful-upload">
							{lastSuccessfulUploadText}
						</div>
					</SearchableSetting>

					<SearchableSetting
						settingId="statistics-generated-lines"
						section="statistics"
						label={t("settings:statistics.generatedLines.label")}
						className="flex flex-col gap-2.5">
						<label className="block font-medium">{t("settings:statistics.generatedLines.label")}</label>
						<VSCodeDropdown
							className={controlWidthClass}
							value={statsRangeType}
							onChange={(event: any) => setStatsRangeType(event.target.value as AiCodeStatsRangeType)}
							data-testid="ai-code-stats-range-select">
							<VSCodeOption value="current">{t("settings:statistics.range.current")}</VSCodeOption>
							<VSCodeOption value="last7days">{t("settings:statistics.range.last7days")}</VSCodeOption>
							<VSCodeOption value="last30days">{t("settings:statistics.range.last30days")}</VSCodeOption>
							<VSCodeOption value="all">{t("settings:statistics.range.all")}</VSCodeOption>
							<VSCodeOption value="custom">{t("settings:statistics.range.custom")}</VSCodeOption>
						</VSCodeDropdown>

						{statsRangeType === "custom" && (
							<div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
								<input
									type="date"
									value={statsCustomStartDate}
									onChange={(event) => setStatsCustomStartDate(event.target.value)}
									className="bg-vscode-input-background text-vscode-input-foreground border border-vscode-input-border rounded-sm px-2 py-1 w-full"
									data-testid="ai-code-stats-custom-start"
								/>
								<input
									type="date"
									value={statsCustomEndDate}
									onChange={(event) => setStatsCustomEndDate(event.target.value)}
									className="bg-vscode-input-background text-vscode-input-foreground border border-vscode-input-border rounded-sm px-2 py-1 w-full"
									data-testid="ai-code-stats-custom-end"
								/>
							</div>
						)}

						<div
							className={
								hasGeneratedLines
									? "text-2xl font-semibold leading-none"
									: "text-vscode-descriptionForeground text-sm"
							}
							data-testid="ai-code-stats-generated-lines">
							{hasGeneratedLines ? summary.generatedLines : t("settings:statistics.generatedLines.empty")}
						</div>
					</SearchableSetting>

					<SearchableSetting
						settingId="statistics-upload-test"
						section="statistics"
						label={t("settings:statistics.uploadTest.title")}
						className="flex flex-col gap-2.5">
						<label className="block font-medium">{t("settings:statistics.uploadTest.title")}</label>
						<div className="text-vscode-descriptionForeground text-sm">
							{t("settings:statistics.uploadTest.description")}
						</div>
						<div className="flex flex-col gap-2.5">
							<VSCodeDropdown
								className={controlWidthClass}
								value={uploadRangeType}
								onChange={(event: any) =>
									setUploadRangeType(event.target.value as AiCodeStatsRangeType)
								}
								data-testid="ai-code-stats-upload-range-select">
								<VSCodeOption value="last3days">
									{t("settings:statistics.range.last3days")}
								</VSCodeOption>
								<VSCodeOption value="last7days">
									{t("settings:statistics.range.last7days")}
								</VSCodeOption>
								<VSCodeOption value="last30days">
									{t("settings:statistics.range.last30days")}
								</VSCodeOption>
								<VSCodeOption value="all">{t("settings:statistics.range.all")}</VSCodeOption>
								<VSCodeOption value="custom">{t("settings:statistics.range.custom")}</VSCodeOption>
							</VSCodeDropdown>

							{uploadRangeType === "custom" && (
								<div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
									<input
										type="date"
										value={uploadCustomStartDate}
										onChange={(event) => setUploadCustomStartDate(event.target.value)}
										className="bg-vscode-input-background text-vscode-input-foreground border border-vscode-input-border rounded-sm px-2 py-1 w-full"
										data-testid="ai-code-stats-upload-custom-start"
									/>
									<input
										type="date"
										value={uploadCustomEndDate}
										onChange={(event) => setUploadCustomEndDate(event.target.value)}
										className="bg-vscode-input-background text-vscode-input-foreground border border-vscode-input-border rounded-sm px-2 py-1 w-full"
										data-testid="ai-code-stats-upload-custom-end"
									/>
								</div>
							)}

							<VSCodeButton
								appearance="primary"
								className={controlWidthClass}
								onClick={triggerUploadTest}
								disabled={uploadTesting}
								data-testid="ai-code-stats-upload-test-button">
								{uploadTesting
									? t("settings:statistics.uploadTest.testing")
									: t("settings:statistics.uploadTest.button")}
							</VSCodeButton>
						</div>

						{uploadTestResult.message && (
							<div
								className={
									uploadTestResult.success
										? "text-vscode-descriptionForeground text-sm"
										: "text-vscode-errorForeground text-sm"
								}
								data-testid="ai-code-stats-upload-test-result">
								{uploadTestResult.message}
							</div>
						)}
					</SearchableSetting>
				</div>
			</Section>
		</div>
	)
}
