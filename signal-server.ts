// This is the signalling server used by coturn and the front end application to handle handshaking / making inital RTC call

const WebSocket = require('ws')

const wss = new WebSocket.Server({ port: 3000 })

const connectedUsers = new Map()

wss.on('connection', (ws) => {
    console.log('New client connected')
    let user
    ws.on('message', (message) => {
        console.log('Received:', message)

        const data = JSON.parse(message)
        if (data.type === 'join') {
            user = data.user // set the users info on connect
            if (!connectedUsers.has({ uid: user.uid })) {
                connectedUsers.set(user, ws)
            } else {
                console.log('already exists')
            }
            ws.send(
                JSON.stringify({
                    type: 'connected-users',
                    users: Array.from(new Set(connectedUsers.keys())),
                })
            )
        }

        // Broadcast message to all clients except sender
        wss.clients.forEach((client) => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
                client.send(message)
            }
        })
    })

    ws.on('close', () => {
        console.log('user disconnected', user.email)
        connectedUsers.delete(user)
    })
})

console.log('WebSocket signaling server running on port 3000...')
