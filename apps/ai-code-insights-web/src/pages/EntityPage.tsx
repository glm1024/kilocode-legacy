import { useMemo } from "react"

import { DataTable } from "../components/DataTable"
import { MetricCard } from "../components/MetricCard"
import { DonutChart, HeatGrid, HorizontalBars, LineChart } from "../components/charts/SvgCharts"
import { useDistribution, useEventsWindow, useRankings, useTrends } from "../hooks/useDashboardData"
import { buildHourHeatItems, topContributionShare, toBarItems, toChartPoints } from "../lib/insights"

export const EntityPage = ({
	title,
	subtitle,
	dimension,
	filters,
}: {
	title: string
	subtitle: string
	dimension: "sourceIp" | "project" | "language"
	filters: Record<string, string>
}) => {
	const trends = useTrends("month", filters)
	const rankings = useRankings(dimension, filters)
	const ide = useDistribution("ide", filters)
	const events = useEventsWindow(filters, 80)

	const shares = useMemo(() => topContributionShare(rankings.data), [rankings.data])
	const recent = events.data?.items ?? []
	const avgLines = recent.length
		? Math.round(recent.reduce((sum, item) => sum + item.lineCount, 0) / recent.length)
		: 0

	return (
		<div className="page-shell">
			<section className="hero-panel">
				<div>
					<div className="hero-kicker">{dimension.toUpperCase()} DRILLDOWN</div>
					<h1>{title}</h1>
					<p>{subtitle}</p>
				</div>
			</section>

			<div className="panel-grid panel-grid-4">
				<MetricCard label="Top Share" value={`${shares[0]?.value ?? 0}%`} accent="#2bd4ff" />
				<MetricCard label="Tracked Entities" value={rankings.data?.items.length ?? 0} accent="#ff9f43" />
				<MetricCard label="Avg Lines / Event" value={avgLines} accent="#7af59f" />
				<MetricCard label="Recent Events" value={recent.length} accent="#ff6b81" />
			</div>

			<div className="panel-grid panel-grid-2">
				<section className="chart-card">
					<div className="chart-title">月度走势</div>
					<LineChart points={toChartPoints(trends.data)} color="#7af59f" />
				</section>
				<section className="chart-card">
					<div className="chart-title">贡献排行</div>
					<HorizontalBars items={toBarItems(rankings.data)} maxItems={10} />
				</section>
			</div>

			<div className="panel-grid panel-grid-2">
				<section className="chart-card">
					<div className="chart-title">IDE 分布</div>
					<DonutChart
						items={(ide.data?.items ?? []).map((item) => ({ label: item.label, value: item.value }))}
					/>
				</section>
				<section className="chart-card">
					<div className="chart-title">活跃时段</div>
					<HeatGrid items={buildHourHeatItems(events.data)} />
				</section>
			</div>

			<section className="chart-card">
				<div className="chart-title">最近事件</div>
				<DataTable
					rows={recent.slice(0, 20)}
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
						{ key: "relativePath", header: "文件" },
					]}
				/>
			</section>
		</div>
	)
}
