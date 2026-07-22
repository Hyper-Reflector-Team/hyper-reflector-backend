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

function calculateNewElo(a, b, isWin) {
    const k = 32 // Constant that determines sensitivity of rating change
    const expectedScore = 1 / (1 + Math.pow(10, (b - a) / 400))
    const actualScore = isWin ? 1 : 0
    const newRating = a + k * (actualScore - expectedScore)
    return Math.round(newRating)
}

module.exports = { calculateNewElo }



// FC2 ELO code taken from : 
// https://gist.github.com/poliva/77753daaeb15cffd2478341b3257e1b7
function getK (elo) {
  // for rank '?' (<10 games played) the K factor is 20
  if (elo < 700) return 34;   // rank E
  if (elo < 1000) return 32;  // rank D
  if (elo < 1300) return 30;  // rank C
  if (elo < 1600) return 28;  // rank B
  if (elo < 1900) return 26;  // rank A
  return 24;                  // rank S
}

function eloScore (score1, score2, elo1, elo2) {
  let k1 = getK (elo1)
  let k2 = getK (elo2)
  let max = Math.max(score1, score2)
  let score = Math.round ( (((score1 - score2) * 0.5 / max + 0.5) + Number.EPSILON) * 100 ) / 100;
  let reward =  Math.min(2.50, Math.abs((score1 - score2) * 0.25));
  reward = score < 0.5 ? reward * -1 : reward;
  let chanceToWin = 1 / (1 + Math.pow(10, (elo2 - elo1) / 400 ));
  let multiplier = 4 * (score - chanceToWin);
  let points = Math.round(Math.min(k1, k2) * multiplier * (Math.min(10, max) / 10) + reward)
  points = points === 0 && score1 > score2 ? 1 : points === 0 && score1 < score2 ? -1 : points;

  console.log(score1 + ', ' + score2 + ', ' + elo1 + ', ' + elo2 + ', ' + k1 + ', ' + k2 + ' -> ' + points)
  let res1 = parseInt(elo1)+parseInt(points)
  let res2 = parseInt(elo2)-parseInt(points)
  console.log('POINTS EXCHANGED: ' + points + ' - P1_CHANCE_TO_WIN: ' + Math.round(chanceToWin * 10000)/100 + '% - REWARD: ' + reward)
  console.log(' PLAYER 1 went from ' + elo1 + ' to ' + res1)
  console.log(' PLAYER 2 went from ' + elo2 + ' to ' + res2)
}

if (require.main === module) {
  const myArgs = process.argv.slice(2)
  if (myArgs[0] === undefined || myArgs[1] === undefined || myArgs[2] === undefined || myArgs[3] === undefined) {
    console.log("USAGE: node fc2-elo.js <score1> <score2> <elo1> <elo2>")
    console.log("   example: node fc2-elo.js 8 10 1554 1305")
  } else {
    const p1score = parseInt(myArgs[0])
    const p2score = parseInt(myArgs[1])
    const p1elo = parseInt(myArgs[2])
    const p2elo = parseInt(myArgs[3])
    eloScore(p1score, p2score, p1elo, p2elo)
  }
}