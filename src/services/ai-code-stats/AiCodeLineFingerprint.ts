// kilocode_change - new file

import crypto from "crypto"

const normalizeLineForFingerprint = (value: string): string => value.replace(/\r?\n$/, "").trim()

export const hashLineFingerprint = (value: string): string =>
	crypto.createHash("sha1").update(normalizeLineForFingerprint(value), "utf8").digest("hex")
