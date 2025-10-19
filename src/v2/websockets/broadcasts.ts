import WebSocket from 'ws';
// Used for maintaining websocket functions that call all users, or all users in a lobby.
import { lobbies, lobbyTimeouts, lobbyMeta, connectedUsers, lobbyMessages, LOBBY_MESSAGE_BUFFER } from './maps'

export function getLobbyUsers(lobbyId) {
    const lobby = lobbies.get(lobbyId)
    return lobby ? [...lobby.values()] : []
}

export function broadCastUserMessage(messageData) {
    const { sender, message } = messageData
    const { uid, lobbyId } = sender

    if (!lobbies.has(lobbyId)) {
        console.warn(`Lobby ${lobbyId} not found for message from ${uid}`)
        return
    }

    const lobby = lobbies.get(lobbyId)

    const historyEntry = {
        id: messageData.id || `${uid}-${Date.now()}`,
        role: messageData.role || 'user',
        text: message,
        timeStamp: Date.now(),
        sender,
    }

    if (!lobbyMessages.has(lobbyId)) {
        lobbyMessages.set(lobbyId, [])
    }
    const history = lobbyMessages.get(lobbyId)!
    history.push(historyEntry)
    if (history.length > LOBBY_MESSAGE_BUFFER) {
        history.shift()
    }

    for (const user of lobby.values()) {
        if (user.ws.readyState === WebSocket.OPEN) {
            user.ws.send(
                JSON.stringify({
                    type: 'getRoomMessage',
                    message: historyEntry.text,
                    sender: historyEntry.sender,
                    id: historyEntry.id,
                    timeStamp: historyEntry.timeStamp,
                    role: historyEntry.role,
                })
            )
        }
    }
}

export function disconnectUserFromUsers(userUID, wss) {
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'matchEndedClose', userUID }))
        }
    })
}

export function broadcastLobbyUserCounts(wss) {
    if (!wss) return
    let updates = []

    for (const [lobbyId, users] of lobbies.entries()) {
        const meta = lobbyMeta.get(lobbyId)
        updates.push({
            name: lobbyId,
            users: users.size,
            pass: meta?.pass || '',
            isPrivate: meta?.isPrivate || false,
        })
    }

    const payload = JSON.stringify({
        type: 'lobby-user-counts',
        updates,
    })

    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload)
        }
    })
}

// export function broadcastUserList(lobbyId) {
//     const lobby = lobbies.get(lobbyId)
//     if (!lobby) return

//     const users = getLobbyUsers(lobbyId).map(({ ws, ...rest }) => rest)

//     for (const user of lobby.values()) {
//         if (!user.ws) return
//         user.ws.send(
//             JSON.stringify({
//                 type: 'connected-users',
//                 users,
//                 count: users.length,
//             })
//         )
//     }
// }

export function broadcastUserList(lobbyId) {
    const lobby = lobbies.get(lobbyId)
    if (!lobby) return

    const users = [...lobby.keys()].map(uid => {
        const connectedUser = connectedUsers.get(uid)
        if (!connectedUser) return null
        const { ws, ...rest } = connectedUser
        return rest
    }).filter(Boolean)

    for (const member of lobby.values()) {
        if (!member.ws || member.ws.readyState !== WebSocket.OPEN) continue
        member.ws.send(JSON.stringify({ type: 'connected-users', users, count: users.length }))
    }
}

// if the lobby is empty close it after 30 seconds.
export function removeUserFromAllLobbies(uid, wss) {
    if (!wss) return
    for (const [lobbyId, users] of lobbies.entries()) {
        if (users.has(uid)) {
            users.delete(uid)

            if (users.size === 0 && lobbyId !== 'Hyper Reflector') {
                if (!lobbyTimeouts.has(lobbyId)) {
                    const timeout = setTimeout(() => {
                        lobbies.delete(lobbyId)
                        lobbyTimeouts.delete(lobbyId)

                        broadcastLobbyRemoved(lobbyId, wss)
                        console.log(`Lobby ${lobbyId} closed due to inactivity`)
                        broadcastLobbyUserCounts(wss)
                    }, 30000)

                    lobbyTimeouts.set(lobbyId, timeout)
                }
            } else {
                broadcastUserList(lobbyId)
            }
        }
    }
}

export function broadcastLobbyRemoved(lobbyId, wss) {
    const payload = JSON.stringify({
        type: 'lobby-closed',
        lobbyId,
    })

    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload)
        }
    })
}

export function broadcastKillPeer(userUID, wss) {
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            console.log('sending signal for disconnect to other user')
            client.send(
                JSON.stringify({
                    type: 'userDisconnect',
                    userUID: userUID,
                })
            )
        }
    })
}

export async function updateLobbyData(updateData) {
    const lobby = lobbies.get(updateData.lobbyId)
    if (!lobby) return
    const existing = lobby.get(updateData.uid) || connectedUsers.get(updateData.uid) || {}
    const toUpdate = updateData.stateToUpdate
    lobby.set(updateData.uid, { ...existing, [toUpdate.key]: toUpdate.value })
    broadcastUserList(updateData.lobbyId)
}

export function syncUserToLobby(uid: string, lobbyId) {
    const user = connectedUsers.get(uid)
    if (!user || !lobbyId) return

    const lobby = lobbies.get(lobbyId)
    if (lobby) {
        lobby.set(uid, { ...user }) // fresh copy into lobby map
    }
}

export function sendLobbyHistory(ws: WebSocket, lobbyId: string) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const history = lobbyMessages.get(lobbyId) || []

    ws.send(
        JSON.stringify({
            type: 'lobby-history',
            lobbyId,
            messages: history.map((entry) => ({
                id: entry.id,
                text: entry.text,
                timeStamp: entry.timeStamp,
                role: entry.role || 'user',
                sender: entry.sender,
            })),
        })
    )
}
