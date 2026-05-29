// kilocode_change - new file

import { describe, expect, it } from "vitest"

import {
	buildUploadFailureDiagnostics,
	classifyUploadError,
	summarizeUploadTarget,
} from "../AiCodeStatsUploadDiagnostics"

describe("AiCodeStatsUploadDiagnostics", () => {
	it("classifies fetch failures as unreachable server diagnostics", () => {
		expect(
			buildUploadFailureDiagnostics("fetch failed", "http://localhost:8082/api/v1/ingest/ai-code-stats"),
		).toEqual({
			errorCategory: "server_unreachable",
			userMessage: "无法连接上报服务器，请检查后台服务是否启动、服务器地址是否正确，或网络是否可达。",
			targetProtocol: "http",
			targetHost: "localhost:8082",
			targetPath: "/api/v1/ingest/ai-code-stats",
		})
	})

	it("classifies common HTTP upload failures", () => {
		expect(classifyUploadError("AI code commit report upload failed (413 Payload Too Large)")).toBe(
			"payload_too_large",
		)
		expect(classifyUploadError("AI code commit report upload failed (429 Too Many Requests)")).toBe("rate_limited")
		expect(classifyUploadError("AI code commit report upload failed (500 Internal Server Error)")).toBe(
			"server_error",
		)
		expect(classifyUploadError("Request timed out after 600000ms")).toBe("timeout")
	})

	it("summarizes upload target without query or hash", () => {
		expect(summarizeUploadTarget("https://example.com/prod-api/api/v1/ingest/ai-code-stats?a=1#token")).toEqual({
			targetProtocol: "https",
			targetHost: "example.com",
			targetPath: "/prod-api/api/v1/ingest/ai-code-stats",
		})
	})
})
