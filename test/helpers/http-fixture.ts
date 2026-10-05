import http from 'node:http';
import type { AddressInfo } from 'node:net';

export type RouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => void;

export interface TestHttpServer {
  baseUrl: string;
  port: number;
  set(path: string, handler: RouteHandler): void;
  /** Convenience: serve a fixed response body. */
  serve(path: string, body: string | Buffer, headers?: Record<string, string>, status?: number): void;
  close(): Promise<void>;
}

/**
 * Starts a temporary local HTTP server for bounded-fetch tests.
 */
export async function startHttpFixture(): Promise<TestHttpServer> {
  const routes = new Map<string, RouteHandler>();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const handler = routes.get(url.pathname);
    if (!handler) {
      res.statusCode = 404;
      res.setHeader('content-type', 'text/plain');
      res.end('not found');
      return;
    }
    handler(req, res);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    port: address.port,
    set(path, handler) {
      routes.set(path, handler);
    },
    serve(path, body, headers = {}, status = 200) {
      routes.set(path, (_req, res) => {
        res.statusCode = status;
        for (const [key, value] of Object.entries(headers)) {
          res.setHeader(key, value);
        }
        res.end(body);
      });
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
