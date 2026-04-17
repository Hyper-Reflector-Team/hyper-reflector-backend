import { ConnectedUser, LobbyMeta, RankQueueEntry } from './types'

export const connectedUsers = new Map<string, ConnectedUser>()
export const lobbies = new Map<string, Map<string, ConnectedUser>>()
export const lobbyMeta = new Map<string, LobbyMeta>()
export const lobbyTimeouts = new Map<string, NodeJS.Timeout>()
export const userLobby = new Map<string, string>()
// Multi-lobby: tracks ALL lobbies a user is subscribed to (uid → Set<lobbyId>)
export const userSubscriptions = new Map<string, Set<string>>()
// Ranked queue entries
export const rankQueue = new Map<string, RankQueueEntry>()
export const activeMatches = new Map<
    string,
    {
        id: string
        lobbyId: string
        startedAt: number
        gameName?: string | null
        players: Array<{
            uid: string
            playerSlot: 0 | 1
            userName?: string
            userProfilePic?: string
            countryCode?: string
            userTitle?: any
            accountElo?: number
        }>
    }
>()
