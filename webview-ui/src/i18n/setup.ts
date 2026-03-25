import i18next from "i18next"
import { initReactI18next } from "react-i18next"

// Build translations object
const translations: Record<string, Record<string, any>> = {}

// kilocode_change start
const mergeTranslations = (base: Record<string, any>, override: Record<string, any>): Record<string, any> => {
	const merged = { ...base }

	Object.entries(override).forEach(([key, value]) => {
		const existing = merged[key]
		if (
			existing &&
			typeof existing === "object" &&
			!Array.isArray(existing) &&
			typeof value === "object" &&
			value !== null &&
			!Array.isArray(value)
		) {
			merged[key] = mergeTranslations(existing, value as Record<string, any>)
			return
		}

		merged[key] = value
	})

	return merged
}
// kilocode_change end

// Dynamically load locale files
const localeFiles = import.meta.glob("./locales/**/*.json", { eager: true })

// Process all locale files
Object.entries(localeFiles).forEach(([path, module]) => {
	// Extract language and namespace from path
	// Example path: './locales/en/common.json' -> language: 'en', namespace: 'common'
	// kilocode_change start
	const match = path.match(/\.\/locales\/([^/]+)\/([^./]+)(?:\.[^/]+)?\.json/)
	// kilocode_change end

	if (match) {
		const [, language, namespace] = match

		// Initialize language object if it doesn't exist
		if (!translations[language]) {
			translations[language] = {}
		}

		// Add namespace resources to language
		// kilocode_change start
		const resources = (module as any).default || module
		translations[language][namespace] = translations[language][namespace]
			? mergeTranslations(translations[language][namespace], resources)
			: resources
		// kilocode_change end
	}
})

console.log("Dynamically loaded translations:", Object.keys(translations))

// Initialize i18next for React
// This will be initialized with the VSCode language in TranslationProvider
i18next.use(initReactI18next).init({
	lng: "en", // Default language (will be overridden)
	fallbackLng: "en",
	debug: false,
	interpolation: {
		escapeValue: false, // React already escapes by default
	},
})

export function loadTranslations() {
	Object.entries(translations).forEach(([lang, namespaces]) => {
		try {
			Object.entries(namespaces).forEach(([namespace, resources]) => {
				i18next.addResourceBundle(lang, namespace, resources, true, true)
			})
		} catch (error) {
			console.warn(`Could not load ${lang} translations:`, error)
		}
	})
}

export default i18next
