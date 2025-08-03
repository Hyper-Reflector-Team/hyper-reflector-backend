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


function calculateNewElo(a: number, b: number, isWin: boolean): number {
    const k = 32; // Constant that determines sensitivity of rating change
    const expectedScore = 1 / (1 + Math.pow(10, (b - a) / 400));
    const actualScore = isWin ? 1 : 0;
    const newRating = a + k * (actualScore - expectedScore);
    return Math.round(newRating);
}

export {
    calculateNewElo
}