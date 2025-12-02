export const SIGNAL_PORT = Number(process.env.VNEW_SIGNAL_PORT ?? 3004);
export const DEFAULT_LOBBY_ID = process.env.VNEW_DEFAULT_LOBBY ?? 'Hyper Reflector';
export const HEARTBEAT_INTERVAL_MS = Number(process.env.VNEW_HEARTBEAT ?? 30000);
export const HEARTBEAT_TERMINATE_AFTER_MS = 90000;
export const LOBBY_IDLE_TIMEOUT_MS = Number(process.env.VNEW_LOBBY_IDLE_TIMEOUT ?? 30000);
