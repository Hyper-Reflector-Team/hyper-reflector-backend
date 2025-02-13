const express = require('express')

const app = express()
const PORT = 7010

// Store clients temporarily (for demo purposes)
const clients = new Map()

app.use(express.json())

// Register a client and return peer info
app.post('/register', (req, res) => {
    const { id, ip, port } = req.body

    console.log(`Registering Client: ${id} at ${ip}:${port}`)

    clients.set(id, { ip, port })

    // Find another peer to connect with
    const peer = [...clients.entries()].find(([peerId]) => peerId !== id)

    if (peer) {
        const [peerId, peerData] = peer
        return res.json({ peer: peerData })
    }

    res.json({ message: 'Waiting for a peer...' })
})

app.listen(PORT, () => console.log(`Express API running on port ${PORT}`))
