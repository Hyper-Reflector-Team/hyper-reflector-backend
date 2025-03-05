// This is the signalling server used by coturn and the front end application to handle handshaking / making inital RTC call
// This has also been coopted to handle all websocket related stuff on the front end.

const WebSocket = require('ws')
const axios = require('axios')
const serverInfo = require('./keys/server.ts')

const wss = new WebSocket.Server({ port: 3000 })

const connectedUsers = new Map()

wss.on('connection', (ws) => {
    let user

    ws.on('message', (message) => {
        const data = JSON.parse(message)

        if (data.type === 'join') {
            user = data.user // set the users info on connect
            console.log('user connected - ', user.email)
            if (!connectedUsers.has(user.uid)) {
                connectedUsers.set(user.uid, { ...user, ws })
                // send over user list to everyon.
                broadcastUserList()
            } else {
                console.log('User already exists')
            }

            ws.send(
                JSON.stringify({
                    type: 'connected-users',
                    users: [...connectedUsers.values()].map(({ ws, ...user }) => user),
                })
            )
        }

        if (data.type === 'userDisconnect') {
            broadcastKillPeer(user.uid)
        }

        if (data.type === 'sendMessage') {
            broadCastUserMessage(data)
        }

        // handle user making call
        if (data.type === 'callUser') {
            const { callerId, calleeId, localDescription } = data.data
            console.log(connectedUsers)
            console.log('data - ', data)
            console.log('socket recieved request to call from - ', callerId, ' to ', calleeId)
            if (connectedUsers.has(calleeId)) {
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
                    JSON.stringify({ type: 'callAnswered', data: { callerId, answer, answererId } })
                )
            }
        }

        // handle ice candidate exchanging
        if (data.type === 'iceCandidate') {
            const { targetId, candidate, callerId } = data.data
            console.log('we got an ice candidate', targetId, candidate)
            if (connectedUsers.has(targetId)) {
                const targetUser = connectedUsers.get(targetId)
                targetUser.ws.send(
                    JSON.stringify({ type: 'iceCandidate', data: { candidate, userUID: callerId } })
                )
            }
        }
    })

    //handle close socket
    ws.on('close', async () => {
        console.log('user disconnected', user.email)
        connectedUsers.delete(user.uid)
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
        broadcastUserList()
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

function broadcastUserList() {
    const userList = [...connectedUsers.values()].map(({ ws, ...user }) => user)
    // Broadcast message to all clients except sender
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'connected-users', users: userList }))
        }
    })
}

function broadCastUserMessage(messageData) {
    console.log(messageData)
    const userList = [...connectedUsers.values()].map(({ ws, ...user }) => user)
    // Broadcast message to all clients except sender
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            console.log(userList)
            console.log('sending to clients')
            client.send(
                JSON.stringify({
                    type: 'getRoomMessage',
                    message: messageData.message,
                    sender: messageData.sender,
                })
            )
        }
    })
}

console.log('WebSocket signaling server running on port 3000...')
