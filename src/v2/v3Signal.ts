// This is the signalling server used by coturn and the front end application to handle handshaking / making inital RTC call
// This has also been coopted to handle all websocket related stuff on the front end.
import { getGeoLocation, handleEstimatePing, extractClientIp } from './websockets/ping'
import { connectedUsers, lobbies, lobbyTimeouts, lobbyMeta, userLobby, userSockets } from './websockets/maps'
import {
    broadCastUserMessage,
    disconnectUserFromUsers,
    broadcastLobbyUserCounts,
    broadcastUserList,
    removeUserFromAllLobbies,
    broadcastKillPeer,
    updateLobbyData,
} from './websockets/broadcasts'
import { leaveAllLobbies, getLobbyMembers, getUser, setUser, joinLobby } from './websockets/utils'
const DEFAULT_LOBBY = 'Hyper Reflector'
const http = require('http')
const WebSocket = require('ws')
const axios = require('axios')
const serverInfo = require('../../keys/server.ts')

const server = http.createServer()
const wss = new WebSocket.Server({ noServer: true })

server.on('upgrade', (req, socket, head) => {
    const ip = extractClientIp(req)
    console.log('IP during upgrade:', ip)

    wss.handleUpgrade(req, socket, head, (ws) => {
        // You pass req through so it's available in your ws.on('connection')
        wss.emit('connection', ws, req)
    })
})

server.listen(3003, () => {
    console.log('Listening on port 3003')
})

wss.on('connection', (ws, req) => {
    let uid: string | null = null

    ws.on('message', async (raw) => {
        const data = JSON.parse(raw.toString())

        // ---- JOIN --------------------------------------------------------------
        if (data.type === 'join') {
            const user = data.user
            uid = user.uid
                ; (ws as any).uid = uid

            // 1) Store socket separately
            userSockets.set(uid, ws)

            // 2) Merge canonical user data
            setUser(uid, user) // keeps anything we already had (winStreak, stability, etc.)

            // 3) Auto-join default lobby
            const DEFAULT_LOBBY = 'Hyper Reflector'
            joinLobby(uid, DEFAULT_LOBBY)

            // 4) Start geo lookup (merges into canonical user + triggers per-peer pings)
            getGeoLocation(req, user, ws)

            // 5) Send lobby roster (always derived from connectedUsers)
            broadcastUserList(DEFAULT_LOBBY)

            // Optional: send this user a full snapshot of their lobby
            const uids = Array.from(lobbies.get(DEFAULT_LOBBY) ?? [])
            const users = uids
                .map(id => getUser(id as string))
                .filter(Boolean)
                .map(u => {
                    const { /* strip nothing or specific fields as needed */ ...rest } = u!
                    return rest
                })
            ws.send(JSON.stringify({ type: 'connected-users', users, count: users.length }))
            return
        }

        // ---- UPDATE SOCKET STATE ----------------------------------------------
        if (data.type === 'updateSocketState') {
            const { data: updateData } = data
            const u = getUser(updateData.uid)
            if (!u) {
                console.warn(`No user found for UID ${updateData.uid}`)
                return
            }

            let patch: any = {}
            if (updateData.stateToUpdate.key === 'winStreak') {
                const cur = u.winStreak ?? 0
                patch.winStreak = updateData.stateToUpdate.value === 1 ? cur + 1 : 0
            } else {
                patch[updateData.stateToUpdate.key] = updateData.stateToUpdate.value
            }

            const next = setUser(updateData.uid, patch)

            // broadcast to that user's current lobby
            const lobbyId = next.lobbyId || 'Hyper Reflector'
            broadcastUserList(lobbyId)

            // notify DB (best-effort)
            try {
                await axios.post(
                    `http://${serverInfo.COTURN_IP}:${serverInfo.API_PORT}/update-user-data-socket`,
                    { userData: patch, uid: updateData.uid },
                    {
                        headers: {
                            'Content-Type': 'application/json',
                            Authorization: `Bearer ${serverInfo.SERVER_SECRET}`,
                        },
                    }
                )
            } catch (err) {
                console.error('Failed to update user from socket server:', err)
            }
            return
        }

        // ---- CREATE LOBBY ------------------------------------------------------
        if (data.type === 'createLobby') {
            const { lobbyId, pass, user, isPrivate } = data

            if (lobbies.has(lobbyId)) {
                ws.send(JSON.stringify({ type: 'error', message: 'Lobby already exists' }))
                return
            }

            removeUserFromAllLobbies(user.uid, wss) // leaves current lobby (if any)
            // create + join
            if (!lobbies.has(lobbyId)) lobbies.set(lobbyId, new Set())
            lobbies.get(lobbyId)!.add(user.uid)
            userLobby.set(user.uid, lobbyId)
            setUser(user.uid, { lobbyId })

            lobbyMeta.set(lobbyId, { pass, isPrivate })

            // clear any pending close timer
            if (lobbyTimeouts.has(lobbyId)) {
                clearTimeout(lobbyTimeouts.get(lobbyId)!)
                lobbyTimeouts.delete(lobbyId)
            }

            broadcastUserList(lobbyId)
            ws.send(JSON.stringify({ type: 'lobby-joined', lobbyId }))
            broadcastLobbyUserCounts(wss)
            return
        }

        // ---- CHANGE LOBBY ------------------------------------------------------
        if (data.type === 'changeLobby') {
            const { newLobbyId, pass, user } = data
            if (!user) return

            const meta = lobbyMeta.get(newLobbyId)
            if (meta && meta.pass !== pass) {
                ws.send(JSON.stringify({ type: 'error', message: 'Invalid password for lobby' }))
                return
            }

            removeUserFromAllLobbies(user.uid, wss)

            if (lobbyTimeouts.has(newLobbyId)) {
                clearTimeout(lobbyTimeouts.get(newLobbyId)!)
                lobbyTimeouts.delete(newLobbyId)
            }

            if (!lobbies.has(newLobbyId)) lobbies.set(newLobbyId, new Set())
            lobbies.get(newLobbyId)!.add(user.uid)
            userLobby.set(user.uid, newLobbyId)
            setUser(user.uid, { lobbyId: newLobbyId })

            broadcastUserList(newLobbyId)
            broadcastLobbyUserCounts(wss)
            return
        }

        // ---- USER DISCONNECT (soft) -------------------------------------------
        if (data.type === 'userDisconnect') {
            if (!uid) return
            broadcastKillPeer(uid, wss)
            return
        }

        // ---- CHAT --------------------------------------------------------------
        if (data.type === 'sendMessage') {
            broadCastUserMessage(data)
            return
        }

        // ---- MATCH END ---------------------------------------------------------
        if (data.type === 'matchEnd') {
            disconnectUserFromUsers(data.userUID, wss)
            return
        }

        // ---- WEBRTC RELAY ------------------------------------------------------
        if (data.type === 'webrtc-ping-offer') {
            const { to, from, offer } = data
            if (to === from) return
            const target = userSockets.get(to)
            if (target && target.readyState === WebSocket.OPEN) {
                target.send(JSON.stringify({ type: 'webrtc-ping-offer', offer, from }))
            }
            return
        }

        if (data.type === 'webrtc-ping-answer') {
            const { to, from, answer } = data
            if (to === from) return
            const target = userSockets.get(to)
            if (target && target.readyState === WebSocket.OPEN) {
                target.send(JSON.stringify({ type: 'webrtc-ping-answer', answer, from }))
            }
            return
        }

        if (data.type === 'webrtc-ping-decline') {
            const { to, from } = data
            if (to === from) return
            const target = userSockets.get(to)
            if (target && target.readyState === WebSocket.OPEN) {
                target.send(JSON.stringify({ type: 'webrtc-ping-decline', from }))
            }
            return
        }

        if (data.type === 'webrtc-ping-candidate') {
            const { to, from, candidate } = data
            if (to === from) return
            const target = userSockets.get(to)
            if (target && target.readyState === WebSocket.OPEN) {
                target.send(JSON.stringify({ type: 'webrtc-ping-candidate', candidate, from }))
            }
            return
        }

        // ---- PING ESTIMATION ---------------------------------------------------
        if (data.type === 'estimate-ping-users') {
            handleEstimatePing(data, ws)
            return
        }
    })

    // ---- CLOSE SOCKET (hard) -------------------------------------------------
    ws.on('close', async () => {
        if (!uid) return
        userSockets.delete(uid)
        leaveAllLobbies(uid)          // removes from lobby Set and userLobby
        connectedUsers.delete(uid)    // drop canonical user (or keep if you want sticky state)
        broadcastLobbyUserCounts(wss)

        // best-effort logout
        const body = JSON.stringify({
            idToken: uid || 'not real',
            userEmail: getUser(uid)?.email,
        })
        try {
            await axios.post(
                `http://${serverInfo.COTURN_IP}:${serverInfo.API_PORT}/log-out-internal`,
                body,
                { 'Content-Type': 'application/json' }
            )
        } catch (error: any) {
            console.error('Error logging out user:', error?.message)
        }
    })
})


// wss.on('connection', (ws, req) => {
//     let uid: string | undefined

//     ws.on('message', async (raw) => {
//         const data = JSON.parse(raw.toString())

//         if (data.type === 'join') {
//             const user = data.user
//             uid = user.uid

//             // store socket
//             userSockets.set(uid, ws)

//             // set canonical user (merge)
//             setUser(uid, user)

//             // geo updates will later call setUser(uid, geoPatch) (see below)
//             // and then we rebroadcast

//             // join default lobby
//             joinLobby(uid, DEFAULT_LOBBY)

//             // send that lobby’s user list using canonical users
//             broadcastUserList(DEFAULT_LOBBY)

//             // (optional) also send full connected list to this user alone if needed
//             ws.send(JSON.stringify({
//                 type: 'connected-users',
//                 users: getLobbyMembers(DEFAULT_LOBBY).map(id => connectedUsers.get(id)).filter(Boolean),
//             }))
//         }

//         // updates like winStreak or stability:
//         if (data.type === 'updateSocketState') {
//             const { uid, lobbyId, stateToUpdate } = data.data
//             const patch = stateToUpdate.key === 'winStreak'
//                 ? { winStreak: (getUser(uid)?.winStreak ?? 0) + (stateToUpdate.value === 1 ? 1 : -Infinity) }
//                 : { [stateToUpdate.key]: stateToUpdate.value }

//             // normalize winStreak (no negative)
//             if ('winStreak' in patch && (patch.winStreak as number) < 0) patch.winStreak = 0

//             setUser(uid, patch)

//             // broadcast to that lobby using the canonical user map
//             const targetLobby = lobbyId || getUser(uid)?.lobbyId || DEFAULT_LOBBY
//             broadcastUserList(targetLobby)
//         }

//         // lobby changes:
//         if (data.type === 'changeLobby') {
//             const { newLobbyId, pass, user } = data
//             // validate pass...
//             joinLobby(user.uid, newLobbyId)
//             broadcastUserList(newLobbyId)
//             broadcastLobbyUserCounts(wss)
//         }
//     })
//     ws.on('close', () => {
//         if (!uid) return
//         userSockets.delete(uid)
//         leaveAllLobbies(uid)
//         broadcastLobbyUserCounts(wss)

//         // optional: also remove from connectedUsers or keep for reconnection
//         connectedUsers.delete(uid)
//     })
// })

// wss.on('connection', (ws, req) => {
//     let user

//     ws.on('message', async (message) => {
//         const data = JSON.parse(message)

//         if (data.type === 'join') {
//             user = data.user
//             ws.uid = user.uid

//             getGeoLocation(req, user, ws)

//             if (!connectedUsers.has(user.uid)) {
//                 connectedUsers.set(user.uid, { ...user, ws })

//                 // auto join the default lobby
//                 const defaultLobbyId = 'Hyper Reflector'
//                 if (!lobbies.has(defaultLobbyId)) {
//                     lobbies.set(defaultLobbyId, new Map())
//                 }
//                 lobbies.get(defaultLobbyId).set(user.uid, { ...user, ws })
//                 broadcastUserList(defaultLobbyId)
//             }



//             ws.send(
//                 JSON.stringify({
//                     type: 'connected-users',
//                     users: [...connectedUsers.values()].map(({ ws, ...user }) => user),
//                 })
//             )
//         }

//         if (data.type === 'updateSocketState') {
//             const { data: updateData } = data;
//             const userToUpdate = connectedUsers.get(updateData.uid);
//             console.log('userToUpdate', userToUpdate)

//             if (!userToUpdate) {
//                 console.warn(`No user found for UID ${updateData.uid}`);
//                 return;
//             }

//             let updatedUser;

//             if (updateData.stateToUpdate.key === 'winStreak') {
//                 const currentStreak = userToUpdate.winStreak || 0;
//                 console.log(currentStreak)

//                 if (updateData.stateToUpdate.value === 1) {
//                     console.log('streak increase', currentStreak)
//                     updatedUser = {
//                         winStreak: currentStreak + 1,
//                     };
//                 } else {
//                     updatedUser = {
//                         winStreak: 0,
//                     };
//                 }
//             } else {
//                 updatedUser = {
//                     [updateData.stateToUpdate.key]: updateData.stateToUpdate.value,
//                 };
//             }

//             connectedUsers.set(updateData.uid, {
//                 ...userToUpdate,
//                 ...updatedUser,
//                 ws: userToUpdate.ws,
//             });

//             const newUpdateData = {
//                 ...updateData,
//                 stateToUpdate: { key: updateData.stateToUpdate.key, value: updatedUser[updateData.stateToUpdate.key] } // get the new value and set it
//             }
//             console.log('update socket state data', newUpdateData, updateData);
//             updateLobbyData(newUpdateData);

//             // if we want to we can call the server and update it
//             const body = {
//                 userData: updatedUser,
//                 uid: updateData.uid,
//             }

//             try {
//                 await axios.post(
//                     `http://${serverInfo.COTURN_IP}:${serverInfo.API_PORT}/update-user-data-socket`,
//                     body,
//                     {
//                         headers: {
//                             'Content-Type': 'application/json',
//                             Authorization: `Bearer ${serverInfo.SERVER_SECRET}`,
//                         },
//                     }
//                 )
//             } catch (err) {
//                 console.error('Failed to update user from socket server:', err)
//                 return
//             }
//         }

//         if (data.type === 'createLobby') {
//             const { lobbyId, pass, user, isPrivate } = data

//             if (lobbies.has(lobbyId)) {
//                 ws.send(
//                     JSON.stringify({
//                         type: 'error',
//                         message: 'Lobby already exists',
//                     })
//                 )
//                 return
//             }

//             removeUserFromAllLobbies(user.uid, wss)

//             lobbies.set(lobbyId, new Map())
//             lobbies.get(lobbyId).set(user.uid, { ...user, ws })

//             lobbyMeta.set(lobbyId, { pass, isPrivate })

//             if (lobbyTimeouts.has(lobbyId)) {
//                 clearTimeout(lobbyTimeouts.get(lobbyId))
//                 lobbyTimeouts.delete(lobbyId)
//             }

//             broadcastUserList(lobbyId)

//             ws.send(
//                 JSON.stringify({
//                     type: 'lobby-joined',
//                     lobbyId,
//                 })
//             )
//             broadcastLobbyUserCounts(wss)
//         }

//         if (data.type === 'changeLobby') {
//             const { newLobbyId, pass, user } = data

//             const meta = lobbyMeta.get(newLobbyId)
//             if (meta && meta.pass !== pass) {
//                 ws.send(
//                     JSON.stringify({
//                         type: 'error',
//                         message: 'Invalid password for lobby',
//                     })
//                 )
//                 return
//             }

//             if (!user) return
//             removeUserFromAllLobbies(user.uid, wss)

//             // make sure we clear timeouts when we start the new lobby
//             if (lobbyTimeouts.has(newLobbyId)) {
//                 clearTimeout(lobbyTimeouts.get(newLobbyId))
//                 lobbyTimeouts.delete(newLobbyId)
//             }

//             if (!lobbies.has(newLobbyId)) {
//                 lobbies.set(newLobbyId, new Map())
//             }
//             lobbies.get(newLobbyId).set(user.uid, { ...user, ws })
//             broadcastUserList(newLobbyId)
//             broadcastLobbyUserCounts(wss)
//         }

//         if (data.type === 'userDisconnect') {
//             broadcastKillPeer(user.uid, wss)
//         }

//         if (data.type === 'sendMessage') {
//             broadCastUserMessage(data)
//         }

//         // We can send a message to end a match to another user, say if the emulator crashes or we close it etc.
//         if (data.type === 'matchEnd') {
//             disconnectUserFromUsers(data.userUID, wss)
//         }

//         if (data.type === 'webrtc-ping-offer') {
//             const { to, from, offer } = data
//             if (to === from) return
//             if (connectedUsers.has(to)) {
//                 const targetUser = connectedUsers.get(to)
//                 targetUser.ws.send(JSON.stringify({ type: 'webrtc-ping-offer', offer, from }))
//             }
//         }

//         if (data.type === 'webrtc-ping-answer') {
//             const { to, from, answer } = data
//             if (to === from) return
//             if (connectedUsers.has(to)) {
//                 const targetUser = connectedUsers.get(to)
//                 targetUser.ws.send(JSON.stringify({ type: 'webrtc-ping-answer', answer, from }))
//             }
//         }

//         //handle decline a call
//         if (data.type === 'webrtc-ping-decline') {
//             const { to, from } = data
//             if (to === from) return
//             if (connectedUsers.has(to)) {
//                 const targetUser = connectedUsers.get(to)
//                 targetUser.ws.send(JSON.stringify({ type: 'webrtc-ping-decline', from }))
//             }
//         }

//         if (data.type === 'webrtc-ping-candidate') {
//             const { to, from, candidate } = data
//             if (to === from) return
//             // console.log('we got an ice candidate', to, candidate)
//             if (connectedUsers.has(to)) {
//                 const targetUser = connectedUsers.get(to)
//                 targetUser.ws.send(
//                     JSON.stringify({ type: 'webrtc-ping-candidate', candidate, from })
//                 )
//             }
//         }

//         // ping gathering
//         if (data.type === 'estimate-ping-users') {
//             console.log('users trying to ping eachother')
//             handleEstimatePing(data, ws)
//         }
//     })

//     //handle close socket
//     ws.on('close', async () => {
//         connectedUsers.delete(user.uid)
//         removeUserFromAllLobbies(user.uid, wss)
//         const body = JSON.stringify({
//             idToken: user.uid || 'not real',
//             userEmail: user.email,
//         })
//         // if we already had a healthy websocket connection, we can try to log out if the websocket randomly closes.
//         axios
//             .post(`http://${serverInfo.COTURN_IP}:${serverInfo.API_PORT}/log-out-internal`, body, {
//                 'Content-Type': 'application/json',
//             })
//             .then(() => {
//                 console.log('User logout request completed.')
//             })
//             .catch((error) => {
//                 console.error('Error logging out user:', error.message)
//             })
//         // broadcastUserList()
//         // we should automagically log the user out here if anything abruptly happens.
//     })
// })

//broadcast user counts every 15 seconds
setInterval(broadcastLobbyUserCounts, 15000)
