// kilocode_change - new file

import os from "os"

export interface AiCodeStatsLocalIdentityRuntime {
	platform: NodeJS.Platform
	env: NodeJS.ProcessEnv
	userInfo: () => { username: string }
	networkInterfaces: () => ReturnType<typeof os.networkInterfaces>
}

const defaultRuntime: AiCodeStatsLocalIdentityRuntime = {
	platform: process.platform,
	env: process.env,
	userInfo: () => ({ username: os.userInfo().username }),
	networkInterfaces: () => os.networkInterfaces(),
}

const normalizeValue = (value?: string): string | undefined => {
	const trimmed = value?.trim()
	return trimmed ? trimmed : undefined
}

const normalizeIpAddress = (value?: string): string | undefined => {
	const trimmed = normalizeValue(value)
	if (!trimmed) {
		return undefined
	}

	return trimmed.includes("%") ? trimmed.split("%")[0] : trimmed
}

export class AiCodeStatsLocalIdentityResolver {
	private sourceIpCache?: string | null

	constructor(private readonly runtime: AiCodeStatsLocalIdentityRuntime = defaultRuntime) {}

	resolveUserName(configuredUserName?: string): string | undefined {
		const manualUserName = normalizeValue(configuredUserName)
		if (manualUserName) {
			return manualUserName
		}

		const envUserName =
			this.runtime.platform === "win32"
				? normalizeValue(this.runtime.env.USERNAME) || normalizeValue(this.runtime.env.USER)
				: normalizeValue(this.runtime.env.USER) ||
					normalizeValue(this.runtime.env.LOGNAME) ||
					normalizeValue(this.runtime.env.USERNAME)

		if (envUserName) {
			return envUserName
		}

		try {
			return normalizeValue(this.runtime.userInfo().username)
		} catch {
			return undefined
		}
	}

	resolveSourceIp(): string | undefined {
		if (this.sourceIpCache !== undefined) {
			return this.sourceIpCache || undefined
		}

		const interfaces = this.runtime.networkInterfaces()
		const externalIpv4: string[] = []
		const externalIpv6: string[] = []

		for (const addresses of Object.values(interfaces)) {
			for (const address of addresses ?? []) {
				if (address.internal) {
					continue
				}

				const normalized = normalizeIpAddress(address.address)
				if (!normalized) {
					continue
				}

				const family = String(address.family)
				if (family === "IPv4" || family === "4") {
					externalIpv4.push(normalized)
				} else if (family === "IPv6" || family === "6") {
					externalIpv6.push(normalized)
				}
			}
		}

		this.sourceIpCache = externalIpv4[0] || externalIpv6[0] || null
		return this.sourceIpCache || undefined
	}
}
