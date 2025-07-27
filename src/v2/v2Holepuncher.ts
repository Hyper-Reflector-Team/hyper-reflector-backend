var dgram = require('dgram')
const { performance } = require('perf_hooks')
const { v4: uuidv4 } = require('uuid')

const HOLE_PUNCH_SERVER_PORT = 33334
var socket = dgram.createSocket('udp4')

socket.bind(HOLE_PUNCH_SERVER_PORT)

// Store users by their unique Firebase UID
var users = {}

socket.on('listening', function () {
    console.log('UDP Server listening on ' + socket.address().address + ':' + socket.address().port)
})

socket.on('message', function (message, remote) {
    console.log(remote.address + ':' + remote.port + ' - ' + message)

    try {
        let data = JSON.parse(message)
        let uid = data.uid
        let peerUid = data.peerUid

        if (!uid || !peerUid) {
            console.log('Invalid message format')
            return
        }

        if (data.kill) {
            console.log(uid, ' - ended the match removing users from pool ', uid, ' & ', peerUid)
            delete users[uid]
            delete users[peerUid]
            return
        }

        // Save or update the user's public endpoint
        users[uid] = {
            uid: uid,
            address: remote.address,
            port: remote.port,
        }

        console.log(`Stored user ${uid}: ${remote.address}:${remote.port}`)

        // If the peer is already in the list, exchange public addresses
        if (users[peerUid]) {
            sendPublicDataToClients(uid, peerUid)
        }
    } catch (err) {
        console.log('Error parsing message:', err)
    }
})


function sendPublicDataToClients(uid1, uid2) {
    let user1 = users[uid1]
    let user2 = users[uid2]

    if (user1 && user2) {
        const matchId = uuidv4() // Generate unique match ID
        const start = performance.now()

        let messageForUser1 = Buffer.from(
            JSON.stringify({
                peer: user2,
                matchId,
            })
        )

        // Track how many sends have completed
        let sendsCompleted = 0

        function checkDone() {
            sendsCompleted++
            if (sendsCompleted === 2) {
                const duration = performance.now() - start
                console.log(`Sent both endpoints in ${duration.toFixed(2)} ms`)
            }
        }

        socket.send(
            messageForUser1,
            0,
            messageForUser1.length,
            user1.port,
            user1.address,
            function (err) {
                if (err) return console.log(err)
                console.log(`> Public endpoint of ${uid2} sent to ${uid1}`)
                checkDone()
            }
        )

        let messageForUser2 = Buffer.from(
            JSON.stringify({
                peer: user1,
                matchId,
            })
        )

        socket.send(
            messageForUser2,
            0,
            messageForUser2.length,
            user2.port,
            user2.address,
            function (err) {
                if (err) return console.log(err)
                console.log(`> Public endpoint of ${uid1} sent to ${uid2}`)
                checkDone()
            }
        )
    }
}
