Type: research
Status: resolved
Blocked by: None

## Question

Какие доступные в установленной версии `mcp-framework` механизмы и MCP-аннотации позволяют объявить инструмент записывающим или потенциально изменяющим состояние, и требуется ли это от спецификации первого write-tool?

## Answer

Отдельного write/mutating API в `mcp-framework` 0.2.22 нет: обычный наследник `MCPTool` должен явно задать `annotations`. Для смены статуса выбраны `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: true`, `openWorldHint: true`; идемпотентность зависит от обязательного no-op при уже достигнутом статусе. Аннотации необязательны по MCP и являются только подсказками клиенту, поэтому подтверждение остаётся на стороне потребителя.

Полное исследование и первичные источники: [MCP-метаданные для инструмента смены статуса](../research/mcp-mutation-metadata.md).
