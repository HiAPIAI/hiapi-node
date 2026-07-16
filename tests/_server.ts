/** Tiny in-process HTTP mock for transport/tasks tests. */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  method: string;
  /** Path including the query string, e.g. `/v1/tasks?page=1&size=20`. */
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface MockReply {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
}

/** Called per request; `index` is the 0-based request number since reset(). */
export type MockHandler = (
  req: RecordedRequest,
  index: number,
) => MockReply | Promise<MockReply>;

export function jsonReply(data: unknown, status = 200, headers: Record<string, string> = {}): MockReply {
  return {
    status,
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(data),
  };
}

export class MockServer {
  requests: RecordedRequest[] = [];
  handler: MockHandler = () => jsonReply({ data: {} });
  url = "";
  port = 0;
  private server: Server | undefined;

  /** `port` defaults to 0 (OS-assigned) — pass an already-bound port to test listen() failure paths. */
  async start(port = 0): Promise<this> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const recorded: RecordedRequest = {
          method: req.method ?? "",
          path: req.url ?? "",
          headers: req.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        };
        this.requests.push(recorded);
        // Allow a handler to delay its response (e.g. to test behavior while
        // a request is genuinely in-flight) by returning a Promise. Wrapped
        // in try/catch (a handler can throw synchronously, before returning
        // anything a `.then()`/`.catch()` chain would ever see) and with an
        // explicit `.catch()` (an async handler's rejection would otherwise
        // be an unhandled rejection) — either failure mode used to leave the
        // connection hanging with no response, turning a test assertion
        // thrown from inside a handler into a confusing timeout instead of
        // the real failure.
        try {
          Promise.resolve(this.handler(recorded, this.requests.length - 1))
            .then((reply) => {
              res.writeHead(reply.status ?? 200, reply.headers ?? {});
              res.end(reply.body ?? "");
            })
            .catch((err) => {
              res.destroy(err instanceof Error ? err : new Error(String(err)));
            });
        } catch (err) {
          res.destroy(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
    // Both "listening" and "error" are raced — listen() only ever invokes
    // its own callback on success, never on failure (EADDRINUSE, EPERM in a
    // sandboxed/restricted environment, etc.), so a bare `resolve` callback
    // left this promise permanently pending on a real listen failure: the
    // suite's before-hook hung instead of failing with a clear cause,
    // indistinguishable from an unrelated timeout.
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        this.server!.removeListener("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        this.server!.removeListener("error", onError);
        resolve();
      };
      this.server!.once("error", onError);
      this.server!.once("listening", onListening);
      this.server!.listen(port, "127.0.0.1");
    });
    const addr = this.server!.address() as AddressInfo;
    this.port = addr.port;
    this.url = `http://127.0.0.1:${addr.port}`;
    return this;
  }

  reset(handler?: MockHandler): void {
    this.requests = [];
    if (handler) {
      this.handler = handler;
    }
  }

  async close(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve, reject) =>
        this.server!.close((err) => (err ? reject(err) : resolve())),
      );
    }
  }
}

export async function startMock(): Promise<MockServer> {
  return new MockServer().start();
}
