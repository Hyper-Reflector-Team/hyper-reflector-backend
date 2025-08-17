import { lobbies, lobbyTimeouts, lobbyMeta, connectedUsers, userLobby, userSockets } from './maps'

function getUser(uid: string): User | undefined {
    return connectedUsers.get(uid)
}

function setUser(uid: string, patch: Partial<User>) {
    const prev = connectedUsers.get(uid) ?? { uid } as User
    const next = { ...prev, ...patch }
    connectedUsers.set(uid, next)
    return next
}

function getLobbyMembers(lobbyId: string): string[] {
    return Array.from(lobbies.get(lobbyId) ?? [])
}

function ensureLobby(lobbyId: string) {
    if (!lobbies.has(lobbyId)) lobbies.set(lobbyId, new Set())
}

function joinLobby(uid: string, lobbyId: string) {
    const current = userLobby.get(uid)
    if (current === lobbyId) return

    // leave current lobby
    if (current && lobbies.has(current)) {
        lobbies.get(current)!.delete(uid)
    }

    // join new lobby
    ensureLobby(lobbyId)
    lobbies.get(lobbyId)!.add(uid)
    userLobby.set(uid, lobbyId)

    // persist lobbyId on user (optional but convenient)
    setUser(uid, { lobbyId })
}

function leaveAllLobbies(uid: string) {
    const current = userLobby.get(uid)
    if (current && lobbies.has(current)) {
        lobbies.get(current)!.delete(uid)
    }
    userLobby.delete(uid)
}

export {
    getUser,
    setUser,
    joinLobby,
    ensureLobby,
    getLobbyMembers,
    leaveAllLobbies,
}