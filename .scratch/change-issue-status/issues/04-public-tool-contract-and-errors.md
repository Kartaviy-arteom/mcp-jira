Type: grilling
Status: resolved
Blocked by: 01, 02

## Question

Как окончательно назвать инструмент и поля его схем, представить выполненный переход и список доступных статусов, а также какие отдельные контролируемые коды ошибок нужны для отсутствующего, неоднозначного и требующего дополнительных полей перехода?

## Answer

Публичное имя инструмента — `change-issue-status`. Описание для MCP-потребителя и описания полей пишутся на английском; описание инструмента: `Changes a Jira issue's status by executing one available workflow transition.`

Входная схема строгая:

```ts
{
  issueKey: issueKeySchema,
  targetStatus: z.string().trim().min(1)
}
```

Сопоставление `targetStatus` выполняется без учёта регистра после `trim()`. В ошибках используется введённое имя после `trim()`. В результате возвращается канонический `key` из ответа Jira, а не исходная строка пользователя.

Успешный результат имеет стабильную форму:

```ts
{
  issueKey: string,
  previousStatus: { id: string, name: string },
  newStatus: { id: string, name: string },
  transition: { id: string, name: string } | null,
  changed: boolean
}
```

При no-op `changed` равен `false`, `transition` равен `null`, а `previousStatus` и `newStatus` описывают один фактически прочитанный статус. После выполненного перехода `changed` равен `true`, а `transition` содержит id и имя выбранного перехода.

Добавить в `JIRA_ERROR_CODE` три контролируемых кода:

- `TRANSITION_NOT_AVAILABLE` — ни один доступный переход не ведёт в целевой статус;
- `TRANSITION_AMBIGUOUS` — в целевой статус ведут несколько доступных переходов;
- `TRANSITION_REQUIRES_FIELDS` — выбранный переход требует полей, которые status-only инструмент не принимает.

Публичная ошибка имеет только нормализованную оболочку `{ code, message, details? }`. `code` всегда берётся из `JIRA_ERROR_CODE`; числовой HTTP-статус, URL, сырой Jira error body и прочие транспортные или реализационные сведения потребителю не возвращаются. Они могут сохраняться только как внутренняя причина или диагностические данные. Ответы Jira на POST продолжают отображаться в существующие нормализованные коды (`BAD_REQUEST`, `ISSUE_NOT_FOUND`, `ACCESS_DENIED` и другие), без добавления сырого ответа в `details`.

Для локально сформированных ошибок `details` строго нормализуется по коду:

```ts
type Status = { id: string; name: string };

type Transition = {
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

- `TRANSITION_NOT_AVAILABLE`: `{ targetStatus, availableTransitions: Transition[] }`;
- `TRANSITION_AMBIGUOUS`: `{ targetStatus, candidates: Transition[] }`;
- `TRANSITION_REQUIRES_FIELDS`: `{ transition: Transition, requiredFields: RequiredField[] }`.

Списки содержат по элементу на каждый переход в порядке ответа Jira. Переходы с одинаковым целевым статусом не дедуплицируются, чтобы не скрывать неоднозначность. Любые дополнительные или неожиданные поля Jira отбрасываются нормализующей схемой и не становятся частью публичного контракта.
