var dgram = require('dgram')

var socket = dgram.createSocket('udp4')
socket.bind(33333)

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
        let messageForUser1 = Buffer.from(JSON.stringify(user2))
        socket.send(
            messageForUser1,
            0,
            messageForUser1.length,
            user1.port,
            user1.address,
            function (err) {
                if (err) return console.log(err)
                console.log(`> Public endpoint of ${uid2} sent to ${uid1}`)
            }
        )

        let messageForUser2 = Buffer.from(JSON.stringify(user1))
        socket.send(
            messageForUser2,
            0,
            messageForUser2.length,
            user2.port,
            user2.address,
            function (err) {
                if (err) return console.log(err)
                console.log(`> Public endpoint of ${uid1} sent to ${uid2}`)
            }
        )
    }
}



// SET UP THIS ONE FOR OTHER CONNECTIONS LATER


// var dgram = require('dgram')

// // based on http://www.bford.info/pub/net/p2pnat/index.html

// var socket = dgram.createSocket('udp4')
// socket.bind(33333)

// var publicEndpointA = null
// var publicEndpointB = null

// socket.on('listening', function () {
//     console.log('UDP Server listening on ' + socket.address().address + ':' + socket.address().port)
// })

// socket.on('message', function (message, remote) {
//     console.log(remote.address + ':' + remote.port + ' - ' + message)

//     if (message == 'A') {
//         publicEndpointA = {
//             name: 'A',
//             address: remote.address,
//             port: remote.port,
//         }
//     }

//     if (message == 'B') {
//         publicEndpointB = {
//             name: 'B',
//             address: remote.address,
//             port: remote.port,
//         }
//     }

//     sendPublicDataToClients()
// })

// function sendPublicDataToClients() {
//     if (publicEndpointA && publicEndpointB) {
//         var messageForA = new Buffer(JSON.stringify(publicEndpointB))
//         socket.send(
//             messageForA,
//             0,
//             messageForA.length,
//             publicEndpointA.port,
//             publicEndpointA.address,
//             function (err, nrOfBytesSent) {
//                 if (err) return console.log(err)
//                 console.log('> public endpoint of B sent to A')
//             }
//         )

//         var messageForB = new Buffer(JSON.stringify(publicEndpointA))
//         socket.send(
//             messageForB,
//             0,
//             messageForB.length,
//             publicEndpointB.port,
//             publicEndpointB.address,
//             function (err, nrOfBytesSent) {
//                 if (err) return console.log(err)
//                 console.log('> public endpoint of A sent to B')
//             }
//         )
//     }
// }
