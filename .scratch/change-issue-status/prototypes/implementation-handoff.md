# PROTOTYPE: implementation handoff для `change-issue-status`

## Вопрос прототипа

Достаточно ли этого документа, чтобы реализовать инструмент без новых продуктовых или архитектурных решений? Документ намеренно конкретен, но не является итоговой спецификацией: после проверки пользователем его решения должны перейти в `/to-spec`.

## Граница изменения

Реализовать один MCP-инструмент, который выполняет один доступный workflow transition Jira Server/Data Center 9.12.23 по ключу задачи и имени целевого статуса.

Изменение затрагивает:

- `src/jira/client.ts` — безопасный JSON POST без тела ответа и нормализованный публичный payload ошибок;
- `src/tools/changeIssueStatusTool.ts` — схемы Jira, выбор и выполнение перехода;
- `tests/jira-client.test.ts` — контракт POST и отсутствие транспортных данных в публичных ошибках;
- `tests/tools.test.ts` — публичный контракт и сценарии инструмента.

`src/index.ts` не менять: `mcp-framework` автоматически обнаруживает default-export инструментов в `src/tools`.

## Публичный MCP-контракт

```ts
const inputSchema = z
  .object({
    issueKey: issueKeySchema.describe("Jira issue key, for example OMSAGORA-3520."),
    targetStatus: z
      .string()
      .trim()
      .min(1)
      .describe("Target Jira workflow status name, for example In Progress."),
  })
  .strict();

const statusSchema = z.object({
  id: z.string(),
  name: z.string(),
});

const outputSchema = z.object({
  issueKey: z.string(),
  previousStatus: statusSchema,
  newStatus: statusSchema,
  transition: z.object({ id: z.string(), name: z.string() }).nullable(),
  changed: z.boolean(),
});
```

Инструмент:

```ts
class ChangeIssueStatusTool extends MCPTool {
  name = "change-issue-status";
  description = "Changes a Jira issue's status by executing one available workflow transition.";
  schema = inputSchema;
  protected outputSchemaShape = outputSchema;
  annotations = {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  };
}
```

Все `.describe(...)` публичных полей написать на английском. Результат перед возвратом пропустить через `outputSchema.parse(...)`.

## Входные схемы Jira

Схемы размещаются рядом с инструментом: вызывающий tool владеет endpoint, query и проверкой ответа Jira.

```ts
const jiraStatusSchema = z.object({
  id: z.string(),
  name: z.string(),
});

const jiraIssueStatusSchema = z.object({
  key: z.string(),
  fields: z.object({ status: jiraStatusSchema }),
});

const jiraFieldSchema = z.object({
  required: z.boolean(),
  name: z.string(),
  hasDefaultValue: z.boolean(),
  schema: z.object({
    type: z.string(),
    items: z.string().optional(),
    system: z.string().optional(),
    custom: z.string().optional(),
    customId: z.number().optional(),
  }),
});

const jiraTransitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  to: jiraStatusSchema,
  fields: z.record(jiraFieldSchema),
});

const jiraTransitionsSchema = z.object({
  transitions: z.array(jiraTransitionSchema),
});
```

Zod удаляет неизвестные поля. Любое отсутствие обязательной контрактной части становится `RESPONSE_FORMAT_ERROR`; сырой ответ в ошибку не попадает.

## Последовательность выполнения

1. Прочитать `GET rest/api/2/issue/{issueKey}?fields=status` с `jiraIssueStatusSchema` и `notFoundCode: ISSUE_NOT_FOUND`.
2. Сохранить возвращённый Jira `key` как канонический `issueKey`, а `fields.status` как `previousStatus`.
3. Сравнить `previousStatus.name` и `targetStatus` после `trim().toLowerCase()`.
4. При совпадении вернуть no-op: одинаковые `previousStatus` и `newStatus`, `transition: null`, `changed: false`. Больше запросов не выполнять.
5. Прочитать `GET rest/api/2/issue/{canonicalIssueKey}/transitions?expand=transitions.fields`.
6. В порядке ответа Jira выбрать переходы, чьи `to.name` совпадают с `targetStatus` по тому же правилу.
7. Ноль совпадений — `TRANSITION_NOT_AVAILABLE`; больше одного — `TRANSITION_AMBIGUOUS`.
8. Для единственного перехода собрать поля с `required === true`. Непустой список — `TRANSITION_REQUIRES_FIELDS`, даже если `hasDefaultValue === true`.
9. Выполнить `POST rest/api/2/issue/{canonicalIssueKey}/transitions` с `{ transition: { id } }` и `notFoundCode: ISSUE_NOT_FOUND`.
10. После доверенного `204` ровно один раз повторить GET задачи с `fields=status`.
11. Ошибку этого GET обернуть в `TRANSITION_VERIFICATION_FAILED` с нормализованным `causeCode`.
12. Если фактический status id не равен `transition.to.id`, вернуть `TRANSITION_STATUS_MISMATCH`.
13. Иначе вернуть канонический ключ из проверочного ответа, фактический `newStatus`, выбранный `{ id, name }` и `changed: true`.

`previousStatus` — наблюдение первого GET, а не атомарно подтверждённое состояние непосредственно перед POST. Автоматических retry, повторного выбора перехода и примиряющего GET после ошибки POST нет.

## Изменение Jira-клиента

Добавить узкий метод:

```ts
postJsonNoContent({ pathname, query?, body, notFoundCode? }): Promise<void>
```

Он использует существующие построение безопасного URL, Bearer-аутентификацию, timeout и `redirect: "error"`; отправляет `POST`, `Accept: application/json`, `Content-Type: application/json` и сериализованный JSON. Только `204` является успехом. Другой `2xx` становится `RESPONSE_FORMAT_ERROR`; ошибки сериализации — `BAD_REQUEST`.

Сохранить `httpStatus` как внутреннее свойство `JiraClientError`, но убрать его из строки `Error.message`, которую получает MCP-потребитель. Публичная строка ошибки всегда сериализует только:

```ts
{ code, message, details? }
```

Добавить необязательный аргумент нормализованных `details` без изменения существующих позиционных аргументов конструктора. Все call sites инструмента передают детали только после Zod-нормализации. URL, числовой HTTP-статус, `cause` и Jira response body в публичный payload не включать.

## Новые ошибки

| Код                              | Когда                                        | `details`                                                                |
| -------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------ |
| `TRANSITION_NOT_AVAILABLE`       | Нет совпавшего перехода                      | `{ targetStatus, availableTransitions }`                                 |
| `TRANSITION_AMBIGUOUS`           | Совпало больше одного перехода               | `{ targetStatus, candidates }`                                           |
| `TRANSITION_REQUIRES_FIELDS`     | Есть `required: true`                        | `{ transition, requiredFields }`                                         |
| `TRANSITION_VERIFICATION_FAILED` | Проверочный GET вернул контролируемую ошибку | `{ issueKey, previousStatus, expectedStatus, transition, causeCode }`    |
| `TRANSITION_STATUS_MISMATCH`     | Проверочный GET вернул иной status id        | `{ issueKey, previousStatus, expectedStatus, actualStatus, transition }` |

Формы деталей:

```ts
type PublicTransition = {
  id: string;
  name: string;
  targetStatus: Status;
};

type RequiredField = {
  id: string;
  name: string;
  hasDefaultValue: boolean;
  schema: {
    type: string;
    items?: string;
    system?: string;
    custom?: string;
    customId?: number;
  };
};
```

`availableTransitions` и `candidates` сохраняют порядок Jira и не дедуплицируются. Ответы POST без `204` используют существующие нормализованные коды. Timeout и сетевая ошибка означают, что результат мутации может быть неизвестен; дальнейшее действие выбирает потребитель.

## Проверяемые сценарии

### Jira-клиент

- POST использует безопасный относительный pathname, авторизацию, JSON-заголовки, timeout и запрет redirect.
- JSON сериализуется ровно один раз; ошибка сериализации не раскрывает body.
- Только `204` успешен; `200` и другие `2xx` дают `RESPONSE_FORMAT_ERROR`.
- HTTP-ошибки используют действующее отображение кодов и контекстный `ISSUE_NOT_FOUND`.
- Ни одна публичная ошибка, включая существующие GET/Binary сценарии, не содержит `httpStatus`, URL, cause или Jira body.

### Инструмент

- Невалидный `issueKey`, пустой `targetStatus` и лишние поля отклоняются до fetch.
- No-op выполняет один GET и возвращает `changed: false` с каноническим ключом.
- Happy path выполняет GET issue → GET transitions → POST → GET issue и возвращает `changed: true`.
- Сравнение имён выполняется после `trim()` без учёта регистра.
- Недоступный статус возвращает все доступные переходы в исходном порядке.
- Одинаковый целевой статус у двух переходов возвращает обоих кандидатов.
- Любое обязательное поле, включая имеющее default, блокирует POST.
- Ошибка POST пробрасывается без проверочного GET и retry.
- Ошибка проверочного GET становится `TRANSITION_VERIFICATION_FAILED` с `causeCode`.
- Успешная проверка с иным id становится `TRANSITION_STATUS_MISMATCH` с фактическим статусом.
- Совпавший id подтверждает успех; имя `newStatus` берётся из проверки, даже если оно изменилось.
- В ответах и ошибках отсутствуют неожиданные поля Jira и приватные данные fixtures.
- Определение MCP-инструмента содержит согласованные annotations и output schema.

## Завершение реализации

Работа готова, когда проходят:

```text
npm run lint
npm run fmt:check
npm run types
npm test
npm run build
```

## ADR

Принято отдельное [ADR о публичной нормализации ошибок Jira](../../../docs/adr/0001-normalize-public-jira-errors.md). Решение меняет общий контракт всех существующих инструментов, трудно откатывается после появления потребителей, неочевидно без контекста и выбирает безопасность вместо транспортной диагностичности. Сам workflow transition и узкий `postJsonNoContent` отдельного ADR не требуют: они локальны, ожидаемы и обратимы.
