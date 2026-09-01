import { z } from "zod";
import { getJiraUrl } from "../common/get-jira-url.js";
import { getToken } from "../common/get-token.js";
import { parseSafeHttpUrl } from "./urls.js";

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
  ATTACHMENT_TOO_LARGE: "ATTACHMENT_TOO_LARGE",
  UNSUPPORTED_ATTACHMENT_TYPE: "UNSUPPORTED_ATTACHMENT_TYPE",
} as const;

export type JiraErrorCode = (typeof JIRA_ERROR_CODE)[keyof typeof JIRA_ERROR_CODE];

type JiraNotFoundCode = (typeof JIRA_ERROR_CODE)["ISSUE_NOT_FOUND" | "ATTACHMENT_NOT_FOUND"];

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];

declare const normalizedJiraErrorDetails: unique symbol;

export type NormalizedJiraErrorDetails = JsonValue & {
  readonly [normalizedJiraErrorDetails]: true;
};

export const normalizeJiraErrorDetails = <T extends JsonValue>(
  schema: z.ZodType<T>,
  details: unknown,
): NormalizedJiraErrorDetails => schema.parse(details) as unknown as NormalizedJiraErrorDetails;

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
  ATTACHMENT_TOO_LARGE: "Jira attachment exceeds the supported size limit.",
  UNSUPPORTED_ATTACHMENT_TYPE: "Jira attachment type is unsupported.",
};

export class JiraClientError extends Error {
  constructor(
    readonly code: JiraErrorCode,
    readonly httpStatus?: number,
    cause?: unknown,
    details?: NormalizedJiraErrorDetails,
  ) {
    const payload = {
      code,
      message: safeMessages[code],
      ...(details === undefined ? {} : { details }),
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

type RequestOptions = {
  pathname: string;
  query?: Readonly<Record<string, string | number | boolean | undefined>>;
  notFoundCode?: JiraNotFoundCode;
};

type GetJsonOptions<T> = RequestOptions & {
  schema: z.ZodType<T>;
};

type PostJsonNoContentOptions = RequestOptions & {
  body: JsonValue;
};

type ProbeOptions = Pick<RequestOptions, "pathname" | "query">;

type RequestTransportOptions = Pick<RequestInit, "body" | "method"> & {
  contentType?: string;
};

const getHttpErrorCode = (
  status: number,
  notFoundCode?: RequestOptions["notFoundCode"],
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
  const getBaseUrl = (): URL => {
    let baseUrl: URL;

    try {
      baseUrl = parseSafeHttpUrl(dependencies.getJiraUrl());
    } catch (cause) {
      throw new JiraClientError(JIRA_ERROR_CODE.CONFIG_ERROR, undefined, cause);
    }

    baseUrl.pathname = `${baseUrl.pathname.replace(/\/+$/, "")}/`;

    return baseUrl;
  };

  const buildUrl = (pathname: string, query: RequestOptions["query"]): URL => {
    const baseUrl = getBaseUrl();

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

  const send = async (
    { pathname, query }: ProbeOptions,
    accept: string,
    token: string | undefined,
    redirect: RequestRedirect,
    requestInit: RequestTransportOptions = {},
  ): Promise<{ response: Response; signal: AbortSignal }> => {
    const signal = AbortSignal.timeout(dependencies.timeoutMs);
    const url = buildUrl(pathname, query);
    const headers: Record<string, string> = { Accept: accept };
    if (token !== undefined) headers.Authorization = `Bearer ${token}`;
    if (requestInit.contentType !== undefined) headers["Content-Type"] = requestInit.contentType;

    let response: Response;

    try {
      response = await dependencies.fetch(url, {
        ...(requestInit.method === undefined ? {} : { method: requestInit.method }),
        ...(requestInit.body === undefined ? {} : { body: requestInit.body }),
        headers,
        redirect,
        signal,
      });
    } catch (cause) {
      throw new JiraClientError(
        signal.aborted ? JIRA_ERROR_CODE.NETWORK_TIMEOUT : JIRA_ERROR_CODE.JIRA_UNAVAILABLE,
        undefined,
        cause,
      );
    }

    return { response, signal };
  };

  const request = async (
    { pathname, query, notFoundCode }: RequestOptions,
    accept: string,
    requestInit?: RequestTransportOptions,
  ): Promise<{ response: Response; signal: AbortSignal }> => {
    let token: string;

    try {
      token = dependencies.getToken();
      if (token.trim() === "") throw new Error("Missing token");
    } catch (cause) {
      throw new JiraClientError(JIRA_ERROR_CODE.CONFIG_ERROR, undefined, cause);
    }

    const result = await send({ pathname, query }, accept, token, "error", requestInit);

    if (!result.response.ok) {
      throw new JiraClientError(
        getHttpErrorCode(result.response.status, notFoundCode),
        result.response.status,
      );
    }

    return result;
  };

  return {
    getInternalPathname(uri: string): string {
      const baseUrl = getBaseUrl();
      let url: URL;

      try {
        url = parseSafeHttpUrl(uri);
      } catch (cause) {
        throw new JiraClientError(JIRA_ERROR_CODE.RESPONSE_FORMAT_ERROR, undefined, cause);
      }

      if (
        url.origin !== baseUrl.origin ||
        !url.pathname.startsWith(baseUrl.pathname) ||
        url.pathname === baseUrl.pathname
      ) {
        throw new JiraClientError(JIRA_ERROR_CODE.RESPONSE_FORMAT_ERROR);
      }

      return url.pathname.slice(baseUrl.pathname.length);
    },

    async probe({ pathname, query }: ProbeOptions) {
      let token: string | undefined;

      try {
        const configuredToken = dependencies.getToken();
        if (configuredToken.trim()) token = configuredToken;
      } catch {
        // Отсутствующие credentials не должны мешать проверке доступности Jira.
      }

      const credentialsFound = token !== undefined;

      try {
        const { response } = await send({ pathname, query }, "application/json", token, "manual");
        return { configured: true, credentialsFound, status: response.status };
      } catch (cause) {
        return {
          configured: !(
            cause instanceof JiraClientError && cause.code === JIRA_ERROR_CODE.CONFIG_ERROR
          ),
          credentialsFound,
        };
      }
    },

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

    async postJsonNoContent({
      pathname,
      query,
      body,
      notFoundCode,
    }: PostJsonNoContentOptions): Promise<void> {
      let serializedBody: string | undefined;
      try {
        serializedBody = JSON.stringify(body);
      } catch (cause) {
        throw new JiraClientError(JIRA_ERROR_CODE.BAD_REQUEST, undefined, cause);
      }

      if (serializedBody === undefined) {
        throw new JiraClientError(JIRA_ERROR_CODE.BAD_REQUEST);
      }

      const { response } = await request({ pathname, query, notFoundCode }, "application/json", {
        method: "POST",
        body: serializedBody,
        contentType: "application/json",
      });

      if (response.status !== 204) {
        throw new JiraClientError(JIRA_ERROR_CODE.RESPONSE_FORMAT_ERROR, response.status);
      }
    },

    async getBinary({ pathname, query, notFoundCode }: RequestOptions): Promise<Response> {
      const { response, signal } = await request({ pathname, query, notFoundCode }, "*/*");

      return wrapBinaryResponse(response, signal);
    },
  };
};

export const jiraClient = createJiraClient();
