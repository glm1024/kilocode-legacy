import { useEffect, useMemo, useState } from "react"

import { insightsApi, type AIProfile, type AISettingsPayload } from "../lib/api"

const defaultProfile: AIProfile = {
	provider: "openai-compatible",
	name: "internal-openai",
	baseUrl: "https://api.example.com/v1",
	apiKey: "",
	model: "gpt-4.1-mini",
	temperature: 0.2,
	maxTokens: 1200,
	enabled: true,
}

const emptySettings: AISettingsPayload = {
	defaultProfile: defaultProfile.name,
	profiles: [defaultProfile],
}

export const AISettingsPage = () => {
	const [settings, setSettings] = useState<AISettingsPayload>(emptySettings)
	const [selectedProfileName, setSelectedProfileName] = useState(defaultProfile.name)
	const [draft, setDraft] = useState<AIProfile>(defaultProfile)
	const [saving, setSaving] = useState(false)
	const [status, setStatus] = useState("")
	const [statusTone, setStatusTone] = useState<"neutral" | "success" | "error">("neutral")

	useEffect(() => {
		void insightsApi.getAISettings().then((payload) => {
			const next = payload.profiles.length ? payload : emptySettings
			setSettings(next)
			setSelectedProfileName(next.defaultProfile || next.profiles[0]?.name || defaultProfile.name)
		})
	}, [])

	useEffect(() => {
		const current =
			settings.profiles.find((profile) => profile.name === selectedProfileName) || settings.profiles[0]
		if (current) {
			setDraft(current)
		}
	}, [selectedProfileName, settings.profiles])

	const profileNames = useMemo(() => settings.profiles.map((profile) => profile.name), [settings.profiles])

	const updateDraft = <K extends keyof AIProfile>(key: K, value: AIProfile[K]) => {
		setDraft((current) => ({ ...current, [key]: value }))
	}

	const persist = async (nextSettings: AISettingsPayload) => {
		setSaving(true)
		try {
			const saved = await insightsApi.putAISettings(nextSettings)
			setSettings(saved)
			setStatus("设置已保存")
			setStatusTone("success")
		} catch (error) {
			setStatus(error instanceof Error ? error.message : "保存失败")
			setStatusTone("error")
		} finally {
			setSaving(false)
		}
	}

	const handleSave = async () => {
		const profiles = [...settings.profiles]
		const index = profiles.findIndex((profile) => profile.name === selectedProfileName)
		if (index >= 0) {
			profiles[index] = draft
		} else {
			profiles.push(draft)
		}
		setSelectedProfileName(draft.name)
		await persist({
			defaultProfile: settings.defaultProfile || draft.name,
			profiles,
		})
	}

	const handleAddProfile = () => {
		const name = `profile-${settings.profiles.length + 1}`
		const next = { ...defaultProfile, name }
		setDraft(next)
		setSelectedProfileName(name)
		setSettings((current) => ({
			...current,
			profiles: [...current.profiles, next],
		}))
	}

	const handleDeleteProfile = async () => {
		const profiles = settings.profiles.filter((profile) => profile.name !== selectedProfileName)
		const fallback = profiles[0] || defaultProfile
		setSelectedProfileName(fallback.name)
		await persist({
			defaultProfile: settings.defaultProfile === selectedProfileName ? fallback.name : settings.defaultProfile,
			profiles: profiles.length ? profiles : [fallback],
		})
	}

	const handleTest = async () => {
		try {
			const result = await insightsApi.testAIConnection(draft)
			setStatus(result.message)
			setStatusTone(result.success ? "success" : "error")
		} catch (error) {
			setStatus(error instanceof Error ? error.message : "测试失败")
			setStatusTone("error")
		}
	}

	return (
		<div className="page-shell">
			<section className="hero-panel">
				<div>
					<div className="hero-kicker">AI PROVIDER SETTINGS</div>
					<h1>统计分析 Copilot 设置</h1>
					<p>支持 OpenAI Compatible 与 OpenRouter，便于后续扩展管理摘要、异常解释和周报生成。</p>
				</div>
			</section>

			<div className="panel-grid panel-grid-settings">
				<section className="chart-card">
					<div className="chart-title">Provider Profiles</div>
					<div className="profile-list">
						{profileNames.map((name) => (
							<button
								key={name}
								className={`nav-button ${selectedProfileName === name ? "nav-button-active" : ""}`}
								onClick={() => setSelectedProfileName(name)}>
								<strong>{name}</strong>
								<span>{settings.defaultProfile === name ? "默认模型配置" : "可编辑配置"}</span>
							</button>
						))}
					</div>
					<div className="button-row">
						<button className="secondary-button" onClick={handleAddProfile}>
							新增 Profile
						</button>
						<button
							className="ghost-button"
							onClick={handleDeleteProfile}
							disabled={settings.profiles.length <= 1}>
							删除当前
						</button>
					</div>
				</section>

				<section className="chart-card">
					<div className="chart-title">Profile Detail</div>
					<div className="form-grid">
						<label className="field">
							<span>Provider</span>
							<select
								className="control-input"
								value={draft.provider}
								onChange={(e) => updateDraft("provider", e.target.value as AIProfile["provider"])}>
								<option value="openai-compatible">OpenAI Compatible</option>
								<option value="openrouter">OpenRouter</option>
							</select>
						</label>
						<label className="field">
							<span>Profile Name</span>
							<input
								className="control-input"
								value={draft.name}
								onChange={(e) => updateDraft("name", e.target.value)}
							/>
						</label>
						<label className="field field-span-2">
							<span>Base URL</span>
							<input
								className="control-input"
								value={draft.baseUrl}
								onChange={(e) => updateDraft("baseUrl", e.target.value)}
							/>
						</label>
						<label className="field field-span-2">
							<span>API Key</span>
							<input
								className="control-input"
								type="password"
								value={draft.apiKey}
								onChange={(e) => updateDraft("apiKey", e.target.value)}
							/>
						</label>
						<label className="field">
							<span>Model</span>
							<input
								className="control-input"
								value={draft.model}
								onChange={(e) => updateDraft("model", e.target.value)}
							/>
						</label>
						<label className="field">
							<span>Default Profile</span>
							<select
								className="control-input"
								value={settings.defaultProfile || ""}
								onChange={(e) =>
									setSettings((current) => ({ ...current, defaultProfile: e.target.value }))
								}>
								{profileNames.map((name) => (
									<option key={name} value={name}>
										{name}
									</option>
								))}
							</select>
						</label>
						<label className="field">
							<span>Temperature</span>
							<input
								className="control-input"
								type="number"
								step="0.1"
								min="0"
								max="2"
								value={draft.temperature}
								onChange={(e) => updateDraft("temperature", Number(e.target.value))}
							/>
						</label>
						<label className="field">
							<span>Max Tokens</span>
							<input
								className="control-input"
								type="number"
								min="128"
								max="8192"
								step="128"
								value={draft.maxTokens}
								onChange={(e) => updateDraft("maxTokens", Number(e.target.value))}
							/>
						</label>
						<label className="field field-checkbox">
							<input
								type="checkbox"
								checked={draft.enabled}
								onChange={(e) => updateDraft("enabled", e.target.checked)}
							/>
							<span>Enabled</span>
						</label>
					</div>
					<div className="button-row">
						<button className="primary-button" onClick={handleSave} disabled={saving}>
							{saving ? "保存中..." : "保存设置"}
						</button>
						<button className="secondary-button" onClick={handleTest}>
							测试连通性
						</button>
					</div>
					<div className={`status-banner status-${statusTone}`}>
						{status || "配置保存后，AI Copilot 将读取当前筛选结果并返回结构化分析。"}
					</div>
				</section>
			</div>
		</div>
	)
}
