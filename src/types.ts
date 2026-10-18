/** One operator-owned provider key. */
export interface ProviderKey {
  id: string;
  provider: string;
  credentials: Record<string, string>;
  limits?: {
    concurrent_sandboxes?: number;
    creates_per_day?: number;
    creates_per_month?: number;
    spend_usd_per_month?: number;
    monthly_spend_usd?: number;
  };
  organization_id?: string;
}

export interface BoxRouterConfig {
  organization?: { name?: string; markup?: number };
  keys: ProviderKey[];
}

export interface ExecHandlers {
  onStdout?: (line: string) => void;
  onStderr?: (line: string) => void;
  signal?: AbortSignal;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface DirEntry {
  name: string;
  path: string;
  sizeBytes?: number;
}

export interface TerminalTarget {
  url: string;
  headers: Record<string, string>;
}

/** A live provider sandbox. Implementations stream command output. */
export interface ProviderSession {
  readonly provider: string;
  readonly resourceId: string;
  exec(command: string, handlers: ExecHandlers): Promise<ExecResult> & {
    cancel: () => Promise<void>;
  };
  listDir(path: string): Promise<{ directories: DirEntry[]; files: DirEntry[] }>;
  /** Attach a browser terminal. Reject when this provider has no PTY. */
  attachTerminal(socket: TerminalSocket, size: { cols: number; rows: number }): Promise<void>;
  destroy(): Promise<void>;
}

export interface TerminalSocket {
  send(data: string | Buffer): void;
  onMessage(listener: (data: Buffer) => void): void;
  onClose(listener: () => void): void;
  close(): void;
}

export interface ProviderDriver {
  readonly name: string;
  create(key: ProviderKey, request: CreateRequest): Promise<ProviderSession>;
  /** Reattach to a sandbox created earlier. */
  resume(key: ProviderKey, resourceId: string): Promise<ProviderSession>;
  /** True when getTerminalTarget can open a real PTY for this provider. */
  readonly terminal: boolean;
}

export interface CreateRequest {
  name: string;
  image?: string;
  memoryMb?: number;
  env?: Record<string, string>;
  cpu?: number;
}
