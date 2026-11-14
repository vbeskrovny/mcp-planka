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

export interface Download {
  data: Buffer;
  contentType: string;
}

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
    const isForm = body instanceof FormData;
    if (body !== undefined && !isForm) headers["Content-Type"] = "application/json";
    // FormData: fetch sets the multipart Content-Type with its boundary itself.
    const res = await this.send(url, method, path, {
      method,
      headers,
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    });

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

  /** POST a multipart form (file upload) to an API path. */
  upload<T = any>(path: string, form: FormData) {
    return this.request<T>("POST", path, form);
  }

  /**
   * Download a binary resource (e.g. an attachment file URL returned by Planka). The API key is only
   * ever sent to the configured Planka host: URLs elsewhere are refused.
   */
  async download(url: string): Promise<Download> {
    const target = url.startsWith("/") ? `${this.baseUrl}${url}` : url;
    if (!target.startsWith(`${this.baseUrl}/`)) {
      throw new PlankaError(`Refusing to download from outside ${this.baseUrl}: ${target}`, 0, "E_FOREIGN_URL", "GET", url);
    }
    const path = target.slice(this.baseUrl.length);
    const res = await this.send(target, "GET", path, { method: "GET", headers: { "X-Api-Key": this.apiKey } });
    if (!res.ok) {
      throw new PlankaError(this.redact(`Planka GET ${path} failed (${res.status}): ${res.statusText}`), res.status, undefined, "GET", path);
    }
    return {
      data: Buffer.from(await res.arrayBuffer()),
      contentType: res.headers.get("content-type") ?? "application/octet-stream",
    };
  }

  private async send(url: string, method: HttpMethod, path: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, init);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new PlankaError(`Network error calling ${method} ${path}: ${this.redact(msg)}`, 0, "E_NETWORK", method, path);
    }
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
