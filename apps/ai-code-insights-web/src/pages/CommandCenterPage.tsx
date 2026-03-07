import { useMemo } from "react"

import { DataTable } from "../components/DataTable"
import { MetricCard } from "../components/MetricCard"
import { DonutChart, HeatGrid, HorizontalBars, LineChart } from "../components/charts/SvgCharts"
import { useDistribution, useEventsWindow, useOverview, useRankings, useTrends } from "../hooks/useDashboardData"
import { buildHourHeatItems, toBarItems, toChartPoints } from "../lib/insights"

export const CommandCenterPage = ({ filters }: { filters: Record<string, string> }) => {
	const overview = useOverview(filters)
	const trends = useTrends("day", filters)
	const sourceIps = useRankings("sourceIp", filters)
	const projects = useRankings("project", filters)
	const languages = useDistribution("language", filters)
	const ide = useDistribution("ide", filters)
	const events = useEventsWindow(filters, 40)

	const hourHeat = useMemo(() => buildHourHeatItems(events.data), [events.data])
	const alerts = useMemo(
		() =>
			(events.data?.items ?? [])
				.slice()
				.sort((left, right) => right.lineCount - left.lineCount)
				.slice(0, 6),
		[events.data],
	)

	return (
		<div className="page-shell">
			<section className="hero-panel">
				<div>
					<div className="hero-kicker">AI CODE COMMAND CENTER</div>
					<h1>工程团队 AI 使用态势大屏</h1>
					<p>覆盖用户、项目、语言、IDE、时间热度与异常事件，适合领导直接查看整体使用情况。</p>
				</div>
				<div
					className={`hero-status ${overview.data?.uploadHealth === "healthy" ? "hero-status-good" : "hero-status-warn"}`}>
					<span className="hero-status-dot" />
					<div>
						<strong>{overview.data?.uploadHealth === "healthy" ? "UPLINK HEALTHY" : "UPLINK STALE"}</strong>
						<span>
							{overview.data?.lastUploadAt
								? `上次上传 ${new Date(overview.data.lastUploadAt).toLocaleString()}`
								: "暂无上传记录"}
						</span>
					</div>
				</div>
			</section>

			<div className="panel-grid panel-grid-4">
				{overview.data?.cards.map((card, index) => (
					<MetricCard
						key={card.label}
						label={card.label}
						value={card.value}
						accent={index % 2 === 0 ? "#2bd4ff" : "#ff9f43"}
						helper={index === 0 ? "累计 AI 新增代码量" : undefined}
					/>
				))}
			</div>

			<div className="panel-grid panel-grid-main">
				<section className="chart-card chart-card-span-2">
					<div className="chart-title">30 天趋势</div>
					<LineChart points={toChartPoints(trends.data)} />
				</section>
				<section className="chart-card">
					<div className="chart-title">源 IP Top10</div>
					<HorizontalBars items={toBarItems(sourceIps.data)} maxItems={10} />
				</section>
				<section className="chart-card">
					<div className="chart-title">项目 Top10</div>
					<HorizontalBars items={toBarItems(projects.data)} maxItems={10} />
				</section>
			</div>

			<div className="panel-grid panel-grid-3">
				<section className="chart-card">
					<div className="chart-title">语言占比</div>
					<DonutChart
						items={(languages.data?.items ?? []).map((item) => ({ label: item.label, value: item.value }))}
					/>
				</section>
				<section className="chart-card">
					<div className="chart-title">IDE 占比</div>
					<DonutChart
						items={(ide.data?.items ?? []).map((item) => ({ label: item.label, value: item.value }))}
					/>
				</section>
				<section className="chart-card">
					<div className="chart-title">小时热力</div>
					<HeatGrid items={hourHeat} />
				</section>
			</div>

			<div className="panel-grid panel-grid-2">
				<section className="chart-card">
					<div className="chart-title">最近高强度事件</div>
					<DataTable
						rows={alerts}
						rowKey={(row) => row.eventId}
						columns={[
							{
								key: "occurredAt",
								header: "时间",
								render: (row) => new Date(row.occurredAt).toLocaleString(),
							},
							{ key: "sourceIp", header: "源 IP", render: (row) => row.sourceIp || "unknown" },
							{ key: "userName", header: "用户名", render: (row) => row.userName || "-" },
							{ key: "workspaceName", header: "项目" },
							{ key: "language", header: "语言", render: (row) => row.language || "unknown" },
							{ key: "lineCount", header: "行数" },
						]}
					/>
				</section>
				<section className="chart-card">
					<div className="chart-title">管理视角提示</div>
					<ul className="insight-list">
						<li>源 IP 排行适合识别高频使用终端与高活跃研发机器。</li>
						<li>项目排行适合观察哪些项目已经形成稳定 AI 协作习惯。</li>
						<li>小时热力能辅助判断 AI 使用是否集中在迭代冲刺时段。</li>
						<li>最近高强度事件可快速定位大批量 AI 生成代码的具体仓位。</li>
					</ul>
				</section>
			</div>
		</div>
	)
}
