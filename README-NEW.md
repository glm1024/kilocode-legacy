# AI Code Stats 缓存路径

AI Code Stats 的缓存数据默认存放在扩展全局存储目录下的：

`ai-code-stats/v1/`

## macOS

VS Code 默认路径：

`~/Library/Application Support/Code/User/globalStorage/kilocode.kilo-code/ai-code-stats/v1/`

JetBrains 默认路径：

`~/.kilocode/globalStorage/kilocode.kilo-code/ai-code-stats/v1/`

## Windows

VS Code 默认路径：

`%APPDATA%\Code\User\globalStorage\kilocode.kilo-code\ai-code-stats\v1\`

JetBrains 默认路径：

`%USERPROFILE%\.kilocode\globalStorage\kilocode.kilo-code\ai-code-stats\v1\`

## 目录中的文件

通常可以看到以下文件：

- `state.json`
- `pending-lines.json`
- `events/YYYY-MM-DD.ndjson`

## 说明

- 如果你使用的是其他 VS Code 变体，需要把路径中的 `Code` 替换成对应的产品目录名。
- 如果配置了 `kilo-code.customStoragePath`，实际缓存根路径会跟随该配置，而不是默认的 VS Code 全局存储路径。
