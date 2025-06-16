// Used for maintaining websocket functions that call all users, or all users in a lobby.
import { lobbies, lobbyTimeouts, lobbyMeta } from './maps'

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

    for (const user of lobby.values()) {
        if (user.ws.readyState === WebSocket.OPEN) {
            user.ws.send(
                JSON.stringify({
                    type: 'getRoomMessage',
                    message,
                    sender,
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

export function broadcastUserList(lobbyId) {
    const lobby = lobbies.get(lobbyId)
    if (!lobby) return

    const users = getLobbyUsers(lobbyId).map(({ ws, ...rest }) => rest)

    for (const user of lobby.values()) {
        if (!user.ws) return
        user.ws.send(
            JSON.stringify({
                type: 'connected-users',
                users,
                count: users.length,
            })
        )
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
    const lobby = await lobbies.get(updateData.lobbyId)
    const userData = lobby.get(updateData.uid)
    const toUpdate = updateData.stateToUpdate
    await lobby.set(updateData.uid, { ...userData, ...{ [toUpdate.key]: toUpdate.value } })
    broadcastUserList(updateData.lobbyId)
}
