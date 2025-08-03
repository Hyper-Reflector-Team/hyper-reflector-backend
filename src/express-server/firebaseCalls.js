const { getAuth } = require('firebase-admin/auth')
const { getFirestore, FieldValue } = require('firebase-admin/firestore')
const gravatar = require('gravatar.js')
const dataConverter = require('./data')
const { calculateNewElo } = require('./utils')

// firebase related commands
const db = getFirestore()

const usersRef = db.collection('users')
const logInUserRef = db.collection('logged-in')

async function addLoggedInUser(userEmail, token) {
    if (userEmail && token) {
        await logInUserRef.doc(userEmail).set({
            token,
        })
    }
}

async function fetchLoggedInUser(userEmail) {
    if (userEmail && userEmail.length) {
        const doc = await logInUserRef.doc(userEmail).get()
        if (doc.exists) {
            return true
        }
        return false
    }
    return 'something something'
}

async function removeLoggedInUser(userEmail) {
    if (!userEmail?.length) return
    const data = await logInUserRef.doc(userEmail).delete()
    if (data) {
        console.log(data)
    }
}

async function createAccount({ name, email }, token) {
    if (!token) return
    const querySnapshot = await usersRef.where('uid', '==', token).get()
    if (querySnapshot.empty) {
        // create a new user
        await usersRef.doc(email).set({
            userEmail: email,
            userName: name,
            userProfilePic: null,
            uid: token,
        })
    } else {
        return null
    }
}

async function updateUserData(data, token) {
    if (!token) return

    const allowedFields = [
        'userName',
        'userTitle',
        'knownAliases',
        'countryCode',
        'lastKnownPings',
        'pingLat',
        'pingLon',
        'userProfilePic',
        'gravEmail',
        'winStreak',
        'elo',
    ]
    const validData = Object.keys(data)
        .filter((key) => allowedFields.includes(key))
        .reduce((obj, key) => ({ ...obj, [key]: data[key] }), {})

    if (Object.keys(validData).length === 0) return null

    const currentUserSnapshot = await usersRef.where('uid', '==', token).get()
    if (currentUserSnapshot.empty) return null

    const userDocRef = currentUserSnapshot.docs[0].ref
    const currentUserData = currentUserSnapshot.docs[0].data()

    const updates = {}

    for (const key of Object.keys(validData)) {
        const newValue = validData[key]
        const currentValue = currentUserData[key]

        if (newValue !== currentValue) {
            updates[key] = newValue
        }
    }

    if (validData.gravEmail) {
        try {
            const newProfilePic = await gravatar.resolve(validData.gravEmail)

            if (newProfilePic && newProfilePic !== currentUserData.userProfilePic) {
                updates.userProfilePic = newProfilePic
                if (validData.gravEmail !== currentUserData.gravEmail) {
                    updates.gravEmail = validData.gravEmail
                }
            }
        } catch (err) {
            updates.userProfilePic = null
        }
    }

    if (Object.keys(updates).length === 0) {
        console.log('No changes to update.')
        return
    }

    await userDocRef.set(updates, { merge: true })

    if (updates.userName) {
        await userDocRef.update({
            knownAliases: FieldValue.arrayUnion(updates.userName),
        })
    }

    // console.log('User updated:', updates)
}

async function getUserData(uid) {
    if (!uid) return
    const querySnapshot = await usersRef.where('uid', '==', uid).get()
    if (!querySnapshot.empty) {
        const doc = querySnapshot.docs[0]
        const { userEmail, ...filteredData } = doc.data() // exclude uid and email
        return filteredData
    } else {
        return null
    }
}

async function getUserAccountByAuth(token) {
    if (!token) return
    const querySnapshot = await usersRef.where('uid', '==', token).get()
    if (!querySnapshot.empty) {
        console.log(querySnapshot.docs[0].data())
        return querySnapshot.docs[0].data()
    } else {
        return null
    }
}

// get custom token for auto log in
async function getCustomToken(idToken) {
    if (!idToken) return
    const customToken = await getAuth().createCustomToken(idToken)
    return customToken
}

// match related functions
async function getUserName(uid) {
    if (!uid) return
    const querySnapshot = await usersRef.where('uid', '==', uid).get()
    if (!querySnapshot.empty) {
        return querySnapshot.docs[0].data().userName
    } else {
        return null
    }
}

//get elo
async function getUserElo(uid) {
    if (!uid) return
    const querySnapshot = await usersRef.where('uid', '==', uid).get()
    if (!querySnapshot.empty) {
        return querySnapshot.docs[0].data().elo || 1200
    } else {
        return null
    }
}

async function uploadMatchData(matchData, uid) {
    if (!uid || !matchData.matchId) return
    if (uid === !matchData.player1) return

    const sessionRef = db.collection('global-matches').doc(matchData.matchId)
    const sessionSnap = await sessionRef.get()

    const parsed = dataConverter.parseMatchData(matchData.matchData.raw)
    const p1Char = dataConverter.getCharacterByCode(parsed['player1-char'])
    const p2Char = dataConverter.getCharacterByCode(parsed['player2-char'])
    const matchResult = parsed['p1-win'] ? '1' : '2'
    // used for updating counts
    let p1Wins = 0
    let p2Wins = 0

    const matchEntry = {
        // TODO fix this
        matchData: matchData.matchData, // this is a temporary fix to prevent massive raw data explosions
        timestamp: Date.now(),
        player1Char: p1Char || 'unknown',
        player2Char: p2Char || 'unknown',
        result: matchResult,
        player1Super: parsed['player1-super'],
        player2Super: parsed['player2-super'],
    }

    if (!sessionSnap.exists) {
        console.log('snap shot did not exist')
        // First match in session, create new document
        const session = {
            sessionId: matchData.matchId,
            player1: matchData.player1,
            player2: matchData.player2,
            player1Name: await getUserName(matchData.player1),
            player2Name: await getUserName(matchData.player2),
            matches: [matchEntry],
            player1Wins: matchResult === '1' ? 1 : 0,
            player2Wins: matchResult === '2' ? 1 : 0,
            timestamp: Date.now(),
        }

        await sessionRef.set(session)
    } else {
        console.log('snap shot did exist')
        // Get current matches first (avoid fetching *after* the update)
        const existingSession = sessionSnap.data()
        const allMatches = [...(existingSession.matches || []), matchEntry]

        for (const match of allMatches) {
            if (match.result === '1') p1Wins++
            if (match.result === '2') p2Wins++
        }

        // Single update
        await sessionRef.update({
            matches: FieldValue.arrayUnion(matchEntry),
            player1Wins: p1Wins,
            player2Wins: p2Wins,
        })
    }

    // recent match session meta data for player profile
    const batch = db.batch()
    for (const player of [matchData.player1, matchData.player2]) {
        if (!player) continue
        const ref = db
            .collection('recent-matches')
            .doc(player)
            .collection('sessions')
            .doc(matchData.matchId)
        batch.set(
            ref,
            {
                player1Name: await getUserName(matchData.player1),
                player2Name: await getUserName(matchData.player2),
                sessionId: matchData.matchId,
                timestamp: Date.now(),
                p1Wins,
                p2Wins,
            },
            { merge: true }
        )

        const statsRef = db.collection('player-stats').doc(player)
        const whichPlayer = matchData.player1 === player ? '1' : '2'
        const playerWon = matchResult === whichPlayer ? true : false
        const character = whichPlayer === '1' ? p1Char : p2Char
        const superIndex = whichPlayer === '1' ? parsed['player1-super'] : parsed['player2-super']
        const player1Elo = await getUserElo(matchData.player1)
        const player2Elo = await getUserElo(matchData.player2)
        // set the users new elo on their profile
        await setUserElo(matchData.player1, calculateNewElo(player1Elo, player2Elo, playerWon))
        await setUserElo(matchData.player2, calculateNewElo(player2Elo, player1Elo, !playerWon))
        console.log('P1 ELO before:', player1Elo, 'P2 ELO before:', player2Elo)
        console.log('P1 won?', playerWon)
        batch.set(
            statsRef,
            {
                accountElo:
                    whichPlayer === '1'
                        ? calculateNewElo(player1Elo, player2Elo, playerWon)
                        : calculateNewElo(player2Elo, player1Elo, playerWon),
                totalGames: FieldValue.increment(1),
                totalWins: playerWon ? FieldValue.increment(1) : FieldValue.increment(0),
                totalLosses: !playerWon ? FieldValue.increment(1) : FieldValue.increment(0),
                winStreak: playerWon ? FieldValue.increment(1) : 0, // if lost, reset streak
                // send data back to increase streak on websocket end
                characters: {
                    [`${character}`]: {
                        picks: FieldValue.increment(1),
                        superChoice: {
                            [`${superIndex}`]: {
                                wins:
                                    matchResult === whichPlayer
                                        ? FieldValue.increment(1)
                                        : FieldValue.increment(0),
                                losses:
                                    matchResult !== whichPlayer
                                        ? FieldValue.increment(1)
                                        : FieldValue.increment(0),
                            },
                        },
                    },
                },
                lastUpdated: Date.now(),
            },
            { merge: true }
        )
    }

    await batch.commit()

    // Update global stats
    const globalStatsRef = db.collection('global-stats').doc('global-match-stats')
    try {
        await globalStatsRef.set(
            {
                globalNumberOfMatches: FieldValue.increment(1),
                globalWinCount: {
                    [`${matchResult}`]: FieldValue.increment(1),
                },
                globalCharacterChoice: {
                    [`${p1Char}`]: {
                        picks: FieldValue.increment(1),
                        superChoice: {
                            [`${parsed['player1-super']}`]: {
                                wins:
                                    matchResult === '1'
                                        ? FieldValue.increment(1)
                                        : FieldValue.increment(0),
                                losses:
                                    matchResult === '2'
                                        ? FieldValue.increment(1)
                                        : FieldValue.increment(0),
                            },
                        },
                    },
                    [`${p2Char}`]: {
                        picks: FieldValue.increment(1),
                        superChoice: {
                            [`${parsed['player2-super']}`]: {
                                wins:
                                    matchResult === '1'
                                        ? FieldValue.increment(1)
                                        : FieldValue.increment(0),
                                losses:
                                    matchResult === '2'
                                        ? FieldValue.increment(1)
                                        : FieldValue.increment(0),
                            },
                        },
                    },
                },
            },
            { merge: true }
        )

        console.log(`Match ${matchData.matchId} successfully uploaded and stats updated.`)
    } catch (error) {
        console.error('Error updating global stats:', error)
    }

    console.log(`Uploaded match (as part of session ${matchData.matchId})`)
}

async function getGlobalSet(uid, matchId) {
    if (!uid) return null
    const setCollectionRef = db.collection('global-matches').doc(matchId)
    const data = await setCollectionRef.get()
    if (!data.empty) {
        if (!data.data()) return null
        return data.data()
    } else {
        return null
    }
}

async function getGlobalStats(uid) {
    if (!uid) return null

    const statDocRef = db.collection('global-stats').doc('global-match-stats')
    const docSnap = await statDocRef.get()
    console.log(docSnap)
    if (!docSnap.exists) {
        return null
    }

    const data = docSnap.data()
    console.log(data)
    if (!data) {
        return null
    }

    return data
}
async function getPlayerStats(uid) {
    if (!uid) return null
    const statCollection = db.collection('player-stats').doc(uid)
    const data = await statCollection.get()
    if (!data.empty) {
        if (!data.data()) return null
        return data.data()
    } else {
        return null
    }
}

async function getAllTitles(uid) {
    if (!uid) return null
    const titleCollectionRef = db.collection('titles').doc('data')
    const data = await titleCollectionRef.get()
    if (!data.empty) {
        if (!data.data()) return null
        console.log(data.data())
        return data.data()
    } else {
        return null
    }
}

async function getUserName(uid) {
    if (!uid) return
    const querySnapshot = await usersRef.where('uid', '==', uid).get()
    if (!querySnapshot.empty) {
        console.log('trying to get docs', querySnapshot.docs)
        return querySnapshot.docs[0].data().userName
    } else {
        return null
    }
}

// set elo
async function setUserElo(uid, newElo) {
    if (!uid) return

    const querySnapshot = await usersRef.where('uid', '==', uid).get()

    if (!querySnapshot.empty) {
        const userDoc = querySnapshot.docs[0]
        await userDoc.ref.update({ elo: newElo })
        return true
    } else {
        return false
    }
}

async function getUserMatches(uid, limit = 10, lastMatchId = null, firstMatchId = null) {
    if (!uid) return null

    const matchCollectionRef = db.collection('recent-matches').doc(uid).collection('sessions')
    const totalMatchesSnapshot = await matchCollectionRef.count().get()
    const totalMatches = totalMatchesSnapshot.data().count

    let query = matchCollectionRef.orderBy('timestamp', 'desc').limit(limit)

    if (lastMatchId) {
        console.log('getting match data from last id', lastMatchId)
        const lastDoc = await matchCollectionRef.doc(lastMatchId).get()
        if (lastDoc.exists) {
            query = query.startAfter(lastDoc)
        }
    }
    if (firstMatchId) {
        console.log('getting match data from first id', firstMatchId)
        const firstDoc = await matchCollectionRef.doc(firstMatchId).get()
        if (firstDoc.exists) {
            query = matchCollectionRef
                .orderBy('timestamp', 'desc')
                .endBefore(firstDoc)
                .limitToLast(limit) // Ensure correct ordering when going backward
        }
    }

    const querySnapshot = await query.get()
    const matches = querySnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }))
    return {
        matches,
        lastVisible: querySnapshot.docs[querySnapshot.docs.length - 1] || null,
        firstVisible: querySnapshot.docs[0] || null,
        totalMatches,
    }
}

module.exports = {
    getUserMatches,
    getGlobalSet,
    getGlobalStats,
    getPlayerStats,
    uploadMatchData,
    getUserName,
    getUserElo,
    getCustomToken,
    getUserAccountByAuth,
    getUserData,
    getAllTitles,
    updateUserData,
    createAccount,
    removeLoggedInUser,
    fetchLoggedInUser,
    addLoggedInUser,
}
