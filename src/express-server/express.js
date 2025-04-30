const express = require('express')
const app = express()
const port = 8080
// firebase
const { initializeApp, cert } = require('firebase-admin/app')
const { getAuth } = require('firebase-admin/auth')
const serviceAccount = require('../../keys/service_account_key.json')

// we need to initialize the app before we require the api.
initializeApp({
    credential: cert(serviceAccount),
})

const api = require('./firebaseCalls')

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
            api.addLoggedInUser(req.body.userEmail, uid)
        })
        .catch((err) => {
            console.log('user touched api without being logged in', err)
        })
})

app.post('/get-logged-in', async (req, res) => {
    try {
        const isLoggedIn = await api.fetchLoggedInUser(req.body.userEmail)
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
            api.removeLoggedInUser(req.body.userEmail)
        })
        .catch((err) => {
            console.log('user touched api without being logged in', err)
        })
})

// insecure? - need to test more
app.post('/log-out-internal', (req, res) => {
    // if user cannot be verified kick them out of the request
    api.removeLoggedInUser(req.body.userEmail)
})

//profile api
app.post('/update-user-data', (req, res) => {
    // if user cannot be verified kick them out of the request
    getAuth()
        .verifyIdToken(req.body.idToken)
        .then((decodedToken) => {
            const uid = decodedToken.uid
            // add user to logged in users collection
            api.updateUserData(req.body.userData, uid)
        })
        .catch((err) => {
            console.log('user touched api without being logged in', err)
        })
})

app.post('/get-user-data', async (req, res) => {
    try {
        const decodedToken = await getAuth().verifyIdToken(req.body.idToken)
        if (!decodedToken) return

        const data = await api.getUserData(req.body.userUID)

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

// account setting
app.post('/create-account', (req, res) => {
    // if user cannot be verified kick them out of the request
    getAuth()
        .verifyIdToken(req.body.idToken)
        .then((decodedToken) => {
            const uid = decodedToken.uid
            // add user to logged in users collection
            api.createAccount(req.body, uid)
        })
        .catch((err) => {
            console.log('user touched api without being logged in', err)
        })
})

app.post('/get-user-auth', async (req, res) => {
    try {
        const decodedToken = await getAuth().verifyIdToken(req.body.idToken)
        const uid = decodedToken.uid
        const data = await api.getUserAccountByAuth(uid)
        return res.json(data)
    } catch (err) {
        console.log('user touched api without being logged in', err)
        res.status(500).json({ err: 'server error' })
    }
})

app.post('/get-custom-token', async (req, res) => {
    try {
        const decodedToken = await getAuth().verifyIdToken(req.body.idToken)
        const uid = decodedToken.uid
        const data = await api.getCustomToken(uid)
        return res.json(data)
    } catch (err) {
        res.status(500).json({ err: 'server error' })
    }
})

// match related
app.post('/upload-match', (req, res) => {
    console.log('someone is trying to upload a match')
    // if user cannot be verified kick them out of the request
    getAuth()
        .verifyIdToken(req.body.idToken)
        .then((decodedToken) => {
            const uid = decodedToken.uid
            // add user to logged in users collection
            const data = req.body
            api.uploadMatchData(data, uid)
        })
        .catch((err) => {
            console.log('user touched api without being logged in', err)
        })
})

app.post('/get-user-matches', async (req, res) => {
    try {
        const decodedToken = await getAuth().verifyIdToken(req.body.idToken)
        const uid = decodedToken.uid
        const { lastMatchId, userUID, firstMatchId } = req.body // Get pagination cursor from client

        // Fetch matches with pagination
        const { matches, lastVisible, totalMatches, firstVisible } = await api.getUserMatches(
            userUID,
            10,
            lastMatchId,
            firstMatchId
        )

        if (matches.length > 0) {
            return res.json({
                matches,
                lastVisible: lastVisible ? lastVisible.id : null,
                firstVisible: firstVisible ? firstVisible.id : null,
                totalMatches,
            })
        } else {
            return res.status(404).json({ error: 'No matches found' })
        }
    } catch (err) {
        console.error(err)
        res.status(500).json({ error: 'Server error' })
    }
})

app.post('/get-global-set', async (req, res) => {
    try {
        const decodedToken = await getAuth().verifyIdToken(req.body.idToken)
        const uid = decodedToken.uid
        const { userUID, matchId } = req.body

        const globalSet = await api.getGlobalSet(userUID, matchId)

        if (globalSet) {
            return res.json({
                globalSet,
            })
        } else {
            return res.status(404).json({ error: 'No matches found' })
        }
    } catch (err) {
        console.error(err)
        res.status(500).json({ error: 'Server error' })
    }
})

app.post('/get-global-stats', async (req, res) => {
    try {
        const decodedToken = await getAuth().verifyIdToken(req.body.idToken)
        const uid = decodedToken.uid
        const { userUID } = req.body

        const globalStatSet = await api.getGlobalStats(userUID)
        console.log(globalStatSet)
        if (globalStatSet) {
            return res.json({
                globalStatSet,
            })
        } else {
            return res.status(404).json({ error: 'No global stats found' })
        }
    } catch (err) {
        console.error(err)
        res.status(500).json({ error: 'Server error' })
    }
})

app.post('/get-player-stats', async (req, res) => {
    try {
        const decodedToken = await getAuth().verifyIdToken(req.body.idToken)
        const uid = decodedToken.uid
        const { userUID } = req.body

        // Fetch matches with pagination
        const playerStatSet = await api.getPlayerStats(userUID)

        if (playerStatSet) {
            return res.json({
                playerStatSet,
            })
        } else {
            return res.status(404).json({ error: 'No player stat data found' })
        }
    } catch (err) {
        console.error(err)
        res.status(500).json({ error: 'Server error' })
    }
})

app.post('/get-titles', async (req, res) => {
    try {
        const decodedToken = await getAuth().verifyIdToken(req.body.idToken)
        const uid = decodedToken.uid
        const { userUID } = req.body

        // Fetch matches with pagination
        const titleData = await api.getAllTitles(userUID)

        if (titleData) {
            return res.json({
                titleData,
            })
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
