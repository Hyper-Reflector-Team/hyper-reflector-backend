const express = require('express')
const app = express()
const port = 8080
// firebase
const { initializeApp, applicationDefault, cert } = require('firebase-admin/app')
const { getAuth } = require('firebase-admin/auth')
const {
    getFirestore,
    Timestamp,
    FieldValue,
    Filter,
    query,
    where,
    getDocs,
} = require('firebase-admin/firestore')
const serviceAccount = require('../../keys/service_account_key.json')

const dataConverter = require('./data')

initializeApp({
    credential: cert(serviceAccount),
})

// firebase related commands
const db = getFirestore()

const docRef = db.collection('users').doc('alovelace')

const usersRef = db.collection('users')

async function testCommand(name) {
    await docRef.set({
        first: name,
        last: 'Lovelace',
        born: 1815,
    })
}

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
    console.log(userEmail)
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

    let query = db
        .collection('recent-matches')
        .doc(uid)
        .collection('matches')
        .orderBy('timestamp', 'desc') // Sort by newest first
        .limit(limit)

    // If there is a lastMatchId, fetch the corresponding document to use as the startAfter cursor
    if (lastMatchId) {
        const lastDoc = await db
            .collection('recent-matches')
            .doc(uid)
            .collection('matches')
            .doc(lastMatchId)
            .get()

        if (lastDoc.exists) {
            query = query.startAfter(lastDoc)
        }
    }

    const querySnapshot = await query.get()
    const matches = querySnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }))

    return {
        matches,
        lastVisible: querySnapshot.docs[querySnapshot.docs.length - 1] || null, // Cursor for next page
    }
}

app.use(express.json()) // for parsing application/json

// SERVER
//expects a user token from firebase auth to verify
app.post('/validate-token', (req, res) => {
    // if user cannot be verified kick them out of the request
    getAuth()
        .verifyIdToken(req.body.idToken)
        .then((decodedToken) => {
            const uid = decodedToken.uid
            res.send('ok')
        })
        .catch((err) => {
            console.log('user touched api without being logged in', err)
            res.send('no-ok')
        })
})

// handle auth, check for users in db that are logged in.
app.post('/logged-in', (req, res) => {
    // if user cannot be verified kick them out of the request
    getAuth()
        .verifyIdToken(req.body.idToken)
        .then((decodedToken) => {
            console.log('user logged in service')
            const uid = decodedToken.uid
            // add user to logged in users collection
            addLoggedInUser(req.body.userEmail, uid)
        })
        .catch((err) => {
            console.log('user touched api without being logged in', err)
        })
})

app.post('/get-logged-in', async (req, res) => {
    try {
        const isLoggedIn = await fetchLoggedInUser(req.body.userEmail)
        res.json({ loggedIn: isLoggedIn === true }) // Ensure it's boolean
    } catch (error) {
        console.log('user not logged in')
        res.status(500).json({ error: 'server error' })
    }
})

app.post('/log-out', (req, res) => {
    // if user cannot be verified kick them out of the request
    getAuth()
        .verifyIdToken(req.body.idToken)
        .then(() => {
            // add user to logged in users collection
            removeLoggedInUser(req.body.userEmail)
        })
        .catch((err) => {
            console.log('user touched api without being logged in', err)
        })
})

// insecure? - need to test more
app.post('/log-out-internal', (req, res) => {
    // if user cannot be verified kick them out of the request
    removeLoggedInUser(req.body.userEmail)
})

//profile api
app.post('/update-user-data', (req, res) => {
    // if user cannot be verified kick them out of the request
    getAuth()
        .verifyIdToken(req.body.idToken)
        .then((decodedToken) => {
            const uid = decodedToken.uid
            // add user to logged in users collection
            updateUserData(req.body.userName, uid)
        })
        .catch((err) => {
            console.log('user touched api without being logged in', err)
        })
})

app.post('/get-user-data', async (req, res) => {
    try {
        const decodedToken = await getAuth().verifyIdToken(req.body.idToken)
        if (!decodedToken) return

        const data = await getUserData(req.body.userUID)

        if (data) {
            return res.json(data)
        } else {
            return res.status(404).json({ error: 'No user found' })
        }
    } catch (err) {
        console.error(err)
        res.status(500).json({ error: 'Server error' })
    }
})

//

// account setting
app.post('/create-account', (req, res) => {
    // if user cannot be verified kick them out of the request
    getAuth()
        .verifyIdToken(req.body.idToken)
        .then((decodedToken) => {
            const uid = decodedToken.uid
            // add user to logged in users collection
            createAccount(req.body, uid)
        })
        .catch((err) => {
            console.log('user touched api without being logged in', err)
        })
})

app.post('/get-user-auth', async (req, res) => {
    try {
        //get token
        const decodedToken = await getAuth().verifyIdToken(req.body.idToken)
        const uid = decodedToken.uid
        const data = await getUserAccountByAuth(uid)
        return res.json(data)
    } catch (err) {
        console.log('user touched api without being logged in', err)
        res.status(500).json({ err: 'server error' })
    }
})

app.post('/get-custom-token', async (req, res) => {
    try {
        //get token
        const decodedToken = await getAuth().verifyIdToken(req.body.idToken)
        const uid = decodedToken.uid
        const data = await getCustomToken(uid)
        return res.json(data)
    } catch (err) {
        res.status(500).json({ err: 'server error' })
    }
})

// match related
app.post('/upload-match', (req, res) => {
    // if user cannot be verified kick them out of the request
    getAuth()
        .verifyIdToken(req.body.idToken)
        .then((decodedToken) => {
            const uid = decodedToken.uid
            // add user to logged in users collection
            const data = req.body
            uploadMatchData(data, uid)
        })
        .catch((err) => {
            console.log('user touched api without being logged in', err)
        })
})

app.post('/get-user-matches', async (req, res) => {
    try {
        const decodedToken = await getAuth().verifyIdToken(req.body.idToken)
        const uid = decodedToken.uid
        const { lastMatchId, userUID } = req.body // Get pagination cursor from client

        // Fetch matches with pagination
        const { matches, lastVisible } = await getUserMatches(userUID, 10, lastMatchId)
        console.log('matches', matches)
        if (matches.length > 0) {
            return res.json({ matches, lastVisible: lastVisible ? lastVisible.id : null })
        } else {
            return res.status(404).json({ error: 'No matches found' })
        }
    } catch (err) {
        console.error(err)
        res.status(500).json({ error: 'Server error' })
    }
})

// init listen
app.listen(port, () => {
    console.log(`firebase api on port ${port}`)
})

app.use(express.urlencoded({ extended: true })) // for parsing application/x-www-form-urlencoded
