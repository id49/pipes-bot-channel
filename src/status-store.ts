export type PipesBotConnectionStatus = {
  connected: boolean;
  authFailed: boolean;
  lastConnectedAt: number | null;
  lastError: string | null;
};

let _status: PipesBotConnectionStatus = {
  connected: false,
  authFailed: false,
  lastConnectedAt: null,
  lastError: null,
};

export function updateConnectionStatus(patch: Partial<PipesBotConnectionStatus>): void {
  _status = { ..._status, ...patch };
}

export function getConnectionStatus(): PipesBotConnectionStatus {
  return { ..._status };
}
