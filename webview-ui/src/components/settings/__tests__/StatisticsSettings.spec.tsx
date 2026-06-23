import { act, fireEvent, render, screen } from "@/utils/test-utils"

const mockPostMessage = vi.hoisted(() => vi.fn())

vi.mock("@/utils/vscode", () => ({
	vscode: {
		postMessage: mockPostMessage,
	},
}))

import {
	STATISTICS_DEPARTMENT_OPTIONS,
	StatisticsSettings,
	getStatisticsIdentityValidationKey,
	getStatisticsTeamOptions,
} from "../StatisticsSettings"

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => {
			const translations: Record<string, string> = {
				"settings:sections.statistics": "Data Upload",
				"settings:statistics.webhook.label": "Upload Server URL",
				"settings:statistics.webhook.placeholder": "e.g. http://100.7.132.102:8081",
				"settings:statistics.department.label": "Department",
				"settings:statistics.department.placeholder": "Select department",
				"settings:statistics.office.label": "Office",
				"settings:statistics.office.placeholder": "Select office",
				"settings:statistics.team.label": "Team",
				"settings:statistics.team.placeholder": "Select team",
				"settings:statistics.userName.label": "Name",
				"settings:statistics.userName.placeholder": "e.g. Alice Zhang...",
				"settings:statistics.userEmail.label": "Company Email",
				"settings:statistics.userEmail.placeholder": "e.g. alice.zhang@example.com",
			}
			return translations[key] ?? key
		},
	}),
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeTextField: ({ value, onChange, placeholder, type, inputMode, "data-testid": dataTestId }: any) => (
		<input
			type={type ?? "text"}
			inputMode={inputMode}
			value={value}
			onChange={(e) => onChange({ target: { value: e.target.value } })}
			placeholder={placeholder}
			data-testid={dataTestId}
		/>
	),
}))

vi.mock("@src/components/ui", () => ({
	Select: ({ children, value, onValueChange, disabled, "data-testid": dataTestId }: any) => (
		<select
			value={value}
			onChange={(e) => onValueChange(e.target.value)}
			disabled={disabled}
			data-testid={dataTestId}>
			<option value="">placeholder</option>
			{children}
		</select>
	),
	SelectContent: ({ children }: any) => <>{children}</>,
	SelectGroup: ({ children }: any) => <>{children}</>,
	SelectItem: ({ children, value }: any) => <option value={value}>{children}</option>,
	SelectTrigger: ({ children }: any) => <>{children}</>,
	SelectValue: () => null,
}))

describe("StatisticsSettings", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("updates the webhook url", () => {
		const setCachedStateField = vi.fn()
		render(<StatisticsSettings aiCodeStatsWebhookUrl="" setCachedStateField={setCachedStateField} />)

		fireEvent.change(screen.getByTestId("ai-code-stats-webhook-url"), {
			target: { value: "https://hooks.example.com/ai" },
		})

		expect(setCachedStateField).toHaveBeenCalledWith("aiCodeStatsWebhookUrl", "https://hooks.example.com/ai")
	})

	it("renders and updates the name field", () => {
		const setCachedStateField = vi.fn()
		render(
			<StatisticsSettings
				aiCodeStatsWebhookUrl=""
				aiCodeStatsUserName="Alice"
				setCachedStateField={setCachedStateField}
			/>,
		)

		fireEvent.change(screen.getByTestId("ai-code-stats-user-name"), {
			target: { value: "Bob" },
		})

		expect(setCachedStateField).toHaveBeenCalledWith("aiCodeStatsUserName", "Bob")
		expect(screen.getByText("Name")).toBeInTheDocument()
		expect(screen.queryByText("Please enter your real name.")).not.toBeInTheDocument()
	})

	it("renders and updates the company email field", () => {
		const setCachedStateField = vi.fn()
		render(
			<StatisticsSettings
				aiCodeStatsWebhookUrl=""
				aiCodeStatsUserEmail="alice@example.com"
				setCachedStateField={setCachedStateField}
			/>,
		)

		const emailInput = screen.getByTestId("ai-code-stats-user-email")
		expect(emailInput).toHaveAttribute("type", "email")
		expect(emailInput).toHaveAttribute("inputmode", "email")

		fireEvent.change(emailInput, {
			target: { value: "Bob@Example.COM" },
		})

		expect(setCachedStateField).toHaveBeenCalledWith("aiCodeStatsUserEmail", "Bob@Example.COM")
		expect(screen.getByText("Company Email")).toBeInTheDocument()
	})

	it("renders department, office, team, name, company email, and webhook in order", () => {
		render(
			<StatisticsSettings
				aiCodeStatsWebhookUrl=""
				aiCodeStatsDepartmentName="云存储研发部"
				aiCodeStatsOfficeName="架设处"
				aiCodeStatsTeamName="研发一组"
				aiCodeStatsUserName=""
				setCachedStateField={vi.fn()}
			/>,
		)

		const departmentSelect = screen.getByTestId("ai-code-stats-department-name")
		const officeSelect = screen.getByTestId("ai-code-stats-office-name")
		const teamSelect = screen.getByTestId("ai-code-stats-team-name")
		const userNameInput = screen.getByTestId("ai-code-stats-user-name")
		const userEmailInput = screen.getByTestId("ai-code-stats-user-email")
		const webhookInput = screen.getByTestId("ai-code-stats-webhook-url")

		expect(departmentSelect.compareDocumentPosition(officeSelect) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
		expect(officeSelect.compareDocumentPosition(teamSelect) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
		expect(teamSelect.compareDocumentPosition(userNameInput) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
		expect(userNameInput.compareDocumentPosition(userEmailInput) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
		expect(userEmailInput.compareDocumentPosition(webhookInput) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
	})

	it("cascades organization select values and hides team when an office has no teams", () => {
		const setCachedStateField = vi.fn()
		const { rerender } = render(
			<StatisticsSettings
				aiCodeStatsWebhookUrl=""
				aiCodeStatsDepartmentName="云存储研发部"
				aiCodeStatsOfficeName="架设处"
				aiCodeStatsTeamName="研发一组"
				setCachedStateField={setCachedStateField}
			/>,
		)

		fireEvent.change(screen.getByTestId("ai-code-stats-department-name"), {
			target: { value: "云计算研发部" },
		})
		expect(setCachedStateField).toHaveBeenCalledWith("aiCodeStatsDepartmentName", "云计算研发部")
		expect(setCachedStateField).toHaveBeenCalledWith("aiCodeStatsOfficeName", "")
		expect(setCachedStateField).toHaveBeenCalledWith("aiCodeStatsTeamName", "")

		fireEvent.change(screen.getByTestId("ai-code-stats-office-name"), {
			target: { value: "经理室" },
		})
		expect(setCachedStateField).toHaveBeenCalledWith("aiCodeStatsOfficeName", "经理室")
		expect(setCachedStateField).toHaveBeenCalledWith("aiCodeStatsTeamName", "")

		rerender(
			<StatisticsSettings
				aiCodeStatsWebhookUrl=""
				aiCodeStatsDepartmentName="云计算研发部"
				aiCodeStatsOfficeName="经理室"
				setCachedStateField={setCachedStateField}
			/>,
		)
		expect(screen.queryByTestId("ai-code-stats-team-name")).not.toBeInTheDocument()
	})

	it("uses the configured upload departments and team options", () => {
		expect(STATISTICS_DEPARTMENT_OPTIONS.map((department) => department.name)).toEqual([
			"云计算研发部",
			"云存储研发部",
		])
		expect(getStatisticsTeamOptions("云计算研发部", "研发四处")).toEqual([
			"经理室",
			"研发一组",
			"研发二组",
			"研发三组",
			"研发四组",
			"研发五组",
			"研发六组",
		])
		expect(getStatisticsTeamOptions("云计算研发部", "研发五处")).toEqual([
			"经理室",
			"研发一组",
			"研发二组",
			"研发三组",
			"研发四组",
		])

		const cloudStorageTeams = [
			"研发一组",
			"研发二组",
			"研发三组",
			"研发四组",
			"研发五组",
			"研发六组",
			"研发七组",
			"研发八组",
		]
		const cloudStorageDepartment = STATISTICS_DEPARTMENT_OPTIONS.find(
			(department) => department.name === "云存储研发部",
		)
		const cloudStorageOfficesWithTeams = cloudStorageDepartment?.offices.filter((office) => office.teams.length > 0)

		expect(cloudStorageOfficesWithTeams?.map((office) => office.name)).toEqual([
			"架设处",
			"核心软件处",
			"研发保障处",
			"管理软件处",
			"硬件开发处",
			"测试验证处",
			"项目管理处",
		])
		for (const office of cloudStorageOfficesWithTeams ?? []) {
			expect(office.teams).toEqual(cloudStorageTeams)
		}
	})

	it("renders remote organization options when provided", () => {
		render(
			<StatisticsSettings
				aiCodeStatsWebhookUrl=""
				statisticsDepartmentOptions={[
					{
						name: "研发中心",
						offices: [
							{
								name: "平台部",
								teams: ["后端组"],
							},
						],
					},
				]}
				setCachedStateField={vi.fn()}
			/>,
		)

		expect(screen.getByTestId("ai-code-stats-department-name")).toHaveTextContent("研发中心")
		expect(screen.queryByText("云计算研发部")).not.toBeInTheDocument()
	})

	it("shows inline webhook validation error from save flow", () => {
		render(
			<StatisticsSettings
				aiCodeStatsWebhookUrl="https://hooks.example.com/ai"
				setCachedStateField={vi.fn()}
				webhookValidationError="Webhook test failed"
			/>,
		)

		expect(screen.getByTestId("ai-code-stats-webhook-error")).toHaveTextContent("Webhook test failed")
	})

	it("renders identity validation error below the field that failed validation", () => {
		render(
			<StatisticsSettings
				aiCodeStatsWebhookUrl=""
				aiCodeStatsDepartmentName="云存储研发部"
				identityValidationError="Please select an office."
				identityValidationErrorField="office"
				setCachedStateField={vi.fn()}
			/>,
		)

		const officeSelect = screen.getByTestId("ai-code-stats-office-name")
		const userNameInput = screen.getByTestId("ai-code-stats-user-name")
		const error = screen.getByTestId("ai-code-stats-identity-error")

		expect(error).toHaveTextContent("Please select an office.")
		expect(error).toHaveAttribute("data-validation-field", "office")
		expect(officeSelect.compareDocumentPosition(error) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
		expect(error.compareDocumentPosition(userNameInput) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
	})

	it("validates required identity fields and requires team only when the office has teams", () => {
		expect(getStatisticsIdentityValidationKey({})).toBe("settings:statistics.validation.departmentRequired")
		expect(getStatisticsIdentityValidationKey({ departmentName: "不存在部门" })).toBe(
			"settings:statistics.validation.departmentInvalid",
		)
		expect(getStatisticsIdentityValidationKey({ departmentName: "云存储研发部" })).toBe(
			"settings:statistics.validation.officeRequired",
		)
		expect(
			getStatisticsIdentityValidationKey({
				departmentName: "云存储研发部",
				officeName: "不存在处",
			}),
		).toBe("settings:statistics.validation.officeInvalid")
		expect(
			getStatisticsIdentityValidationKey({
				departmentName: "云存储研发部",
				officeName: "架设处",
				teamName: "不存在组",
			}),
		).toBe("settings:statistics.validation.teamInvalid")
		expect(
			getStatisticsIdentityValidationKey({
				departmentName: "云存储研发部",
				officeName: "架设处",
				userName: "Alice",
				userEmail: "alice@example.com",
			}),
		).toBe("settings:statistics.validation.teamRequired")
		expect(
			getStatisticsIdentityValidationKey({
				departmentName: "云存储研发部",
				officeName: "经理室",
				userName: "Alice",
			}),
		).toBe("settings:statistics.validation.emailRequired")
		expect(
			getStatisticsIdentityValidationKey({
				departmentName: "云存储研发部",
				officeName: "经理室",
				userName: "Alice",
				userEmail: "not-an-email",
			}),
		).toBe("settings:statistics.validation.emailInvalid")
		expect(
			getStatisticsIdentityValidationKey({
				departmentName: "云存储研发部",
				officeName: "经理室",
				userName: "Alice",
				userEmail: "Alice@Example.COM",
			}),
		).toBeUndefined()
	})

	it("does not render local analysis metrics", () => {
		render(<StatisticsSettings aiCodeStatsWebhookUrl="" setCachedStateField={vi.fn()} />)

		expect(screen.queryByTestId("ai-code-stats-range-select")).not.toBeInTheDocument()
		expect(screen.queryByTestId("ai-code-stats-kpi-grid")).not.toBeInTheDocument()
		expect(screen.queryByTestId("ai-code-stats-token-panel")).not.toBeInTheDocument()
	})

	it("does not render commit upload status cards for normal records", () => {
		render(<StatisticsSettings aiCodeStatsWebhookUrl="" setCachedStateField={vi.fn()} />)

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "aiCodeStatsCommitUploadRecords",
						values: {
							records: [
								{
									id: "normal",
									commitHash: "abcdef123456",
									repoRoot: "/repo",
									commitOccurredAt: Date.now(),
									status: "uploaded",
								},
							],
						},
					},
				}),
			)
		})

		expect(screen.queryByTestId("commit-upload-status-region")).not.toBeInTheDocument()
	})

	it("renders unfinished commit upload card without horizontal table layout", () => {
		render(<StatisticsSettings aiCodeStatsWebhookUrl="" setCachedStateField={vi.fn()} />)

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "aiCodeStatsCommitUploadRecords",
						values: {
							records: [
								{
									id: "record-reanalysis",
									commitHash: "c52d64d58b23513fc042d70b8d184dacaa30080d",
									repoRoot: "/workspace/ism",
									repoName: "ism",
									commitOccurredAt: new Date("2026-05-27T11:27:22+08:00").getTime(),
									status: "needs_reanalysis",
									addedLineCount: 7167,
									lastError: "可能由外部 Git 客户端提交或路径匹配失败导致",
								},
							],
						},
					},
				}),
			)
		})

		const card = screen.getByTestId("commit-upload-status-card")
		expect(card).toHaveTextContent("提交上报未完成")
		expect(card).toHaveTextContent("c52d64d")
		expect(card).toHaveTextContent("ism")
		expect(card).toHaveTextContent("+7167 行")
		expect(card.querySelector("table")).toBeNull()

		fireEvent.click(screen.getByTestId("commit-upload-reanalyze-button"))
		expect(mockPostMessage).toHaveBeenCalledWith({
			type: "reanalyzeAiCodeStatsCommitUpload",
			text: "record-reanalysis",
		})
		expect(screen.getByTestId("commit-upload-reanalyze-button")).toHaveTextContent("处理中...")
	})

	it("renders failed commit upload reason and retry action", () => {
		render(<StatisticsSettings aiCodeStatsWebhookUrl="" setCachedStateField={vi.fn()} />)

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "aiCodeStatsCommitUploadRecords",
						values: {
							records: [
								{
									id: "record-failed",
									commitHash: "abcdef123456",
									repoRoot: "/workspace/repo",
									repoName: "repo",
									commitOccurredAt: Date.now(),
									status: "upload_failed",
									lastError: "连接服务器超时",
								},
							],
						},
					},
				}),
			)
		})

		expect(screen.getByTestId("commit-upload-status-card")).toHaveTextContent("提交上报失败")
		expect(screen.getByTestId("commit-upload-status-reason")).toHaveTextContent("连接服务器超时")

		fireEvent.click(screen.getByTestId("commit-upload-retry-button"))
		expect(mockPostMessage).toHaveBeenCalledWith({
			type: "retryAiCodeStatsCommitUpload",
			text: "record-failed",
		})
	})

	it("explains fetch failed as an unreachable upload server", () => {
		render(<StatisticsSettings aiCodeStatsWebhookUrl="" setCachedStateField={vi.fn()} />)

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "aiCodeStatsCommitUploadRecords",
						values: {
							records: [
								{
									id: "record-fetch-failed",
									commitHash: "86f815863e1d915dad88313f378cc0309365e837",
									repoRoot: "/workspace/babel",
									repoName: "babel",
									status: "upload_failed",
									lastError: "fetch failed",
								},
							],
						},
					},
				}),
			)
		})

		expect(screen.getByTestId("commit-upload-status-reason")).toHaveTextContent(
			"无法连接上报服务器，请检查后台服务是否启动、服务器地址是否正确，或网络是否可达。",
		)
	})
})
