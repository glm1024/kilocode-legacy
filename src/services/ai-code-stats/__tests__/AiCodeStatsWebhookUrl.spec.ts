import { describe, expect, it } from "vitest"

import { resolveAiCodeStatsOrganizationOptionsUrl, resolveAiCodeStatsWebhookUrl } from "../AiCodeStatsWebhookUrl"

describe("AiCodeStatsWebhookUrl", () => {
	it("resolves organization options from a deployment base path", () => {
		expect(resolveAiCodeStatsOrganizationOptionsUrl("http://localhost:8081/prod-api")).toBe(
			"http://localhost:8081/prod-api/api/v1/ai-code-stats/organization-options",
		)
	})

	it("replaces an existing ingest path when resolving organization options", () => {
		expect(
			resolveAiCodeStatsOrganizationOptionsUrl(resolveAiCodeStatsWebhookUrl("http://localhost:8081/prod-api")),
		).toBe("http://localhost:8081/prod-api/api/v1/ai-code-stats/organization-options")
	})
})
