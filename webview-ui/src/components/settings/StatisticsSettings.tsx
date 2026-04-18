import { HTMLAttributes } from "react"
import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"

import { useAppTranslation } from "@/i18n/TranslationContext"

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

export const StatisticsSettings = ({
	aiCodeStatsWebhookUrl,
	aiCodeStatsUserName,
	setCachedStateField,
	webhookValidationError,
	...props
}: StatisticsSettingsProps) => {
	const { t } = useAppTranslation()
	const controlWidthClass = "w-full"

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
				</div>
			</Section>
		</div>
	)
}
