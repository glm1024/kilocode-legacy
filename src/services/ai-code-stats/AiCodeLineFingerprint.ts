// kilocode_change - new file

import crypto from "crypto"

import { normalizeLineForFingerprint } from "./AiCodeLineFeatures"

export const hashLineFingerprint = (value: string): string =>
	crypto.createHash("sha1").update(normalizeLineForFingerprint(value), "utf8").digest("hex")
