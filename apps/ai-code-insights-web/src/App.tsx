import { useMemo, useState } from "react"

import { AICopilotDrawer } from "./components/AICopilotDrawer"
import { FilterBar, defaultFilters, type DashboardFiltersState } from "./components/FilterBar"
import { AnalyticsPage } from "./pages/AnalyticsPage"
import { AISettingsPage } from "./pages/AISettingsPage"
import { CommandCenterPage } from "./pages/CommandCenterPage"
import { EntityPage } from "./pages/EntityPage"

type ViewKey = "command-center" | "analytics" | "source-ips" | "projects" | "languages" | "ai-settings"

export const App = () => {
	const [view, setView] = useState<ViewKey>("command-center")
	const [filters, setFilters] = useState<DashboardFiltersState>(defaultFilters)
	const [copilotOpen, setCopilotOpen] = useState(false)

	const filterMap = Object.fromEntries(Object.entries(filters).filter(([, value]) => value))
	const activeFilterCount = useMemo(() => Object.values(filters).filter((value) => value.trim()).length, [filters])
	const navItems: Array<{ key: ViewKey; label: string; subtitle: string }> = [
		{ key: "command-center", label: "Command Center", subtitle: "首页大屏" },
		{ key: "analytics", label: "Analysis", subtitle: "多维分析" },
		{ key: "source-ips", label: "Source IPs", subtitle: "源 IP 钻取" },
		{ key: "projects", label: "Projects", subtitle: "项目钻取" },
		{ key: "languages", label: "Languages", subtitle: "语言钻取" },
		{ key: "ai-settings", label: "AI Settings", subtitle: "模型接入" },
	]

	return (
		<div className="root-layout">
			<aside className="side-shell">
				<div className="brand-block">
					<div className="brand-kicker">KILO LAB / OPS</div>
					<h2>AI Code Insights</h2>
					<p>面向管理层和项目负责人查看 AI 代码生产效能与使用态势。</p>
				</div>
				<nav className="nav-stack">
					{navItems.map((item) => (
						<button
							key={item.key}
							className={`nav-button ${view === item.key ? "nav-button-active" : ""}`}
							onClick={() => setView(item.key)}>
							<strong>{item.label}</strong>
							<span>{item.subtitle}</span>
						</button>
					))}
				</nav>
				<div className="side-foot">
					<div className="hero-kicker">ACTIVE FILTERS</div>
					<div className="side-foot-value">{activeFilterCount}</div>
				</div>
			</aside>
			<div className="main-shell">
				<header className="top-shell">
					<div className="toolbar-copy">
						<div className="hero-kicker">COMMAND INTERFACE</div>
						<h1>AI 工程使用态势</h1>
					</div>
					<FilterBar filters={filters} onChange={setFilters} />
					<button className="primary-button" onClick={() => setCopilotOpen(true)}>
						AI 解读当前视图
					</button>
				</header>
				<main className="content-shell">
					{view === "command-center" && <CommandCenterPage filters={filterMap} />}
					{view === "analytics" && <AnalyticsPage filters={filterMap} />}
					{view === "source-ips" && (
						<EntityPage
							title="Source IP Drilldown"
							subtitle="按源 IP 追踪贡献、趋势与活跃时段。"
							dimension="sourceIp"
							filters={filterMap}
						/>
					)}
					{view === "projects" && (
						<EntityPage
							title="Projects Drilldown"
							subtitle="按项目看 AI 行数、活跃度与近期事件。"
							dimension="project"
							filters={filterMap}
						/>
					)}
					{view === "languages" && (
						<EntityPage
							title="Languages Drilldown"
							subtitle="按语言看覆盖范围、项目分布与使用热度。"
							dimension="language"
							filters={filterMap}
						/>
					)}
					{view === "ai-settings" && <AISettingsPage />}
				</main>
			</div>
			<AICopilotDrawer open={copilotOpen} onClose={() => setCopilotOpen(false)} filters={filterMap} />
		</div>
	)
}
