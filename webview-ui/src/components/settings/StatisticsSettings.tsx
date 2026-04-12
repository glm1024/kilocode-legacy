import { HTMLAttributes, useEffect, useMemo, useState } from "react"
import { Info } from "lucide-react"
import { VSCodeDropdown, VSCodeOption, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"

import { useAppTranslation } from "@/i18n/TranslationContext"
import { vscode } from "@/utils/vscode"
import { Button, StandardTooltip } from "@/components/ui"

import { SearchableSetting } from "./SearchableSetting"
import { Section } from "./Section"
import { SectionHeader } from "./SectionHeader"
import { SetCachedStateField } from "./types"

type StatisticsSettingsProps = HTMLAttributes<HTMLDivElement> & {
	aiCodeStatsWebhookUrl?: string
	aiCodeStatsUserName?: string
	setCachedStateField: SetCachedStateField<"aiCodeStatsWebhookUrl" | "aiCodeStatsUserName">
	webhookValidationError?: string
}

type AiCodeStatsRangeType = "current" | "last7days" | "last30days" | "custom" | "all"

interface AiCodeStatsRange {
	type: AiCodeStatsRangeType
	startDate?: string
	endDate?: string
}

interface AiCodeStatsSummaryResponse {
	generatedLines: number
	acceptedLines: number
	committedLines: number
	adoptionRate: number
	retentionRate: number
	inputTokens: number
	outputTokens: number
	totalTokens: number
}

const EMPTY_SUMMARY: AiCodeStatsSummaryResponse = {
	generatedLines: 0,
	acceptedLines: 0,
	committedLines: 0,
	adoptionRate: 0,
	retentionRate: 0,
	inputTokens: 0,
	outputTokens: 0,
	totalTokens: 0,
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
		acceptedLines: toSafeNumber(raw.acceptedLines),
		committedLines: toSafeNumber(raw.committedLines),
		adoptionRate: toSafeNumber(raw.adoptionRate),
		retentionRate: toSafeNumber(raw.retentionRate),
		inputTokens: toSafeNumber(raw.inputTokens),
		outputTokens: toSafeNumber(raw.outputTokens),
		totalTokens: toSafeNumber(raw.totalTokens),
	}
}

type MetricPanelProps = {
	label: string
	tooltip: string
	emptyText: string
	tooltipAriaLabel: string
	value: string
	hasData: boolean
	valueTestId: string
	animationClass: string
}

const statValueStyle = { fontVariantNumeric: "tabular-nums" as const }

const MetricPanel = ({
	label,
	tooltip,
	emptyText,
	tooltipAriaLabel,
	value,
	hasData,
	valueTestId,
	animationClass,
}: MetricPanelProps) => (
	<div className="relative flex min-h-[88px] flex-col justify-between overflow-hidden rounded-md border border-vscode-panel-border/85 bg-vscode-editor-background px-3.5 py-3 transition-[background-color,border-color,box-shadow] duration-150 ease-out hover:border-vscode-focusBorder/45 hover:bg-vscode-list-hoverBackground/10 focus-within:border-vscode-focusBorder motion-reduce:transition-none">
		<div className="absolute inset-x-3.5 top-0 h-px bg-vscode-focusBorder/22" aria-hidden="true" />
		<div className="flex items-start justify-between gap-2.5">
			<div className="text-[12px] font-medium leading-5 text-vscode-foreground/88">{label}</div>
			<StandardTooltip content={tooltip} side="top" maxWidth={220}>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					className="h-5 w-5 shrink-0 rounded-full border border-vscode-panel-border/65 text-vscode-descriptionForeground/90 hover:border-vscode-focusBorder/70 hover:text-vscode-foreground focus-visible:ring-1 focus-visible:ring-vscode-focusBorder"
					aria-label={tooltipAriaLabel}>
					<Info aria-hidden="true" className="h-3.25 w-3.25" />
				</Button>
			</StandardTooltip>
		</div>
		<div
			className={`transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none ${animationClass}`}
			style={statValueStyle}
			data-testid={valueTestId}>
			{hasData ? (
				<div className="text-[25px] font-medium leading-[1.05] tracking-[-0.01em] text-vscode-foreground">
					{value}
				</div>
			) : (
				<div className="text-sm text-vscode-descriptionForeground">{emptyText}</div>
			)}
		</div>
	</div>
)

type TokenPanelProps = {
	label: string
	tooltip: string
	emptyText: string
	tooltipAriaLabel: string
	inputLabel: string
	outputLabel: string
	totalLabel: string
	inputTokens: string
	outputTokens: string
	totalTokens: string
	hasData: boolean
	animationClass: string
}

const TokenPanel = ({
	label,
	tooltip,
	emptyText,
	tooltipAriaLabel,
	inputLabel,
	outputLabel,
	totalLabel,
	inputTokens,
	outputTokens,
	totalTokens,
	hasData,
	animationClass,
}: TokenPanelProps) => (
	<div
		className="relative min-h-[88px] overflow-hidden rounded-md border border-vscode-panel-border/80 bg-vscode-editor-background/95 px-4 py-3 transition-[background-color,border-color,box-shadow] duration-150 ease-out hover:border-vscode-focusBorder/35 hover:bg-vscode-list-hoverBackground/8 focus-within:border-vscode-focusBorder motion-reduce:transition-none"
		data-testid="ai-code-stats-token-panel">
		<div className="absolute inset-x-4 top-0 h-px bg-vscode-focusBorder/18" aria-hidden="true" />
		<div className="flex items-start justify-between gap-2">
			<div className="text-[12px] font-medium leading-5 text-vscode-foreground/84">{label}</div>
			<StandardTooltip content={tooltip} side="top" maxWidth={240}>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					className="h-5 w-5 shrink-0 rounded-full border border-vscode-panel-border/55 text-vscode-descriptionForeground/85 hover:border-vscode-focusBorder/55 hover:text-vscode-foreground focus-visible:ring-1 focus-visible:ring-vscode-focusBorder"
					aria-label={tooltipAriaLabel}>
					<Info aria-hidden="true" className="h-3.25 w-3.25" />
				</Button>
			</StandardTooltip>
		</div>
		<div
			className={`transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none ${animationClass}`}
			style={statValueStyle}>
			{hasData ? (
				<div
					className="mt-2 grid gap-3 min-[640px]:grid-cols-[minmax(0,1fr)_minmax(180px,220px)] min-[640px]:items-center"
					data-testid="ai-code-stats-token-summary">
					<div className="min-w-0">
						<div className="text-[11px] font-medium leading-4 text-vscode-descriptionForeground/90">
							{totalLabel}
						</div>
						<div
							className="mt-1 whitespace-nowrap text-[27px] font-medium leading-none tracking-[-0.015em] text-vscode-foreground"
							data-testid="ai-code-stats-total-tokens">
							{totalTokens}
						</div>
					</div>
					<div
						className="grid min-w-0 grid-cols-2 gap-x-6 gap-y-0.5 border-t border-vscode-panel-border/45 pt-2 min-[640px]:border-t-0 min-[640px]:border-l min-[640px]:pl-4 min-[640px]:pt-0"
						data-testid="ai-code-stats-token-metrics">
						<div className="min-w-0">
							<div className="text-[11px] leading-4 text-vscode-descriptionForeground/85">
								{inputLabel}
							</div>
							<div
								className="mt-1 whitespace-nowrap text-[18px] font-medium leading-none tracking-[-0.01em] text-vscode-foreground/95"
								data-testid="ai-code-stats-input-tokens">
								{inputTokens}
							</div>
						</div>
						<div className="min-w-0">
							<div className="text-[11px] leading-4 text-vscode-descriptionForeground/85">
								{outputLabel}
							</div>
							<div
								className="mt-1 whitespace-nowrap text-[18px] font-medium leading-none tracking-[-0.01em] text-vscode-foreground/95"
								data-testid="ai-code-stats-output-tokens">
								{outputTokens}
							</div>
						</div>
					</div>
				</div>
			) : (
				<div className="text-sm text-vscode-descriptionForeground" data-testid="ai-code-stats-token-empty">
					{emptyText}
				</div>
			)}
		</div>
	</div>
)

export const StatisticsSettings = ({
	aiCodeStatsWebhookUrl,
	aiCodeStatsUserName,
	setCachedStateField,
	webhookValidationError,
	...props
}: StatisticsSettingsProps) => {
	const { t } = useAppTranslation()
	const [summary, setSummary] = useState<AiCodeStatsSummaryResponse>(EMPTY_SUMMARY)
	const [statsRangeType, setStatsRangeType] = useState<AiCodeStatsRangeType>("current")
	const [statsCustomStartDate, setStatsCustomStartDate] = useState("")
	const [statsCustomEndDate, setStatsCustomEndDate] = useState("")
	const [isMetricsRefreshing, setIsMetricsRefreshing] = useState(false)
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
		requestSummary()
		const timer = window.setInterval(requestSummary, 30_000)

		return () => {
			window.clearInterval(timer)
		}
	}, [statsRangeType, statsCustomStartDate, statsCustomEndDate])

	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			const message = event.data
			if (message?.type !== "aiCodeStatsSummaryResponse") {
				return
			}

			setIsMetricsRefreshing(true)
			setSummary(normalizeSummary(message.values))
			window.requestAnimationFrame(() => {
				window.requestAnimationFrame(() => setIsMetricsRefreshing(false))
			})
		}

		window.addEventListener("message", handleMessage)
		return () => window.removeEventListener("message", handleMessage)
	}, [])

	const integerFormatter = useMemo(() => new Intl.NumberFormat("zh-CN"), [])
	const percentFormatter = useMemo(
		() =>
			new Intl.NumberFormat("zh-CN", {
				style: "percent",
				maximumFractionDigits: 1,
				minimumFractionDigits: 1,
			}),
		[],
	)

	const animationClass = isMetricsRefreshing ? "translate-y-0.5 opacity-70" : "translate-y-0 opacity-100"
	const hasGeneratedContext = summary.generatedLines > 0
	const hasAcceptedContext = summary.acceptedLines > 0
	const hasCommittedContext = summary.acceptedLines > 0 || summary.committedLines > 0
	const hasTokenContext = summary.totalTokens > 0 || summary.inputTokens > 0 || summary.outputTokens > 0

	const retentionRateText = percentFormatter.format(summary.retentionRate)
	const committedLinesText = integerFormatter.format(summary.committedLines)
	const adoptionRateText = percentFormatter.format(summary.adoptionRate)
	const acceptedLinesText = integerFormatter.format(Math.round(summary.acceptedLines))
	const generatedLinesText = integerFormatter.format(summary.generatedLines)
	const inputTokensText = integerFormatter.format(summary.inputTokens)
	const outputTokensText = integerFormatter.format(summary.outputTokens)
	const totalTokensText = integerFormatter.format(summary.totalTokens)

	return (
		<div {...props}>
			<SectionHeader>{t("settings:sections.statistics")}</SectionHeader>
			<Section>
				<div className="flex flex-col gap-6">
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
						<div
							className="text-sm leading-6 text-vscode-descriptionForeground"
							data-testid="ai-code-stats-user-name-description">
							{t("settings:statistics.userName.description")}
						</div>
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

					<SearchableSetting
						settingId="statistics-analysis-overview"
						section="statistics"
						label={t("settings:statistics.analysis.label")}
						className="flex flex-col gap-3">
						<label className="block font-medium" htmlFor="ai-code-stats-range-select">
							{t("settings:statistics.analysis.label")}
						</label>
						<VSCodeDropdown
							id="ai-code-stats-range-select"
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
								<div className="flex flex-col gap-2">
									<label
										className="text-xs font-medium text-vscode-descriptionForeground"
										htmlFor="ai-code-stats-custom-start">
										{t("settings:statistics.customDate.startLabel")}
									</label>
									<input
										id="ai-code-stats-custom-start"
										name="aiCodeStatsCustomStart"
										type="date"
										autoComplete="off"
										value={statsCustomStartDate}
										onChange={(event) => setStatsCustomStartDate(event.target.value)}
										className="w-full rounded-sm border border-vscode-input-border bg-vscode-input-background px-2 py-1 text-vscode-input-foreground transition-[border-color,box-shadow] duration-150 ease-out focus:outline-none focus:ring-1 focus:ring-vscode-focusBorder motion-reduce:transition-none"
										data-testid="ai-code-stats-custom-start"
									/>
								</div>
								<div className="flex flex-col gap-2">
									<label
										className="text-xs font-medium text-vscode-descriptionForeground"
										htmlFor="ai-code-stats-custom-end">
										{t("settings:statistics.customDate.endLabel")}
									</label>
									<input
										id="ai-code-stats-custom-end"
										name="aiCodeStatsCustomEnd"
										type="date"
										autoComplete="off"
										value={statsCustomEndDate}
										onChange={(event) => setStatsCustomEndDate(event.target.value)}
										className="w-full rounded-sm border border-vscode-input-border bg-vscode-input-background px-2 py-1 text-vscode-input-foreground transition-[border-color,box-shadow] duration-150 ease-out focus:outline-none focus:ring-1 focus:ring-vscode-focusBorder motion-reduce:transition-none"
										data-testid="ai-code-stats-custom-end"
									/>
								</div>
							</div>
						)}

						<div
							className="grid grid-cols-1 gap-2.5 min-[520px]:grid-cols-2"
							data-testid="ai-code-stats-kpi-grid">
							<MetricPanel
								label={t("settings:statistics.retentionRate.label")}
								tooltip={t("settings:statistics.retentionRate.tooltip")}
								emptyText={t("settings:statistics.retentionRate.empty")}
								tooltipAriaLabel={t("settings:statistics.retentionRate.ariaLabel")}
								value={retentionRateText}
								hasData={hasAcceptedContext}
								valueTestId="ai-code-stats-retention-rate"
								animationClass={animationClass}
							/>
							<MetricPanel
								label={t("settings:statistics.committedLines.label")}
								tooltip={t("settings:statistics.committedLines.tooltip")}
								emptyText={t("settings:statistics.committedLines.empty")}
								tooltipAriaLabel={t("settings:statistics.committedLines.ariaLabel")}
								value={committedLinesText}
								hasData={hasCommittedContext}
								valueTestId="ai-code-stats-committed-lines"
								animationClass={animationClass}
							/>
							<MetricPanel
								label={t("settings:statistics.adoptionRate.label")}
								tooltip={t("settings:statistics.adoptionRate.tooltip")}
								emptyText={t("settings:statistics.adoptionRate.empty")}
								tooltipAriaLabel={t("settings:statistics.adoptionRate.ariaLabel")}
								value={adoptionRateText}
								hasData={hasGeneratedContext}
								valueTestId="ai-code-stats-adoption-rate"
								animationClass={animationClass}
							/>
							<MetricPanel
								label={t("settings:statistics.acceptedLines.label")}
								tooltip={t("settings:statistics.acceptedLines.tooltip")}
								emptyText={t("settings:statistics.acceptedLines.empty")}
								tooltipAriaLabel={t("settings:statistics.acceptedLines.ariaLabel")}
								value={acceptedLinesText}
								hasData={hasGeneratedContext}
								valueTestId="ai-code-stats-accepted-lines"
								animationClass={animationClass}
							/>
							<MetricPanel
								label={t("settings:statistics.generatedLines.label")}
								tooltip={t("settings:statistics.generatedLines.tooltip")}
								emptyText={t("settings:statistics.generatedLines.empty")}
								tooltipAriaLabel={t("settings:statistics.generatedLines.ariaLabel")}
								value={generatedLinesText}
								hasData={hasGeneratedContext}
								valueTestId="ai-code-stats-generated-lines"
								animationClass={animationClass}
							/>
							<div className="min-[520px]:col-span-2">
								<TokenPanel
									label={t("settings:statistics.tokenUsage.label")}
									tooltip={t("settings:statistics.tokenUsage.tooltip")}
									emptyText={t("settings:statistics.tokenUsage.empty")}
									tooltipAriaLabel={t("settings:statistics.tokenUsage.ariaLabel")}
									inputLabel={t("settings:statistics.tokenUsage.input")}
									outputLabel={t("settings:statistics.tokenUsage.output")}
									totalLabel={t("settings:statistics.tokenUsage.total")}
									inputTokens={inputTokensText}
									outputTokens={outputTokensText}
									totalTokens={totalTokensText}
									hasData={hasTokenContext}
									animationClass={animationClass}
								/>
							</div>
						</div>
					</SearchableSetting>
				</div>
			</Section>
		</div>
	)
}
