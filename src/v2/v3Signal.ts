// This is the signalling server used by coturn and the front end application to handle handshaking / making inital RTC call
// This has also been coopted to handle all websocket related stuff on the front end.
import { getGeoLocation, handleEstimatePing, extractClientIp } from './websockets/ping'
import { connectedUsers, lobbies, lobbyTimeouts, lobbyMeta } from './websockets/maps'
import {
    broadCastUserMessage,
    disconnectUserFromUsers,
    broadcastLobbyUserCounts,
    broadcastUserList,
    removeUserFromAllLobbies,
    broadcastKillPeer,
    updateLobbyData,
} from './websockets/broadcasts'
import e from 'express'
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
    let user

    ws.on('message', async (message) => {
        const data = JSON.parse(message)

        if (data.type === 'join') {
            user = data.user
            ws.uid = user.uid

            getGeoLocation(req, user, ws)

            if (!connectedUsers.has(user.uid)) {
                connectedUsers.set(user.uid, { ...user, ws })

                // auto join the default lobby
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
            const { data: updateData } = data;
            const userToUpdate = connectedUsers.get(updateData.uid);
            console.log('userToUpdate', userToUpdate)

            if (!userToUpdate) {
                console.warn(`No user found for UID ${updateData.uid}`);
                return;
            }

            let updatedUser;

            if (updateData.stateToUpdate.key === 'winStreak') {
                const currentStreak = userToUpdate.winStreak || 0;
                console.log(currentStreak)

                if (updateData.stateToUpdate.value === 1) {
                    console.log('streak increase', currentStreak)
                    updatedUser = {
                        winStreak: currentStreak + 1,
                    };
                } else {
                    updatedUser = {
                        winStreak: 0,
                    };
                }
            } else {
                updatedUser = {
                    [updateData.stateToUpdate.key]: updateData.stateToUpdate.value,
                };
            }

            connectedUsers.set(updateData.uid, {
                ...userToUpdate,
                ...updatedUser,
                ws: userToUpdate.ws,
            });

            console.log('update socket state data', updateData);
            updateLobbyData(updateData);
        }

        if (data.type === 'createLobby') {
            const { lobbyId, pass, user, isPrivate } = data

            if (lobbies.has(lobbyId)) {
                ws.send(
                    JSON.stringify({
                        type: 'error',
                        message: 'Lobby already exists',
                    })
                )
                return
            }

            removeUserFromAllLobbies(user.uid, wss)

            lobbies.set(lobbyId, new Map())
            lobbies.get(lobbyId).set(user.uid, { ...user, ws })

            lobbyMeta.set(lobbyId, { pass, isPrivate })

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
            broadcastLobbyUserCounts(wss)
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
            removeUserFromAllLobbies(user.uid, wss)

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
            broadcastLobbyUserCounts(wss)
        }

        if (data.type === 'userDisconnect') {
            broadcastKillPeer(user.uid, wss)
        }

        if (data.type === 'sendMessage') {
            broadCastUserMessage(data)
        }

        // We can send a message to end a match to another user, say if the emulator crashes or we close it etc.
        if (data.type === 'matchEnd') {
            disconnectUserFromUsers(data.userUID, wss)
        }

        if (data.type === 'webrtc-ping-offer') {
            const { to, from, offer } = data
            if (to === from) return
            if (connectedUsers.has(to)) {
                const targetUser = connectedUsers.get(to)
                targetUser.ws.send(JSON.stringify({ type: 'webrtc-ping-offer', offer, from }))
            }
        }

        if (data.type === 'webrtc-ping-answer') {
            const { to, from, answer } = data
            if (to === from) return
            if (connectedUsers.has(to)) {
                const targetUser = connectedUsers.get(to)
                targetUser.ws.send(JSON.stringify({ type: 'webrtc-ping-answer', answer, from }))
            }
        }

        //handle decline a call
        if (data.type === 'webrtc-ping-decline') {
            const { to, from } = data
            if (to === from) return
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
        removeUserFromAllLobbies(user.uid, wss)
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

//broadcast user counts every 15 seconds
setInterval(broadcastLobbyUserCounts, 15000)
