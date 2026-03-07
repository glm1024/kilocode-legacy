group "default" {
  targets = ["ai-code-insights-api", "ai-code-insights-web"]
}

variable "TAG" {
  default = "latest"
}

variable "IMAGE_PREFIX" {
  default = "kilo"
}

target "common" {
  platforms = ["linux/amd64", "linux/arm64"]
}

target "ai-code-insights-api" {
  inherits = ["common"]
  context = "apps/ai-code-insights-api"
  dockerfile = "Dockerfile"
  tags = ["${IMAGE_PREFIX}/ai-code-insights-api:${TAG}"]
}

target "ai-code-insights-web" {
  inherits = ["common"]
  context = "apps/ai-code-insights-web"
  dockerfile = "Dockerfile"
  tags = ["${IMAGE_PREFIX}/ai-code-insights-web:${TAG}"]
}
