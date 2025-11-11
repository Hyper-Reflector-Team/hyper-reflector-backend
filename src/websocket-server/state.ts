import { ConnectedUser, LobbyMeta } from './types';

export const connectedUsers = new Map<string, ConnectedUser>();
export const lobbies = new Map<string, Map<string, ConnectedUser>>();
export const lobbyMeta = new Map<string, LobbyMeta>();
export const lobbyTimeouts = new Map<string, NodeJS.Timeout>();
export const userLobby = new Map<string, string>();
