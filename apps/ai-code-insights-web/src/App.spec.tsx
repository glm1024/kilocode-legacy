import { render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

import { App } from "./App"

vi.mock("./lib/api", () => ({
	insightsApi: {
		getOverview: vi.fn().mockResolvedValue({
			cards: [
				{ label: "AI code lines", value: 1200 },
				{ label: "Active source IPs", value: 8 },
				{ label: "Active projects", value: 3 },
				{ label: "Upload health", value: "healthy" },
			],
			uploadHealth: "healthy",
			lastUploadAt: null,
			totalLines: 1200,
			activeSources: 8,
			activeProjects: 3,
		}),
		getTrends: vi.fn().mockResolvedValue({ granularity: "day", points: [] }),
		getRankings: vi.fn().mockResolvedValue({ dimension: "sourceIp", items: [] }),
		getDistribution: vi.fn().mockResolvedValue({ dimension: "language", items: [] }),
		getEvents: vi.fn().mockResolvedValue({ page: 1, pageSize: 20, total: 0, items: [] }),
		getAISettings: vi.fn().mockResolvedValue({ defaultProfile: null, profiles: [] }),
		putAISettings: vi.fn().mockResolvedValue({ defaultProfile: null, profiles: [] }),
		testAIConnection: vi.fn().mockResolvedValue({ success: true, message: "ok" }),
		analyze: vi.fn().mockResolvedValue({ markdown: "analysis", citations: [] }),
	},
}))

describe("AI Code Insights App", () => {
	it("renders the command center shell", async () => {
		render(
			<QueryClientProvider client={new QueryClient()}>
				<App />
			</QueryClientProvider>,
		)

		expect(await screen.findByText("工程团队 AI 使用态势大屏")).toBeInTheDocument()
		expect(screen.getByText("AI 解读当前视图")).toBeInTheDocument()
	})
})
