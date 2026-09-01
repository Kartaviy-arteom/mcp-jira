# MCP-метаданные для инструмента смены статуса

## Вывод

В установленном `mcp-framework` отдельного типа или режима `write`/`mutating tool` нет. Инструмент остаётся обычным наследником `MCPTool`, а характер операции объявляется необязательным свойством `annotations`.

Для инструмента смены статуса следует явно задать:

```ts
annotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
};
```

- `readOnlyHint: false`: инструмент изменяет состояние Jira.
- `destructiveHint: true`: изменяется существующее состояние задачи, операция не является только добавляющей.
- `idempotentHint: true`: согласно принятому контракту повторный вызов с теми же аргументами после успешной смены обнаружит уже достигнутый статус и вернёт `changed: false`, не выполняя ещё один transition. Это значение корректно только при сохранении такой проверки до записи.
- `openWorldHint: true`: инструмент взаимодействует с внешней Jira и её сущностями.

Спецификация не требует аннотаций именно для первого или любого другого write-tool: поле `Tool.annotations` необязательно. Однако явное объявление рекомендуется, потому что оно позволяет клиенту показать риск и принять решение о подтверждении. Эти значения остаются подсказками, а не механизмом авторизации или гарантией безопасности.

## Что поддерживает установленная версия

- Проект фиксирует `mcp-framework` 0.2.22 (`package-lock.json:2798-2801`) и фактически установил `@modelcontextprotocol/sdk` 1.30.0 (`package-lock.json:50-53`).
- `mcp-framework` 0.2.22 определяет `ToolAnnotations` с полями `title`, `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` (`node_modules/mcp-framework/dist/tools/BaseTool.d.ts:117-123`).
- Базовый класс имеет публичное свойство `annotations?: ToolAnnotations` (`node_modules/mcp-framework/dist/tools/BaseTool.d.ts:216-227`). Его `toolDefinition` включает непустые annotations (`node_modules/mcp-framework/dist/tools/BaseTool.js:564-573`), поэтому дополнительных регистраций или прямого использования MCP SDK не требуется.
- Сервер публикует `tool.toolDefinition` через общий `tools/list` и обрабатывает все инструменты одним `tools/call`, без отдельной ветки для записи (`node_modules/mcp-framework/dist/core/MCPServer.js:253-309`, `:342-355`).
- Пакет экспортирует базовый tool API через `dist/index.d.ts` (`node_modules/mcp-framework/dist/index.d.ts:4`). По публичному API и реализации отдельной абстракции для записывающих инструментов нет.
- Установленный официальный SDK подтверждает те же четыре флага, их optional-статус и значения по умолчанию (`node_modules/@modelcontextprotocol/sdk/dist/esm/spec.types.d.ts:1097-1146`).

## Семантика и обязательность

В MCP 2025-11-25 `annotations` перечислены как необязательная часть определения tool. Все свойства `ToolAnnotations` — подсказки; клиент не должен доверять им от недоверенного сервера. Значения по умолчанию консервативны: `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: false`, `openWorldHint: true`. Следовательно, отсутствие annotations не делает write-tool нарушающим протокол и по умолчанию не маскирует его как read-only, но теряется точная информация об идемпотентности.

Аннотации также не реализуют выбранную политику подтверждения: MCP не предписывает конкретную модель пользовательского интерфейса, хотя приложениям рекомендуется оставлять человека в контуре и показывать подтверждение операций. Поэтому решение оставить подтверждение на стороне потребителя согласуется со спецификацией.

Минимальная runtime-проверка с фиктивным наследником `MCPTool` подтвердила, что `toolDefinition` возвращает заданные annotations без дополнительной регистрации.

## Первичные источники

- [MCP 2025-11-25: Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) — optional `annotations`, недоверенный характер подсказок и рекомендации по подтверждению.
- [MCP 2025-11-25: Schema Reference — ToolAnnotations](https://modelcontextprotocol.io/specification/2025-11-25/schema#toolannotations) — определения флагов и их значения по умолчанию.
- [`mcp-framework` 0.2.22: `BaseTool.ts`](https://github.com/QuantGeekDev/mcp-framework/blob/mcp-framework-v0.2.22/src/tools/BaseTool.ts) — тип `ToolAnnotations`, свойство `MCPTool.annotations` и включение annotations в `toolDefinition`.
- Локально установленные артефакты перечислены выше; они являются точным источником возможностей версии, используемой проектом.
