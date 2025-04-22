const { getAuth } = require('firebase-admin/auth')
const { getFirestore, FieldValue, updateDoc } = require('firebase-admin/firestore')
const dataConverter = require('./data')

// firebase related commands
const db = getFirestore()

const usersRef = db.collection('users')
const logInUserRef = db.collection('logged-in')

async function addLoggedInUser(userEmail, token) {
    await logInUserRef.doc(userEmail).set({
        token,
    })
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
    const data = await logInUserRef.doc(userEmail).delete()
    if (data) {
        console.log(data)
    }
}

async function createAccount({ name, email }, token) {
    const querySnapshot = await usersRef.where('uid', '==', token).get()
    if (querySnapshot.empty) {
        // create a new user
        await usersRef.doc(email).set({
            userEmail: email,
            userName: name,
            profilePicture: null,
            uid: token,
        })
    } else {
        return null
    }
}

async function updateUserData(data, token) {
    const allowedFields = ['userName', 'userTitle', 'knownAliases']
    const validData = Object.keys(data)
        .filter((key) => allowedFields.includes(key))
        .reduce((obj, key) => ({ ...obj, [key]: data[key] }), {})

    if (Object.keys(validData).length === 0) return null // Prevent empty/bogus updates

    const querySnapshot = await usersRef.where('uid', '==', token).get()
    if (!querySnapshot.empty) {
        const userDoc = querySnapshot.docs[0].ref
        await userDoc.set(validData, { merge: true })
        if (validData.userName) {
            await userDoc.update({
                knownAliases: FieldValue.arrayUnion(validData.userName),
            })
        }
    } else {
        return null
    }
}

async function getUserData(uid) {
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
    // console.log(idToken, ' requesting a new custom token')
    const customToken = await getAuth().createCustomToken(idToken)
    return customToken
}

// match related functions
async function getUserName(uid) {
    const querySnapshot = await usersRef.where('uid', '==', uid).get()
    if (!querySnapshot.empty) {
        console.log('trying to get docs', querySnapshot.docs)
        return querySnapshot.docs[0].data().userName
    } else {
        return null
    }
}

async function uploadMatchData(matchData, uid) {
    if (!uid || !matchData.matchId) return
    console.log('match trying to be uploaded')
    console.log(matchData, uid)
    const globalMatchRef = db.collection('global-matches').doc(matchData.matchId)

    // check to see if the match has already been logged
    const existingMatch = await globalMatchRef.get()
    if (existingMatch.exists) {
        console.log(`Match ${matchData.matchId} already exists. Skipping upload.`)
        return
    }

    // const matchIDRef = db.collection('recent-matches').doc(uid).collection('matches').doc()
    // const matchId = matchIDRef.id
    // const parsedMatchData = dataConverter.parseMatchData(matchData.matchData.raw)
    // const p1Char = dataConverter.getCharacterByCode(parsedMatchData['player1-char'])
    // const p2Char = dataConverter.getCharacterByCode(parsedMatchData['player2-char'])
    // const playerKey = parsedMatchData['p1-win'] ? 'p1' : 'p2'
    console.log('parsing match data')
    // parse the match data
    const parsedMatchData = dataConverter.parseMatchData(matchData.matchData.raw)
    const p1Char = dataConverter.getCharacterByCode(parsedMatchData['player1-char'])
    const p2Char = dataConverter.getCharacterByCode(parsedMatchData['player2-char'])
    const playerKey = parsedMatchData['p1-win'] ? 'p1' : 'p2'

    const matchObject = {
        uniqueMatchId: matchData.matchId,
        player1Name: matchData.player1 ? await getUserName(matchData.player1) : null,
        player1: matchData.player1 || 'p1 unknown',
        player1Char: p1Char || 'p1 char unknown',
        player1Super: parsedMatchData['player1-super'],
        player2Name: matchData.player2 ? await getUserName(matchData.player2) : null,
        player2: matchData.player2 || 'p2 unknown',
        player2Char: p2Char || 'p2 char unknown',
        player2Super: parsedMatchData['player2-super'],
        matchData: matchData.matchData,
        results: parsedMatchData['p1-win'] ? '1' : '2',
        matchId,
        timestamp: FieldValue.serverTimestamp(),
    }

    // Save globally
    await globalMatchRef.set(matchObject)

    // Save under both players' profiles
    const batch = db.batch()
    if (matchData.player1) {
        const ref1 = db
            .collection('recent-matches')
            .doc(matchData.player1)
            .collection('matches')
            .doc(matchData.matchId)
        batch.set(ref1, matchObject)
    }
    if (matchData.player2) {
        const ref2 = db
            .collection('recent-matches')
            .doc(matchData.player2)
            .collection('matches')
            .doc(matchData.matchId)
        batch.set(ref2, matchObject)
    }
    await batch.commit()

    // Update global stats
    const globalStatsRef = db.collection('global-stats').doc('global-match-stats')
    try {
        await globalStatsRef.set(
            {
                globalNumberOfMatches: FieldValue.increment(1),
                [`globalWinCount.${playerKey}`]: FieldValue.increment(1),
                [`globalCharacterChoice.${p1Char}`]: FieldValue.increment(1),
                [`globalCharacterChoice.${p2Char}`]: FieldValue.increment(1),
            },
            { merge: true }
        )

        console.log(`Match ${matchData.matchId} successfully uploaded and stats updated.`)
    } catch (error) {
        console.error('Error updating global stats:', error)
    }
}

async function getUserMatches(uid, limit = 10, lastMatchId = null, firstMatchId = null) {
    if (!uid) return null

    const matchCollectionRef = db.collection('recent-matches').doc(uid).collection('matches')
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
    uploadMatchData,
    getUserName,
    getCustomToken,
    getUserAccountByAuth,
    getUserData,
    updateUserData,
    createAccount,
    removeLoggedInUser,
    fetchLoggedInUser,
    addLoggedInUser,
}
