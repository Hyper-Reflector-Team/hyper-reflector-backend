export const connectedUsers = new Map()
export const lobbies = new Map()
export const lobbyTimeouts = new Map()
export const lobbyMeta = new Map() // keep track of lobby metadata like password
export const userSockets = new Map<string, WebSocket>()
export const userLobby = new Map<string, string>()             
export const lobbyMessages = new Map<string, any[]>()
export const LOBBY_MESSAGE_BUFFER = 200
