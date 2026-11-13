export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

export class PlankaError extends Error {
  override name = "PlankaError";
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly method?: HttpMethod,
    readonly path?: string,
  ) {
    super(message);
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Thin wrapper around the Planka v2 REST API using API-key auth. */
export class PlankaClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike = (i, init) => fetch(i, init),
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async request<T = any>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}/api${path.startsWith("/") ? path : `/${path}`}`;
    const headers: Record<string, string> = { "X-Api-Key": this.apiKey, Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new PlankaError(`Network error calling ${method} ${path}: ${this.redact(msg)}`, 0, "E_NETWORK", method, path);
    }

    const text = await res.text();
    let data: any = undefined;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }

    if (!res.ok) {
      const code = typeof data === "object" && data ? data.code : undefined;
      const message =
        (typeof data === "object" && data && (data.message || data.problems?.join("; "))) ||
        (typeof data === "string" ? data.slice(0, 200) : res.statusText);
      throw new PlankaError(
        this.redact(`Planka ${method} ${path} failed (${res.status}${code ? ` ${code}` : ""}): ${message}`),
        res.status,
        code,
        method,
        path,
      );
    }
    return data as T;
  }

  get<T = any>(path: string) {
    return this.request<T>("GET", path);
  }
  post<T = any>(path: string, body?: unknown) {
    return this.request<T>("POST", path, body ?? {});
  }
  patch<T = any>(path: string, body: unknown) {
    return this.request<T>("PATCH", path, body);
  }
  delete<T = any>(path: string) {
    return this.request<T>("DELETE", path);
  }

  private redact(s: string): string {
    return this.apiKey ? s.split(this.apiKey).join("***") : s;
  }
}
