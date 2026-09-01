Status: ready-for-agent

# Безопасная смена статуса задачи Jira

## Problem Statement

MCP-потребитель умеет читать задачи Jira, но не может безопасно перевести задачу в целевой статус. Прямая запись поля `status` противоречит модели Jira: смена статуса должна выполнять один доступный текущему пользователю workflow transition. Потребителю нужен предсказуемый изменяющий инструмент, который не выбирает переход произвольно, не скрывает неоднозначность, не требует знания Jira REST и подтверждает фактический результат записи.

Существующий контракт ошибок дополнительно раскрывает числовой HTTP-статус внутри публичного MCP-ответа. Это нарушает принятую границу интеграции: потребитель должен видеть только нормализованные доменные коды и не знать транспорт или протокол общения сервера с Jira.

## Solution

Добавить MCP-инструмент `change-issue-status`, принимающий ключ задачи и имя целевого статуса. Инструмент читает текущий статус, завершает вызов без записи, если цель уже достигнута, иначе получает доступные переходы, выбирает единственный переход в целевой статус, отклоняет переходы с обязательными полями, выполняет минимальный POST и отдельным чтением проверяет фактический статус.

Успешный ответ сообщает канонический ключ задачи, исходный и новый статусы, выполненный переход и признак `changed`. Все ответы Jira валидируются через Zod. Ошибки публикуются только как `{ code, message, details? }`; HTTP-статусы, URL, сырые ответы и внутренние причины остаются внутри сервера.

## User Stories

1. As an MCP consumer, I want to change a Jira issue status by issue key and target status name, so that I do not need to know Jira transition identifiers.
2. As an MCP consumer, I want status changes to use Jira workflow transitions, so that workflow permissions and validators remain authoritative.
3. As an MCP consumer, I want the target status to ignore surrounding whitespace, so that harmless formatting does not prevent a match.
4. As an MCP consumer, I want target-status matching to be case-insensitive, so that capitalization differences do not prevent a match.
5. As an MCP consumer, I want the canonical issue key returned by Jira, so that later operations use the current visible key.
6. As an MCP consumer, I want an already-reached target status to return success without a write, so that repeated requests are harmless when the state has not changed again.
7. As an MCP consumer, I want a no-op result to state `changed: false`, so that I can distinguish observation from mutation.
8. As an MCP consumer, I want a no-op result to contain `transition: null`, so that the absence of a performed transition is explicit.
9. As an MCP consumer, I want a successful mutation to identify the performed transition, so that the result is auditable in domain terms.
10. As an MCP consumer, I want only one-step available transitions considered, so that the tool never invents a multi-step workflow route.
11. As an MCP consumer, I want an unavailable target status reported with the available transitions, so that I can choose a reachable status.
12. As an MCP consumer, I want every available transition preserved in Jira order, so that no candidate is silently hidden or reordered.
13. As an MCP consumer, I want transitions with the same target status reported as ambiguous, so that the server never chooses one arbitrarily.
14. As an MCP consumer, I want required transition fields reported before mutation, so that an unsupported transition screen cannot cause a partial request.
15. As an MCP consumer, I want required fields reported even when Jira says they have defaults, so that the status-only contract remains conservative.
16. As an MCP consumer, I want required-field metadata normalized, so that I receive useful field information without raw Jira data.
17. As an MCP consumer, I want a successful write verified by a separate read, so that an empty Jira response is not mistaken for a proven final state.
18. As an MCP consumer, I want verification to compare status identifiers, so that status renaming does not create a false failure.
19. As an MCP consumer, I want the verified Jira status name returned, so that the response reflects the observed current name.
20. As an MCP consumer, I want a failed verification read distinguished from an observed status mismatch, so that I can react differently to unknown and known outcomes.
21. As an MCP consumer, I want automatic retries disabled after a mutation attempt, so that the server cannot perform an unconfirmed second write.
22. As an MCP consumer, I want retry and reconciliation decisions left to me, so that a human or calling agent can confirm the next mutation.
23. As an MCP consumer, I want normalized error codes, so that behavior does not depend on Jira HTTP status numbers.
24. As an MCP consumer, I want error details validated per error code, so that unexpected Jira fields cannot enter the public contract.
25. As an MCP consumer, I want Jira HTTP statuses, URLs, response bodies and internal causes hidden, so that the integration transport remains private.
26. As an MCP consumer, I want invalid input rejected before Jira is called, so that malformed requests cannot reach the external system.
27. As an MCP client, I want the tool marked as mutating, destructive, idempotent and open-world, so that I can present appropriate confirmation and policy controls.
28. As an operator, I want Jira authentication, authorization, not-found, timeout and availability failures mapped to stable codes, so that callers receive safe actionable categories.
29. As a maintainer, I want all Jira responses validated before use, so that upstream contract drift becomes a controlled response-format error.
30. As a maintainer, I want JSON POST behavior centralized in the Jira client, so that URL, authentication, timeout, redirect and serialization guarantees remain local.
31. As a maintainer, I want the transition selection logic owned by the MCP tool, so that Jira-specific domain behavior does not leak into the transport module.
32. As a maintainer, I want the feature verified through existing public seams, so that tests remain stable across internal refactoring.

## Implementation Decisions

1. The public tool name is `change-issue-status`. Its English description is: `Changes a Jira issue's status by executing one available workflow transition.` Public field descriptions are also English.

2. The strict input contract is `{ issueKey, targetStatus }`. `issueKey` uses the existing issue-key normalization and validation. `targetStatus` is a trimmed, non-empty string. Unknown input fields are rejected.

3. The prototype established this public result shape, which remains fixed for both changed and no-op success:

   ```ts
   type ChangeIssueStatusResult = {
     issueKey: string;
     previousStatus: { id: string; name: string };
     newStatus: { id: string; name: string };
     transition: { id: string; name: string } | null;
     changed: boolean;
   };
   ```

4. `issueKey` in the result is the canonical key returned by the first Jira issue read, not the original input. `previousStatus` is the status observed by that read; Jira provides no atomic guarantee that it remains the immediate pre-POST status.

5. Status-name matching removes surrounding whitespace and ignores case. The normalized input name is retained in error details. Transition results and verification use Jira's returned identifiers and names.

6. The first Jira operation reads only the issue key and status through REST API v2. A not-found response uses the contextual `ISSUE_NOT_FOUND` code.

7. If the first observed status name matches the target, that read also verifies the no-op. The tool returns `changed: false`, equal previous and new statuses, and `transition: null`. It does not read transitions, write, or read the issue again.

8. Otherwise the tool requests the issue's transitions with `expand=transitions.fields`. Only transitions available to the current user for the current workflow state are considered.

9. Matching uses each transition's target status name. Zero matches produce `TRANSITION_NOT_AVAILABLE`; multiple matches produce `TRANSITION_AMBIGUOUS`; exactly one match advances to field validation. Jira response order is preserved and duplicate target statuses are not deduplicated.

10. A selected transition is rejected when any transition field has `required: true`, including fields with `hasDefaultValue: true`. The tool accepts no comment, resolution, assignee or other transition field.

11. Jira issue, status, transition and transition-field responses are validated with Zod before use. Unknown Jira properties are stripped. Missing or incompatible required properties produce `RESPONSE_FORMAT_ERROR` without exposing the response.

12. Required-field details expose only the field id, name, `hasDefaultValue`, and normalized schema properties `type`, optional `items`, `system`, `custom`, and numeric `customId`.

13. The Jira client gains the narrow interface `postJsonNoContent({ pathname, query?, body, notFoundCode? }): Promise<void>`. It accepts a JSON-compatible body and owns JSON serialization.

14. The write interface reuses the client's safe relative-URL construction, Bearer authentication, timeout, redirect rejection and HTTP error classification. It sends POST with JSON content and accept headers. Serialization failure becomes `BAD_REQUEST` without exposing the body.

15. Only `204 No Content` is accepted as successful POST completion. Any other successful HTTP status becomes `RESPONSE_FORMAT_ERROR`. Jira-specific endpoints, transition identifiers and selection rules remain outside the transport module.

16. After a trusted `204`, the tool performs exactly one issue-status read. It performs no automatic retry, transition reselection, repeated POST, or reconciliation read after a failed POST.

17. Mutation success requires both the trusted `204` and a verification response whose status id equals the selected transition's target status id. `newStatus` uses the verified response. A renamed status with the expected id is successful.

18. `changed: true` reports these two observations. It does not assert exclusive causality, absence of concurrent transitions, or persistence of the status after the response.

19. A failed verification read produces `TRANSITION_VERIFICATION_FAILED`. Its normalized details are `{ issueKey, previousStatus, expectedStatus, transition, causeCode }`, where `causeCode` is another controlled Jira error code.

20. A successful verification read with another status id produces `TRANSITION_STATUS_MISMATCH`. Its normalized details are `{ issueKey, previousStatus, expectedStatus, actualStatus, transition }`. This applies whether the actual status equals the initial status or reflects a later concurrent transition.

21. A failed POST returns its existing normalized Jira error and triggers no further request. For timeout or network failure, the mutation outcome may be unknown; the consumer decides whether to inspect or invoke the tool again.

22. Five controlled codes are added with stable English messages:

    | Code                             | Message                                                                 |
    | -------------------------------- | ----------------------------------------------------------------------- |
    | `TRANSITION_NOT_AVAILABLE`       | `No available Jira transition reaches the requested status.`            |
    | `TRANSITION_AMBIGUOUS`           | `More than one available Jira transition reaches the requested status.` |
    | `TRANSITION_REQUIRES_FIELDS`     | `The Jira transition requires fields that this tool does not support.`  |
    | `TRANSITION_VERIFICATION_FAILED` | `The Jira status transition result could not be verified.`              |
    | `TRANSITION_STATUS_MISMATCH`     | `The Jira issue is in an unexpected status after the transition.`       |

23. Selection-error details use the prototype-established shapes:

    ```ts
    type PublicTransition = {
      id: string;
      name: string;
      targetStatus: { id: string; name: string };
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

    `TRANSITION_NOT_AVAILABLE` uses `{ targetStatus, availableTransitions }`; `TRANSITION_AMBIGUOUS` uses `{ targetStatus, candidates }`; `TRANSITION_REQUIRES_FIELDS` uses `{ transition, requiredFields }`.

24. The public error payload is always `{ code, message, details? }`, serialized by the framework into MCP text content with `isError: true`. Numeric HTTP status, URL, raw Jira body, stack and internal cause are never serialized for the consumer.

25. The Jira error may retain HTTP status and cause internally for diagnostics. Existing public errors also stop serializing HTTP status, so the ADR applies consistently to every tool.

26. Error `details` are optional and exist only for codes with an explicitly normalized schema. Arbitrary error data is not accepted into the public payload.

27. The tool declares `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: true`, and `openWorldHint: true`. These are client hints, not server-side confirmation. Mutation confirmation remains the MCP consumer's responsibility.

28. The new tool follows the existing default-export tool convention and is discovered automatically; no manual server registration interface is introduced.

29. The Jira client remains a deep module: callers learn one narrow POST interface while URL safety, credentials, headers, serialization, timeout, redirect behavior and response classification remain in its implementation.

30. The accepted ADR “Скрывать транспорт Jira за нормализованными ошибками” governs the public error contract. No additional ADR is required for the workflow transition or narrow write interface because those decisions are local and reversible.

## Testing Decisions

1. Tests assert external behavior at existing interfaces. They do not test private selector, normalization or request helper functions independently.

2. The primary seam is the MCP tool's public `toolCall` interface with a stubbed `fetch`. This is the highest existing seam and verifies input validation, the request sequence, mutation behavior, structured success output, MCP error output and transport redaction together. Existing Jira tool tests are the prior art.

3. The second seam is the Jira client's public factory result. It directly verifies transport behavior that should remain local to the client. Existing Jira client tests are the prior art. No new production seam or adapter is introduced solely for testing.

4. Jira client coverage includes POST method, safe URL resolution, Bearer authorization, JSON accept/content headers, redirect rejection, timeout behavior, contextual not-found mapping, one-time serialization and the exact request body.

5. Jira client coverage proves that only `204` succeeds, other `2xx` responses become `RESPONSE_FORMAT_ERROR`, serialization failure becomes `BAD_REQUEST`, and no private request body enters the error.

6. Existing GET and binary error tests are updated to prove that public MCP error text no longer contains HTTP status. Tests continue checking that Jira bodies, URLs and internal failures remain absent.

7. Tool input tests reject invalid issue keys, empty target statuses and unknown fields before any Jira request.

8. The no-op test proves that one issue GET is performed, the canonical first-read key is returned, previous and new statuses are equal, `transition` is null and `changed` is false.

9. The happy-path test proves the order GET issue → GET transitions → POST transition → GET issue, the minimal POST body, contextual not-found handling, the verified result and `changed: true`.

10. Matching tests cover surrounding whitespace and case differences for the input, current status and transition target names.

11. An unavailable-status test proves that every available transition is returned in Jira order and no POST occurs.

12. An ambiguity test uses at least two transitions with the same target status and proves both candidates are returned without choosing or posting.

13. Required-field tests cover one and multiple fields, normalized field schema, and `hasDefaultValue: true`; every case blocks POST.

14. Malformed issue, transition and verification responses produce `RESPONSE_FORMAT_ERROR` and do not expose fixture-only private data.

15. Every normalized POST failure is returned without a verification GET or retry.

16. A failed verification GET produces `TRANSITION_VERIFICATION_FAILED` with the normalized underlying `causeCode` and no transport detail.

17. A verified unexpected status produces `TRANSITION_STATUS_MISMATCH` with expected and actual statuses. Cases cover the initial status and a third concurrent status.

18. A verification response with the expected id and a changed name succeeds and returns the observed new name.

19. Tool-definition coverage checks the name, English description, input/output schemas and all four mutation annotations.

20. Completion requires lint, formatting, strict type checking, all tests, TypeScript compilation and MCP build to pass.

## Out of Scope

- Directly writing Jira's `status` field.
- Automatically finding or executing multi-step routes through intermediate statuses.
- Accepting or changing resolution, comments, assignee or any additional transition field.
- Executing a transition that reports any required field, even when Jira advertises a default value.
- Allowing the consumer to choose a transition by id or transition name.
- Automatically retrying reads or writes, reselecting transitions, or reconciling a failed POST.
- Guaranteeing the absence of concurrent Jira changes or that the verified status persists after the response.
- Adding server-side mutation confirmation or elicitation; confirmation remains with the MCP consumer.
- Designing a universal Jira write interface beyond the narrow JSON POST with no-content success.
- Exposing HTTP status, URL, raw Jira errors, stack traces or internal causes to MCP consumers.
- Changing Jira credentials, URL configuration or secret-storage behavior.
- Supporting Jira Cloud REST API v3.
- Implementing unrelated Jira write operations.

## Further Notes

- Jira integration targets Jira Server/Data Center 9.12.23 and REST API v2 under `/rest/api/2`.
- The authoritative external reference is the official Jira Server platform REST API 9.12.23 documentation for Get issue, Get transitions and Do transition.
- Jira exposes only transitions available to the current user and current issue state; this is not a complete status catalogue.
- Workflow validators may reject a POST for conditions not represented by transition field metadata. Such responses use existing normalized Jira error codes.
- A trusted `204` contains no body, which is why verification is part of the successful write contract rather than an optional diagnostic step.
- The implementation uses strict TypeScript, ESM source imports with `.js`, Node.js 24.16.0 or newer, Zod validation, and the existing Jira client.
- The accepted interactive prototype remains a design aid only and is not production code.
