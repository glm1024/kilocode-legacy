import { useState } from "react"

import { insightsApi } from "../lib/api"

export const AICopilotDrawer = ({
	open,
	onClose,
	filters,
}: {
	open: boolean
	onClose: () => void
	filters: Record<string, string>
}) => {
	const [question, setQuestion] = useState("基于当前筛选结果，给我一份管理视角总结。")
	const [mode, setMode] = useState("summary")
	const [loading, setLoading] = useState(false)
	const [markdown, setMarkdown] = useState("")
	const analysisModes = [
		{ value: "summary", label: "总结" },
		{ value: "compare", label: "对比" },
		{ value: "anomaly", label: "异常" },
		{ value: "executive", label: "汇报" },
	] as const

	if (!open) {
		return null
	}

	const handleAnalyze = async () => {
		setLoading(true)
		try {
			const result = await insightsApi.analyze({
				filters,
				question,
				analysisMode: mode,
				widgets: ["overview", "trend", "source-ip-rank", "project-rank", "language-rank"],
			})
			setMarkdown(result.markdown)
		} finally {
			setLoading(false)
		}
	}

	return (
		<div className="drawer-scrim" onClick={onClose}>
			<aside className="drawer-panel" onClick={(event) => event.stopPropagation()}>
				<div className="drawer-head">
					<div>
						<div className="hero-kicker">AI COPILOT</div>
						<h2>AI 统计解读</h2>
					</div>
					<button className="ghost-button" onClick={onClose}>
						关闭
					</button>
				</div>
				<div className="drawer-segmented">
					{analysisModes.map(({ value, label }) => (
						<button
							key={value}
							className={`pill-button ${mode === value ? "pill-button-active" : ""}`}
							onClick={() => setMode(value)}>
							{label}
						</button>
					))}
				</div>
				<textarea
					className="control-textarea"
					rows={6}
					value={question}
					onChange={(e) => setQuestion(e.target.value)}
				/>
				<button className="primary-button" onClick={handleAnalyze} disabled={loading}>
					{loading ? "分析中..." : "AI 解读当前视图"}
				</button>
				<pre className="copilot-output">{markdown || "选择维度后，让 AI 解释趋势、异常与建议动作。"}</pre>
			</aside>
		</div>
	)
}
