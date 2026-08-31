import { z } from "zod";
import { getJiraUrl } from "../common/get-jira-url.js";
import { getToken } from "../common/get-token.js";

export const JIRA_ERROR_CODE = {
  BAD_REQUEST: "BAD_REQUEST",
  AUTH_ERROR: "AUTH_ERROR",
  ACCESS_DENIED: "ACCESS_DENIED",
  ISSUE_NOT_FOUND: "ISSUE_NOT_FOUND",
  RATE_LIMITED: "RATE_LIMITED",
  JIRA_UNAVAILABLE: "JIRA_UNAVAILABLE",
  NETWORK_TIMEOUT: "NETWORK_TIMEOUT",
  RESPONSE_FORMAT_ERROR: "RESPONSE_FORMAT_ERROR",
  CONFIG_ERROR: "CONFIG_ERROR",
  ATTACHMENT_NOT_FOUND: "ATTACHMENT_NOT_FOUND",
} as const;

export type JiraErrorCode = (typeof JIRA_ERROR_CODE)[keyof typeof JIRA_ERROR_CODE];

type JiraNotFoundCode = (typeof JIRA_ERROR_CODE)["ISSUE_NOT_FOUND" | "ATTACHMENT_NOT_FOUND"];

const safeMessages: Record<JiraErrorCode, string> = {
  BAD_REQUEST: "Jira rejected the request.",
  AUTH_ERROR: "Jira authentication failed.",
  ACCESS_DENIED: "Jira access was denied.",
  ISSUE_NOT_FOUND: "Jira issue was not found.",
  RATE_LIMITED: "Jira rate limit was exceeded.",
  JIRA_UNAVAILABLE: "Jira is unavailable.",
  NETWORK_TIMEOUT: "Jira request timed out.",
  RESPONSE_FORMAT_ERROR: "Jira returned an unexpected response.",
  CONFIG_ERROR: "Jira configuration is invalid.",
  ATTACHMENT_NOT_FOUND: "Jira attachment was not found.",
};

export class JiraClientError extends Error {
  constructor(
    readonly code: JiraErrorCode,
    readonly httpStatus?: number,
    cause?: unknown,
  ) {
    const payload = {
      code,
      message: safeMessages[code],
      ...(httpStatus === undefined ? {} : { httpStatus }),
    };
    super(JSON.stringify(payload), cause === undefined ? undefined : { cause });
    this.name = "JiraClientError";
  }
}

type JiraClientDependencies = {
  fetch: (input: URL, init: RequestInit) => Promise<Response>;
  getJiraUrl: () => string;
  getToken: () => string;
  timeoutMs: number;
};

type GetOptions = {
  pathname: string;
  query?: Readonly<Record<string, string | number | boolean | undefined>>;
  notFoundCode?: JiraNotFoundCode;
};

type GetJsonOptions<T> = GetOptions & {
  schema: z.ZodType<T>;
};

const getHttpErrorCode = (
  status: number,
  notFoundCode?: GetOptions["notFoundCode"],
): JiraErrorCode => {
  if (status === 400) return JIRA_ERROR_CODE.BAD_REQUEST;
  if (status === 401) return JIRA_ERROR_CODE.AUTH_ERROR;
  if (status === 403) return JIRA_ERROR_CODE.ACCESS_DENIED;
  if (status === 404) return notFoundCode ?? JIRA_ERROR_CODE.BAD_REQUEST;
  if (status === 408) return JIRA_ERROR_CODE.NETWORK_TIMEOUT;
  if (status === 429) return JIRA_ERROR_CODE.RATE_LIMITED;
  if (status >= 400 && status < 500) return JIRA_ERROR_CODE.BAD_REQUEST;
  return JIRA_ERROR_CODE.JIRA_UNAVAILABLE;
};

const wrapBinaryResponse = (response: Response, signal: AbortSignal): Response => {
  if (response.body === null) return response;

  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          controller.close();
        } else {
          controller.enqueue(result.value);
        }
      } catch (cause) {
        controller.error(
          new JiraClientError(
            signal.aborted ? JIRA_ERROR_CODE.NETWORK_TIMEOUT : JIRA_ERROR_CODE.JIRA_UNAVAILABLE,
            undefined,
            cause,
          ),
        );
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

export const createJiraClient = (overrides: Partial<JiraClientDependencies> = {}) => {
  const dependencies: JiraClientDependencies = {
    fetch: (input, init) => globalThis.fetch(input, init),
    getJiraUrl,
    getToken,
    timeoutMs: 10_000,
    ...overrides,
  };
  const buildUrl = (pathname: string, query: GetOptions["query"]): URL => {
    let baseUrl: URL;

    try {
      baseUrl = new URL(dependencies.getJiraUrl());
    } catch (cause) {
      throw new JiraClientError(JIRA_ERROR_CODE.CONFIG_ERROR, undefined, cause);
    }

    if (
      !["http:", "https:"].includes(baseUrl.protocol) ||
      baseUrl.username !== "" ||
      baseUrl.password !== "" ||
      baseUrl.search !== "" ||
      baseUrl.hash !== ""
    ) {
      throw new JiraClientError(JIRA_ERROR_CODE.CONFIG_ERROR);
    }

    baseUrl.pathname = `${baseUrl.pathname.replace(/\/+$/, "")}/`;

    let pathSegments: string[];
    try {
      pathSegments = pathname.split("/").map(decodeURIComponent);
    } catch (cause) {
      throw new JiraClientError(JIRA_ERROR_CODE.BAD_REQUEST, undefined, cause);
    }

    if (
      pathname === "" ||
      pathname.startsWith("/") ||
      pathname.includes("\\") ||
      pathname.includes("?") ||
      pathname.includes("#") ||
      /^[a-z][a-z\d+.-]*:/i.test(pathname) ||
      pathSegments.some(
        (segment) =>
          segment === "." || segment === ".." || segment.includes("/") || segment.includes("\\"),
      )
    ) {
      throw new JiraClientError(JIRA_ERROR_CODE.BAD_REQUEST);
    }

    const url = new URL(pathname, baseUrl);

    if (url.origin !== baseUrl.origin || !url.pathname.startsWith(baseUrl.pathname)) {
      throw new JiraClientError(JIRA_ERROR_CODE.BAD_REQUEST);
    }

    for (const [name, value] of Object.entries(query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(name, String(value));
      }
    }

    return url;
  };

  const request = async (
    { pathname, query, notFoundCode }: GetOptions,
    accept: string,
  ): Promise<{ response: Response; signal: AbortSignal }> => {
    const signal = AbortSignal.timeout(dependencies.timeoutMs);
    let token: string;

    try {
      token = dependencies.getToken();
      if (token.trim() === "") throw new Error("Missing token");
    } catch (cause) {
      throw new JiraClientError(JIRA_ERROR_CODE.CONFIG_ERROR, undefined, cause);
    }

    const url = buildUrl(pathname, query);
    let response: Response;

    try {
      response = await dependencies.fetch(url, {
        headers: {
          Accept: accept,
          Authorization: `Bearer ${token}`,
        },
        redirect: "error",
        signal,
      });
    } catch (cause) {
      throw new JiraClientError(
        signal.aborted ? JIRA_ERROR_CODE.NETWORK_TIMEOUT : JIRA_ERROR_CODE.JIRA_UNAVAILABLE,
        undefined,
        cause,
      );
    }

    if (!response.ok) {
      throw new JiraClientError(getHttpErrorCode(response.status, notFoundCode), response.status);
    }

    return { response, signal };
  };

  return {
    async getJson<T>({ pathname, query, schema, notFoundCode }: GetJsonOptions<T>): Promise<T> {
      const { response, signal } = await request(
        { pathname, query, notFoundCode },
        "application/json",
      );

      let body: unknown;
      try {
        body = await response.json();
      } catch (cause) {
        const isResponseFormatError = cause instanceof SyntaxError;
        throw new JiraClientError(
          signal.aborted
            ? JIRA_ERROR_CODE.NETWORK_TIMEOUT
            : isResponseFormatError
              ? JIRA_ERROR_CODE.RESPONSE_FORMAT_ERROR
              : JIRA_ERROR_CODE.JIRA_UNAVAILABLE,
          !signal.aborted && isResponseFormatError ? response.status : undefined,
          cause,
        );
      }

      try {
        return schema.parse(body);
      } catch (cause) {
        throw new JiraClientError(JIRA_ERROR_CODE.RESPONSE_FORMAT_ERROR, response.status, cause);
      }
    },

    async getBinary({ pathname, query, notFoundCode }: GetOptions): Promise<Response> {
      const { response, signal } = await request({ pathname, query, notFoundCode }, "*/*");

      return wrapBinaryResponse(response, signal);
    },
  };
};

export const jiraClient = createJiraClient();
