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

const usersRef = db.collection('users')
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

async function changeUserName(name, token) {
    const querySnapshot = await usersRef.where('uid', '==', token).get()
    if (!querySnapshot.empty) {
        await usersRef.doc(querySnapshot).set({
            userName: name,
        })
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
    //generate a random id for the matchId
    const matchIDRef = db.collection('recent-matches').doc()
    const matchId = matchIDRef.id // Get the generated ID
    // get the match ref
    const matchRef = db.collection('recent-matches').doc(uid)
    console.log(matchData)
    const parsedMatchData = dataConverter.parseMatchData(matchData.matchData.raw)
    const p1Char = dataConverter.getCharacterByCode(parsedMatchData['player1-char'])
    const p2Char = dataConverter.getCharacterByCode(parsedMatchData['player2-char'])
    const matchObject = {
        player1Name: matchData.player1 ? await getUserName(matchData.player1) : null,
        player1: matchData.player1,
        player1Char: p1Char,
        player1Super: parsedMatchData['player1-super'],
        player2Name: matchData.player2 ? await getUserName(matchData.player2) : null,
        player2: matchData.player2,
        player2Char: p2Char,
        player2Super: parsedMatchData['player2-super'],
        matchData: matchData.matchData,
        results: parsedMatchData['p1-win'] ? '1' : '2',
        matchId,
    }
    await matchRef.set(
        {
            recentMatches: FieldValue.arrayUnion(matchObject),
        },
        { merge: true }
    )
}

async function getUserMatches(uid) {
    if (uid && uid.length) {
        const docRef = db.collection('recent-matches').doc(uid)
        const docSnap = await docRef.get()

        if (docSnap.exists) {
            console.log(docSnap.data())
            return docSnap.data()
        }
        return null
    }
    return null
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
        console.log('User found:', isLoggedIn)
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
app.post('/change-name', (req, res) => {
    // if user cannot be verified kick them out of the request
    getAuth()
        .verifyIdToken(req.body.idToken)
        .then((decodedToken) => {
            const uid = decodedToken.uid
            // add user to logged in users collection
            changeUserName(req.body.userName, uid)
        })
        .catch((err) => {
            console.log('user touched api without being logged in', err)
        })
})

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
            // console.log(req.body)
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
        const data = await getUserMatches(uid)

        if (data) {
            console.log('did we get data?', data)
            return res.json(data)
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
