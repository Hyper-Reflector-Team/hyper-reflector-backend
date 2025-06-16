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
