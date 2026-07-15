/**
 * Typed data models for the unified async task API.
 *
 * The wire format uses camelCase (`taskId`, `expireAt`); parsing is defensive —
 * unknown fields are kept in `raw` so a server-side addition never breaks an
 * older SDK.
 */

export type JSONObject = Record<string, unknown>;

export type TaskStatus = "queued" | "handling" | "archiving" | "success" | "fail";

/** Terminal statuses a task can never leave once reached. */
export const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["success", "fail"]);

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function optStr(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function optNum(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function isObject(v: unknown): v is JSONObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** One generated artifact produced by a successful task. */
export class Output {
  readonly url: string;
  readonly type: string;
  /** Unix seconds after which the URL stops working. */
  readonly expireAt?: number;
  /** The full wire object, including fields this SDK does not model. */
  readonly raw: JSONObject;

  constructor(fields: { url: string; type: string; expireAt?: number; raw?: JSONObject }) {
    this.url = fields.url;
    this.type = fields.type;
    this.expireAt = fields.expireAt;
    this.raw = fields.raw ?? {};
  }

  static fromJSON(d: JSONObject): Output {
    return new Output({
      url: str(d.url),
      type: str(d.type),
      expireAt: optNum(d.expireAt),
      raw: d,
    });
  }
}

/** The failure reason attached to a task in `fail` state. */
export class TaskError {
  readonly code?: string;
  readonly message?: string;
  readonly raw: JSONObject;

  constructor(fields: { code?: string; message?: string; raw?: JSONObject }) {
    this.code = fields.code;
    this.message = fields.message;
    this.raw = fields.raw ?? {};
  }

  static fromJSON(d: JSONObject): TaskError {
    return new TaskError({ code: optStr(d.code), message: optStr(d.message), raw: d });
  }
}

/** An async generation task and (when finished) its output. */
export class Task {
  readonly taskId: string;
  readonly model: string;
  /**
   * Kept as `string` (not the {@link TaskStatus} union) on purpose: a status
   * the server adds later must still parse rather than break an older SDK.
   */
  readonly status: string;
  /** Unix seconds when the task was created. */
  readonly createdAt?: number;
  /** Unix seconds when the task reached a terminal state. */
  readonly completedAt?: number;
  readonly storage?: string;
  /**
   * Echoed only when the task was submitted with an explicit `route`
   * parameter; `model` then holds the resolved full name (`base@route`).
   */
  readonly route?: string;
  readonly output: Output[];
  readonly error?: TaskError;
  /** The full wire object, including fields this SDK does not model. */
  readonly raw: JSONObject;

  constructor(fields: {
    taskId: string;
    model: string;
    status: string;
    createdAt?: number;
    completedAt?: number;
    storage?: string;
    route?: string;
    output?: Output[];
    error?: TaskError;
    raw?: JSONObject;
  }) {
    this.taskId = fields.taskId;
    this.model = fields.model;
    this.status = fields.status;
    this.createdAt = fields.createdAt;
    this.completedAt = fields.completedAt;
    this.storage = fields.storage;
    this.route = fields.route;
    this.output = fields.output ?? [];
    this.error = fields.error;
    this.raw = fields.raw ?? {};
  }

  get isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this.status);
  }

  get succeeded(): boolean {
    return this.status === "success";
  }

  static fromJSON(d: JSONObject): Task {
    const output = Array.isArray(d.output)
      ? d.output.filter(isObject).map((o) => Output.fromJSON(o))
      : [];
    // The API sends `completed: 0` (not omitted) while a task is non-terminal;
    // normalize that sentinel to undefined so callers don't read it as epoch 0.
    const completed = optNum(d.completed);
    return new Task({
      taskId: str(d.taskId),
      model: str(d.model),
      status: str(d.status),
      createdAt: optNum(d.created),
      completedAt: completed || undefined,
      storage: optStr(d.storage),
      route: optStr(d.route),
      output,
      error: isObject(d.error) ? TaskError.fromJSON(d.error) : undefined,
      raw: d,
    });
  }
}

/** The thin response of `POST /v1/tasks` — just the new task id. */
export class CreatedTask {
  readonly taskId: string;
  /**
   * True when the server answered from the idempotency cache (the request
   * carried an `Idempotency-Key` it had already fulfilled): `taskId` is the
   * task created by the first request, and no new task was created.
   */
  readonly idempotentReplay: boolean;
  readonly raw: JSONObject;

  constructor(fields: { taskId: string; idempotentReplay?: boolean; raw?: JSONObject }) {
    this.taskId = fields.taskId;
    this.idempotentReplay = fields.idempotentReplay ?? false;
    this.raw = fields.raw ?? {};
  }

  static fromJSON(d: JSONObject, idempotentReplay = false): CreatedTask {
    return new CreatedTask({ taskId: str(d.taskId), idempotentReplay, raw: d });
  }
}

/** One page of `GET /v1/tasks` (newest first). */
export class TaskPage {
  readonly items: Task[];
  readonly page?: number;
  readonly size?: number;
  readonly total?: number;
  readonly raw: JSONObject;

  constructor(fields: {
    items?: Task[];
    page?: number;
    size?: number;
    total?: number;
    raw?: JSONObject;
  }) {
    this.items = fields.items ?? [];
    this.page = fields.page;
    this.size = fields.size;
    this.total = fields.total;
    this.raw = fields.raw ?? {};
  }

  static fromJSON(d: JSONObject): TaskPage {
    // The API returns the page array under "tasks"; accept common alternates
    // too so a paginated list never silently parses to empty. The full
    // payload is kept in raw.
    let rawItems: unknown[] | undefined;
    for (const key of ["tasks", "items", "list", "data", "records"]) {
      const value = d[key];
      if (Array.isArray(value)) {
        rawItems = value;
        break;
      }
    }
    const items = (rawItems ?? []).filter(isObject).map((t) => Task.fromJSON(t));
    return new TaskPage({
      items,
      page: optNum(d.page),
      size: optNum(d.size),
      total: optNum(d.total),
      raw: d,
    });
  }
}
