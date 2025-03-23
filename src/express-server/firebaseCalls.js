const { getAuth } = require('firebase-admin/auth')
const { getFirestore, FieldValue } = require('firebase-admin/firestore')
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
    const querySnapshot = await usersRef.where('uid', '==', token).get()
    if (!querySnapshot.empty) {
        await usersRef.doc(querySnapshot).set({
            userName: data.userName,
        })
    } else {
        return null
    }
}

async function getUserData(uid) {
    console.log(uid)
    const querySnapshot = await usersRef.where('uid', '==', uid).get()
    if (!querySnapshot.empty) {
        const doc = querySnapshot.docs[0]
        const { userEmail, uid, ...filteredData } = doc.data() // exclude uid and email
        return filteredData
    } else {
        return null
    }
}

// add known alias
// add profile picture uploading
// add recent matches

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

    const matchIDRef = db.collection('recent-matches').doc(uid).collection('matches').doc()
    const matchId = matchIDRef.id

    const parsedMatchData = dataConverter.parseMatchData(matchData.matchData.raw)
    const p1Char = dataConverter.getCharacterByCode(parsedMatchData['player1-char'])
    const p2Char = dataConverter.getCharacterByCode(parsedMatchData['player2-char'])
    const matchObject = {
        player1Name: matchData.player1 ? await getUserName(matchData.player1) : null,
        player1: matchData.player1 || 'p1 unknown',
        player1Char: p1Char || 'p1 char unknown',
        player1Super: parsedMatchData['player1-super'] || 'p1 super unknown',
        player2Name: matchData.player2 ? await getUserName(matchData.player2) : null,
        player2: matchData.player2 || 'p2 unknown',
        player2Char: p2Char || 'p2 char unknown',
        player2Super: parsedMatchData['player2-super'] || 'p2 super unknown',
        matchData: matchData.matchData,
        results: parsedMatchData['p1-win'] ? '1' : '2',
        matchId,
        timestamp: FieldValue.serverTimestamp(),
    }
    await matchIDRef.set(matchObject)
}

async function getUserMatches(uid, limit = 10, lastMatchId = null) {
    if (!uid) return null

    const matchCollectionRef = db.collection('recent-matches').doc(uid).collection('matches')
    const totalMatchesSnapshot = await matchCollectionRef.count().get()
    const totalMatches = totalMatchesSnapshot.data().count

    let query = matchCollectionRef.orderBy('timestamp', 'desc').limit(limit)

    if (lastMatchId) {
        const lastDoc = await matchCollectionRef.doc(lastMatchId).get()
        if (lastDoc.exists) {
            query = query.startAfter(lastDoc)
        }
    }

    const querySnapshot = await query.get()
    const matches = querySnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }))

    return {
        matches,
        lastVisible: querySnapshot.docs[querySnapshot.docs.length - 1] || null,
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
