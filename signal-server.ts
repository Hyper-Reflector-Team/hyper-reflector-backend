// This is the signalling server used by coturn and the front end application to handle handshaking / making inital RTC call

const WebSocket = require('ws')

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

        // handle user making call
        if (data.type === 'callUser') {
            const { callerId, calleeId, localDescription } = data.data
            console.log(connectedUsers)
            console.log('data - ', data)
            console.log('socket recieved request to call from - ', callerId, ' to ', calleeId)
            if (connectedUsers.has(calleeId)) {
                // get the user we are calling from the user list
                const callee = connectedUsers.get(calleeId)
                callee.ws.send(JSON.stringify({ type: 'incomingCall', callerId, offer: localDescription })) // local description is the offer
            } else {
                ws.send(JSON.stringify({ type: 'error', message: 'user not online' }))
            }
        }

        // handle user answer call
        if (data.type === 'answerCall') {
            console.log('socket call request was answered')
            const { callerId, answer } = data.data
            if (connectedUsers.has(callerId)) {
                // if caller exists we get them by id from user list
                const caller = connectedUsers.get(callerId)
                caller.ws.send(JSON.stringify({ type: 'callAnswered', data: {callerId, answer} }))
            }
        }

        // handle ice candidate exchanging
        if (data.type === 'iceCandidate') {
            console.log('we got an ice candidate', data)
            const { targetId, candidate } = data
            console.log('we got an ice candidate', targetId, candidate)
            if (connectedUsers.has(targetId)) {
                const targetUser = connectedUsers.get(targetId)
                targetUser.ws.send(JSON.stringify({ type: 'iceCandidate', candidate }))
            }
        }
    })

    //handle close socket
    ws.on('close', () => {
        console.log('user disconnected', user.email)
        connectedUsers.delete(user.uid)
        broadcastUserList()
    })
})

function broadcastUserList() {
    const userList = [...connectedUsers.values()].map(({ ws, ...user }) => user)
    // Broadcast message to all clients except sender
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'connected-users', users: userList }))
        }
    })
}

console.log('WebSocket signaling server running on port 3000...')
