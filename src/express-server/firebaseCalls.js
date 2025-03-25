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
    if (!uid) return
    // console.log('attempting to parse match data', matchData)
    const matchIDRef = db.collection('recent-matches').doc(uid).collection('matches').doc()
    const matchId = matchIDRef.id
    const parsedMatchData = dataConverter.parseMatchData(matchData.matchData.raw)
    // console.log('match data was parsed', parsedMatchData)
    const p1Char = dataConverter.getCharacterByCode(parsedMatchData['player1-char'])
    const p2Char = dataConverter.getCharacterByCode(parsedMatchData['player2-char'])
    const playerKey = parsedMatchData['p1-win'] ? 'p1' : 'p2'

    const matchObject = {
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

    await matchIDRef.set(matchObject)

    // add to global number of matches
    // const globalStatsRef = db.collection('global-stats').doc('global-match-stats')
    // await globalStatsRef.set(
    //     {
    //         globalNumberOfMatches: FieldValue.increment(1),
    //     },
    //     { merge: true }
    // )

    // // update the global count for wins
    // try {
    //     await globalStatsRef.update({
    //         [`globalWinCount.${playerKey}`]: FieldValue.increment(1),
    //     })
    //     console.log(`${playerKey} win count incremented`)
    // } catch (error) {
    //     console.error('Error updating win count:', error)
    // }

    // // update character stats
    // try {
    //     await globalStatsRef.update({
    //         [`globalCharacterChoice.${charKey}`]: {
    //             count: FieldValue.increment(1),
    //         },
    //     })
    //     console.log(`${charKey} data updated`)
    // } catch (error) {
    //     console.error('Error updating global char stats:', error)
    // }
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
