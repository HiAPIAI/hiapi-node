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
  private server: Server | undefined;

  async start(): Promise<this> {
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
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const addr = this.server!.address() as AddressInfo;
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
