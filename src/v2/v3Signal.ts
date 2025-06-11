// This is the signalling server used by coturn and the front end application to handle handshaking / making inital RTC call
// This has also been coopted to handle all websocket related stuff on the front end.

const WebSocket = require('ws')
const axios = require('axios')
const serverInfo = require('../../keys/server.ts')
const geoip = require('fast-geoip')
const geolib = require('geolib')

const wss = new WebSocket.Server({ port: 3003 })
const connectedUsers = new Map()
const lobbies = new Map()
const lobbyTimeouts = new Map()
const lobbyMeta = new Map() // keep track of lobby metadata like password

// function findBestPeer(userId) {
//     const user = connectedUsers[userId]
//     let bestPeer = null
//     let lowestPing = Infinity

//     for (const [peerId, peer] of Object.entries(connectedUsers)) {
//       if (peerId === userId) continue
//       const ping = user.lastKnownPings[peerId] || estimatePing(user.geo, peer.geo)
//       if (ping < lowestPing) {
//         bestPeer = peerId
//         lowestPing = ping
//       }
//     }

//     return bestPeer
//   }

async function handleEstimatePing(data, ws) {
    const { data: userData } = data
    if (!userData.userA || !userData.userB) return

    const userAResponse = await axios.post(
        `http://${serverInfo.COTURN_IP}:${serverInfo.API_PORT}/get-user-server`,
        { userUID: userData.userA.id },
        {
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${serverInfo.SERVER_SECRET}`,
            },
        }
    )

    const userA = userAResponse.data
    const userB = connectedUsers.get(userData.userB.id)?.userData
    if (!userA?.pingLat || !userB?.pingLat) return

    let distance = 1
    try {
        distance = geolib.getDistance(
            { latitude: userA.pingLat, longitude: userA.pingLon },
            { latitude: userB.pingLat, longitude: userB.pingLon }
        )
    } catch (error) {
        console.error('geolib error:', error)
    }

    const estimatedRTT = Math.round(distance / 1000 / 200 + 20)
    const existingPings = Array.isArray(userA.lastKnownPings) ? userA.lastKnownPings : []
    const filteredPings = existingPings.filter((p) => p.id !== userData.userB.id)
    const updatedPings = [
        ...filteredPings,
        {
            id: userData.userB.id,
            ping: `${estimatedRTT}`,
            isUnstable: userData.userB.stability,
        },
    ]

    const body = {
        userData: {
            lastKnownPings: updatedPings,
        },
        uid: userData.userA.id,
    }

    try {
        await axios.post(
            `http://${serverInfo.COTURN_IP}:${serverInfo.API_PORT}/update-user-ping`,
            body,
            {
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${serverInfo.SERVER_SECRET}`,
                },
            }
        )
    } catch (err) {
        console.error('Failed to update user ping:', err)
        return
    }

    if (ws.uid === userData.userA.id) {
        ws.send(JSON.stringify({ type: 'update-user-pinged', data: body.userData }))
    }
}

function getPeerPingsForUser(sourceUser) {
    const results = []

    for (const [id, targetUser] of connectedUsers.entries()) {
        if (id === sourceUser.uid) continue

        if (
            !targetUser.pingLat ||
            !targetUser.pingLon ||
            !sourceUser.pingLat ||
            !sourceUser.pingLon
        ) {
            continue
        }

        const distance = geolib.getDistance(
            { latitude: sourceUser.pingLat, longitude: sourceUser.pingLon },
            { latitude: targetUser.pingLat, longitude: targetUser.pingLon }
        )

        const distanceKm = distance / 1000
        const estimatedRTT = Math.round(distanceKm / 200 + 20)

        results.push({
            id: targetUser.uid,
            ping: estimatedRTT,
            isUnstable: targetUser.stability ?? false,
            countryCode: targetUser.countryCode ?? 'xx',
        })
    }

    return results
}

async function getGeoLocation(req, user, ws) {
    const ip = req?.socket?.remoteAddress?.split('::ffff:')[1] || '127.0.0.1'
    if (!ip) {
        console.log('failed to get ip string')
        return
    }
    const geo = await geoip.lookup(ip)
    const userGeoData = {
        pingLat: geo.ll[0],
        pingLon: geo.ll[1],
        countryCode: geo.country || 'xx',
    }
    const body = {
        userData: userGeoData,
        uid: user.uid,
    }

    try {
        await axios.post(
            `http://${serverInfo.COTURN_IP}:${serverInfo.API_PORT}/update-user-ping`,
            body,
            {
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${serverInfo.SERVER_SECRET}`,
                },
            }
        )
    } catch (error) {
        console.error('Geo update failed:', error)
    }

    const updatedUser = {
        ...user,
        ...userGeoData,
    }
    connectedUsers.set(user.uid, { ws, ...updatedUser })

    const peerPings = getPeerPingsForUser(updatedUser)

    if (ws.uid === user.uid) {
        ws.send(
            JSON.stringify({
                type: 'update-user-pinged',
                data: { ...userGeoData, lastKnownPings: peerPings },
            })
        )
        // send ping out to every other user
        for (const peer of peerPings) {
            const peerConn = connectedUsers.get(peer.id)
            if (!peerConn || !peerConn.ws) continue

            const reversePing = {
                isNewPing: true, // we use this to sift on the front end and make the update.
                id: updatedUser.uid,
                ping: peer.ping,
                countryCode: updatedUser.countryCode || 'xx',
                isUnstable: updatedUser.stability ?? false,
            }

            peerConn.ws.send(
                JSON.stringify({
                    type: 'update-user-pinged',
                    data: reversePing,
                })
            )
        }
    }
}

wss.on('connection', (ws, req) => {
    let user

    // get the geo location based on websocket ip

    ws.on('message', async (message) => {
        const data = JSON.parse(message)

        if (data.type === 'join') {
            user = data.user
            ws.uid = user.uid
            getGeoLocation(req, user, ws)

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

        if (data.type === 'updateSocketState') {
            console.log('user updating state')
            const userToUpdate = connectedUsers.get(data.uid)
            const updatedUser = {
                ...userToUpdate,
                ...data.stateToUpdate,
            }
            connectedUsers.set(data.uid, { ws, ...updatedUser })
            console.log(connectedUsers)
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
                ws.send(
                    JSON.stringify({
                        type: 'error',
                        message: 'Invalid password for lobby',
                    })
                )
                return
            }

            if (!user) return
            removeUserFromAllLobbies(user.uid)

            // make sure we clear timeouts when we start the new lobby
            if (lobbyTimeouts.has(newLobbyId)) {
                clearTimeout(lobbyTimeouts.get(newLobbyId))
                lobbyTimeouts.delete(newLobbyId)
            }

            if (!lobbies.has(newLobbyId)) {
                lobbies.set(newLobbyId, new Map())
            }
            lobbies.get(newLobbyId).set(user.uid, { ...user, ws })
            broadcastUserList(newLobbyId)
            broadcastLobbyUserCounts()
        }

        if (data.type === 'userDisconnect') {
            broadcastKillPeer(user.uid)
        }

        if (data.type === 'sendMessage') {
            broadCastUserMessage(data)
        }

        // We can send a message to end a match to another user, say if the emulator crashes or we close it etc.
        if (data.type === 'matchEnd') {
            disconnectUserFromUsers(data.userUID)
        }

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
            console.log('we are sending an answer message', data)
            if (to === from) return
            console.log('sending answer', to)
            if (connectedUsers.has(to)) {
                const targetUser = connectedUsers.get(to)
                targetUser.ws.send(JSON.stringify({ type: 'webrtc-ping-answer', answer, from }))
            }
        }

        //handle decline a call
        if (data.type === 'webrtc-ping-decline') {
            const { to, from } = data
            console.log('we are sending a decline message', data)
            if (to === from) return
            console.log('sending decline', to)
            if (connectedUsers.has(to)) {
                const targetUser = connectedUsers.get(to)
                targetUser.ws.send(JSON.stringify({ type: 'webrtc-ping-decline', from }))
            }
        }

        if (data.type === 'webrtc-ping-candidate') {
            const { to, from, candidate } = data
            if (to === from) return
            // console.log('we got an ice candidate', to, candidate)
            if (connectedUsers.has(to)) {
                const targetUser = connectedUsers.get(to)
                targetUser.ws.send(
                    JSON.stringify({ type: 'webrtc-ping-candidate', candidate, from })
                )
            }
        }

        // ping gathering
        if (data.type === 'estimate-ping-users') {
            console.log('users trying to ping eachother')
            handleEstimatePing(data, ws)
        }
    })

    //handle close socket
    ws.on('close', async () => {
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
