// This is the signalling server used by coturn and the front end application to handle handshaking / making inital RTC call
// This has also been coopted to handle all websocket related stuff on the front end.

const WebSocket = require('ws')
const axios = require('axios')
const serverInfo = require('../../keys/server.ts')

const wss = new WebSocket.Server({ port: 3003 })

const connectedUsers = new Map()
const lobbies = new Map()
const lobbyTimeouts = new Map()
const lobbyMeta = new Map() // keep track of lobby metadata like password

const geoip = require('fast-geoip')

async function getGeoLocation(req) {
    console.log(req.socket.remoteAddress)
    const ip = req.socket.remoteAddress
    const geo = await geoip.lookup(ip)
    console.log(geo)
    // after this lets update the user via firebase with last known country code and ping
}

wss.on('connection', (ws, req) => {
    let user

    getGeoLocation(req)
    // get the geo location based on websocket ip

    ws.on('message', async (message, req) => {
        const data = JSON.parse(message)

        if (data.type === 'join') {
            user = data.user

            if (!connectedUsers.has(user.uid)) {
                connectedUsers.set(user.uid, { ...user, ws })

                // Optionally, auto-join a default lobby
                const defaultLobbyId = 'Hyper Reflector'
                if (!lobbies.has(defaultLobbyId)) {
                    lobbies.set(defaultLobbyId, new Map())
                }
                lobbies.get(defaultLobbyId).set(user.uid, { ...user, ws })
                broadcastUserList(defaultLobbyId)
            }

            ws.send(
                JSON.stringify({
                    type: 'connected-users',
                    users: [...connectedUsers.values()].map(({ ws, ...user }) => user),
                })
            )
        }

        if (data.type === 'createLobby') {
            const { lobbyId, pass, user, private } = data

            if (lobbies.has(lobbyId)) {
                ws.send(
                    JSON.stringify({
                        type: 'error',
                        message: 'Lobby already exists',
                    })
                )
                return
            }

            removeUserFromAllLobbies(user.uid)

            lobbies.set(lobbyId, new Map())
            lobbies.get(lobbyId).set(user.uid, { ...user, ws })

            lobbyMeta.set(lobbyId, { pass, private })

            if (lobbyTimeouts.has(lobbyId)) {
                clearTimeout(lobbyTimeouts.get(lobbyId))
                lobbyTimeouts.delete(lobbyId)
            }

            broadcastUserList(lobbyId)

            ws.send(
                JSON.stringify({
                    type: 'lobby-joined',
                    lobbyId,
                })
            )
            broadcastLobbyUserCounts()
        }

        if (data.type === 'changeLobby') {
            const { newLobbyId, pass, user } = data

            const meta = lobbyMeta.get(newLobbyId)
            if (meta && meta.pass !== pass) {
                console.log('failed pass check', meta.pass, pass)
                ws.send(
                    JSON.stringify({
                        type: 'error',
                        message: 'Invalid password for lobby',
                    })
                )
                return
            }

            if (!user) return

            console.log('changing lobby bp 1')
            removeUserFromAllLobbies(user.uid)

            // make sure we clear timeouts when we start the new lobby
            if (lobbyTimeouts.has(newLobbyId)) {
                clearTimeout(lobbyTimeouts.get(newLobbyId))
                lobbyTimeouts.delete(newLobbyId)
            }

            console.log('changing lobby bp 2')
            if (!lobbies.has(newLobbyId)) {
                lobbies.set(newLobbyId, new Map())
            }
            console.log('changing lobby bp 3')
            lobbies.get(newLobbyId).set(user.uid, { ...user, ws })
            broadcastUserList(newLobbyId)
            broadcastLobbyUserCounts()
            console.log('changing lobby bp 4')
        }

        if (data.type === 'userDisconnect') {
            broadcastKillPeer(user.uid)
        }

        if (data.type === 'sendMessage') {
            broadCastUserMessage(data)
        }

        if (data.type === 'callUser') {
            const { callerId, calleeId, localDescription } = data.data
            //console.log(connectedUsers)
            console.log('data - ', data)
            console.log('socket recieved request to call from - ', callerId, ' to ', calleeId)
            if (connectedUsers.has(calleeId)) {
                console.log('sending a call off to user', calleeId)
                // get the user we are calling from the user list
                const callee = connectedUsers.get(calleeId)
                callee.ws.send(
                    JSON.stringify({ type: 'incomingCall', callerId, offer: localDescription })
                ) // local description is the offer
            } else {
                ws.send(JSON.stringify({ type: 'error', message: 'user not online' }))
            }
        }

        // handle user answer call
        if (data.type === 'answerCall') {
            console.log('socket call request was answered')
            const { callerId, answer, answererId } = data.data
            if (connectedUsers.has(callerId)) {
                // if caller exists we get them by id from user list
                const caller = connectedUsers.get(callerId)
                caller.ws.send(
                    JSON.stringify({ type: 'callAnswered', callerId, answer, answererId })
                )
            }
        }

        //handle decline a call
        if (data.type === 'declineCall') {
            console.log('socket call request was decline')
            const { callerId, answererId } = data.data
            if (connectedUsers.has(callerId)) {
                // if caller exists we get them by id from user list
                const caller = connectedUsers.get(callerId)
                caller.ws.send(JSON.stringify({ type: 'callDeclined', callerId, answererId }))
            }
        }

        // handle ice candidate exchanging
        if (data.type === 'iceCandidate') {
            const { fromUID, toUID, candidate } = data.data
            console.log('we got an ice candidate', toUID, candidate)
            if (connectedUsers.has(toUID)) {
                const targetUser = connectedUsers.get(toUID)
                targetUser.ws.send(JSON.stringify({ type: 'iceCandidate', candidate, fromUID }))
            }
        }

        if (data.type === 'sendStunOverSocket') {
            const { opponentId } = data
            console.log('send stun over socket: ', data)
            console.log(connectedUsers)
            if (connectedUsers.has(opponentId)) {
                console.log('user found, sending data')
                const targetUser = connectedUsers.get(opponentId)
                targetUser.ws.send(
                    JSON.stringify({ type: 'receiveHolePunchStun', data: data.data })
                )
            }
        }

        // We can send a message to end a match to another user, say if the emulator crashes or we close it etc.
        if (data.type === 'matchEnd') {
            disconnectUserFromUsers(data.userUID)
        }

        // ping manager stuff

        if (data.type === 'webrtc-ping-offer') {
            const { to, from, offer } = data
            if (to === from) return
            console.log('sending offer', to)
            if (connectedUsers.has(to)) {
                const targetUser = connectedUsers.get(to)
                targetUser.ws.send(JSON.stringify({ type: 'webrtc-ping-offer', offer, from }))
            }
        }

        if (data.type === 'webrtc-ping-answer') {
            const { to, from, answer } = data
            console.log('we are sending an asnwer', data)
            if (to === from) return
            console.log('sending answer', to)
            if (connectedUsers.has(to)) {
                const targetUser = connectedUsers.get(to)
                targetUser.ws.send(JSON.stringify({ type: 'webrtc-ping-answer', answer, from }))
            }
        }

        if (data.type === 'webrtc-ping-candidate') {
            const { to, from, candidate } = data
            if (to === from) return
            console.log('we got an ice candidate', to, candidate)
            if (connectedUsers.has(to)) {
                const targetUser = connectedUsers.get(to)
                targetUser.ws.send(
                    JSON.stringify({ type: 'webrtc-ping-candidate', candidate, from })
                )
            }
        }
    })

    //handle close socket
    ws.on('close', async () => {
        console.log('user disconnected', user.email)
        connectedUsers.delete(user.uid)
        removeUserFromAllLobbies(user.uid)
        const body = JSON.stringify({
            idToken: user.uid || 'not real',
            userEmail: user.email,
        })
        // if we already had a healthy websocket connection, we can try to log out if the websocket randomly closes.
        axios
            .post(`http://${serverInfo.COTURN_IP}:${serverInfo.API_PORT}/log-out-internal`, body, {
                'Content-Type': 'application/json',
            })
            .then(() => {
                console.log('User logout request completed.')
            })
            .catch((error) => {
                console.error('Error logging out user:', error.message)
            })
        // broadcastUserList()
        // we should automagically log the user out here if anything abruptly happens.
    })
})

function broadcastKillPeer(userUID) {
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

//broadcast user counts every 15 seconds
setInterval(broadcastLobbyUserCounts, 15000)

function broadCastUserMessage(messageData) {
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

function disconnectUserFromUsers(userUID) {
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'matchEndedClose', userUID }))
        }
    })
}

function getLobbyUsers(lobbyId) {
    const lobby = lobbies.get(lobbyId)
    return lobby ? [...lobby.values()] : []
}

function broadcastLobbyUserCounts() {
    let updates = []

    for (const [lobbyId, users] of lobbies.entries()) {
        const meta = lobbyMeta.get(lobbyId)
        console.log('lobby meta data', meta)
        updates.push({
            name: lobbyId,
            users: users.size,
            pass: meta?.pass || '',
            private: meta?.private || false,
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

function broadcastUserList(lobbyId) {
    const lobby = lobbies.get(lobbyId)
    if (!lobby) return

    const users = getLobbyUsers(lobbyId).map(({ ws, ...rest }) => rest)

    for (const user of lobby.values()) {
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
function removeUserFromAllLobbies(uid) {
    for (const [lobbyId, users] of lobbies.entries()) {
        if (users.has(uid)) {
            users.delete(uid)

            if (users.size === 0 && lobbyId !== 'Hyper Reflector') {
                if (!lobbyTimeouts.has(lobbyId)) {
                    const timeout = setTimeout(() => {
                        lobbies.delete(lobbyId)
                        lobbyTimeouts.delete(lobbyId)

                        broadcastLobbyRemoved(lobbyId)
                        console.log(`Lobby ${lobbyId} closed due to inactivity`)
                        broadcastLobbyUserCounts()
                    }, 30000)

                    lobbyTimeouts.set(lobbyId, timeout)
                }
            } else {
                broadcastUserList(lobbyId)
            }
        }
    }
}

function broadcastLobbyRemoved(lobbyId) {
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

console.log('WebSocket signaling server running on port 3003...')
