export interface OverviewResponse {
	cards: Array<{ label: string; value: number | string }>
	uploadHealth: string
	lastUploadAt: string | null
	totalLines: number
	activeSources: number
	activeProjects: number
}

export interface TrendPoint {
	bucket: string
	totalLines: number
	eventCount: number
}

export interface TrendsResponse {
	granularity: "day" | "week" | "month"
	points: TrendPoint[]
}

export interface RankingsResponse {
	dimension: "sourceIp" | "project" | "language"
	items: Array<{ key: string; label: string; totalLines: number; eventCount: number }>
}

export interface DistributionResponse {
	dimension: "language" | "ide" | "sourceType" | "hour" | "weekday"
	items: Array<{ key: string; label: string; value: number }>
}

export interface EventsResponse {
	page: number
	pageSize: number
	total: number
	items: Array<{
		eventId: string
		occurredAt: string
		sourceIp?: string
		userName?: string
		organizationId?: string
		organizationName?: string
		projectKey?: string
		workspaceName: string
		filePath: string
		relativePath: string
		language?: string
		ide: string
		sourceType: string
		lineCount: number
		taskId?: string
		codeSnippet: string
	}>
}

export interface AIProfile {
	provider: "openai-compatible" | "openrouter"
	name: string
	baseUrl: string
	apiKey: string
	model: string
	temperature: number
	maxTokens: number
	enabled: boolean
}

export interface AISettingsPayload {
	defaultProfile?: string | null
	profiles: AIProfile[]
}

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined) || ""

const buildQuery = (params: Record<string, string | number | undefined>) => {
	const search = new URLSearchParams()
	Object.entries(params).forEach(([key, value]) => {
		if (value !== undefined && value !== "") {
			search.set(key, String(value))
		}
	})
	return search.toString()
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
	const response = await fetch(`${API_BASE_URL}${path}`, {
		headers: {
			"Content-Type": "application/json",
			...(options?.headers || {}),
		},
		...options,
	})

	if (!response.ok) {
		throw new Error(`${response.status} ${response.statusText}`)
	}

	return response.json() as Promise<T>
}

export const insightsApi = {
	getOverview: (params: Record<string, string | number | undefined> = {}) =>
		request<OverviewResponse>(`/api/v1/dashboard/overview?${buildQuery(params)}`),
	getTrends: (granularity: string, params: Record<string, string | number | undefined> = {}) =>
		request<TrendsResponse>(`/api/v1/dashboard/trends?${buildQuery({ granularity, ...params })}`),
	getRankings: (dimension: string, params: Record<string, string | number | undefined> = {}) =>
		request<RankingsResponse>(`/api/v1/dashboard/rankings?${buildQuery({ dimension, ...params })}`),
	getDistribution: (dimension: string, params: Record<string, string | number | undefined> = {}) =>
		request<DistributionResponse>(`/api/v1/dashboard/distribution?${buildQuery({ dimension, ...params })}`),
	getEvents: (params: Record<string, string | number | undefined> = {}) =>
		request<EventsResponse>(`/api/v1/dashboard/events?${buildQuery(params)}`),
	getAISettings: () => request<AISettingsPayload>("/api/v1/settings/ai"),
	putAISettings: (payload: AISettingsPayload) =>
		request<AISettingsPayload>("/api/v1/settings/ai", { method: "PUT", body: JSON.stringify(payload) }),
	testAIConnection: (profile: AIProfile) =>
		request<{ success: boolean; message: string }>("/api/v1/settings/ai/test-connection", {
			method: "POST",
			body: JSON.stringify({ profile }),
		}),
	analyze: (payload: {
		filters: Record<string, string>
		question: string
		analysisMode: string
		widgets: string[]
	}) =>
		request<{ markdown: string; citations: string[] }>("/api/v1/ai/analyze", {
			method: "POST",
			body: JSON.stringify(payload),
		}),
}
