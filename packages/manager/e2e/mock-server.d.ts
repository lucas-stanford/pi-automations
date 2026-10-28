declare module '*.mjs' {
  import type { Server } from 'node:http';
  export function startMockServer(options?: { port?: number }): Promise<{ server: Server; url: string; dataDir: string }>;
}
