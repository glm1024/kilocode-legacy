// kilocode_change - new file

import { describe, expect, it, vi } from "vitest"

import {
	AiCodeStatsLocalIdentityResolver,
	type AiCodeStatsLocalIdentityRuntime,
} from "../AiCodeStatsLocalIdentityResolver"

const createRuntime = (overrides: Partial<AiCodeStatsLocalIdentityRuntime> = {}): AiCodeStatsLocalIdentityRuntime => ({
	platform: "darwin",
	env: {},
	userInfo: vi.fn(() => ({ username: "system-user" }) as any),
	networkInterfaces: vi.fn(() => ({})),
	...overrides,
})

describe("AiCodeStatsLocalIdentityResolver", () => {
	it("prefers the manually configured user name", () => {
		const resolver = new AiCodeStatsLocalIdentityResolver(
			createRuntime({
				env: {
					USER: "local-user",
				},
			}),
		)

		expect(resolver.resolveUserName("  Team Lead  ")).toBe("Team Lead")
	})

	it("uses USERNAME on Windows when no manual user name is provided", () => {
		const resolver = new AiCodeStatsLocalIdentityResolver(
			createRuntime({
				platform: "win32",
				env: {
					USERNAME: "windows-user",
				},
			}),
		)

		expect(resolver.resolveUserName()).toBe("windows-user")
	})

	it("uses USER on macOS when no manual user name is provided", () => {
		const resolver = new AiCodeStatsLocalIdentityResolver(
			createRuntime({
				platform: "darwin",
				env: {
					USER: "mac-user",
				},
			}),
		)

		expect(resolver.resolveUserName()).toBe("mac-user")
	})

	it("returns the first external IPv4 address", () => {
		const resolver = new AiCodeStatsLocalIdentityResolver(
			createRuntime({
				networkInterfaces: vi.fn(
					() =>
						({
							lo0: [
								{
									address: "127.0.0.1",
									family: "IPv4",
									internal: true,
									netmask: "255.0.0.0",
									mac: "",
									cidr: null,
								},
							],
							en0: [
								{
									address: "192.168.0.24",
									family: "IPv4",
									internal: false,
									netmask: "255.255.255.0",
									mac: "",
									cidr: "192.168.0.24/24",
								},
							],
						}) as ReturnType<typeof import("os").networkInterfaces>,
				),
			}),
		)

		expect(resolver.resolveSourceIp()).toBe("192.168.0.24")
	})
})
