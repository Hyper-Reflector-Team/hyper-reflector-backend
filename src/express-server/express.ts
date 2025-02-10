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
    console.log(userEmail, token)
    await logInUserRef.doc(userEmail).set({
        token,
    })
}

async function fetchLoggedInUser(userEmail) {
    const doc = await logInUserRef.doc(userEmail).get()
    if (doc.exists) {
        console.log('we got doc from backend', doc.data())
        return doc.data()
    }
    console.log('failed to find')
    return 'failure'
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
        console.log('setting user')
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
        console.log('setting user name')
        await usersRef.doc(querySnapshot).set({
            userName: name,
        })
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

app.use(express.json()) // for parsing application/json

// SERVER
//expects a user token from firebase auth to verify
app.post('/validate-token', (req, res) => {
    // if user cannot be verified kick them out of the request

    getAuth()
        .verifyIdToken(req.body.idToken)
        .then((decodedToken) => {
            const uid = decodedToken.uid
            console.log('successful request by: ', uid)
            res.send('ok')
        })
        .catch((err) => {
            console.log('user touched api without being logged in', err)
            res.send('no-ok')
        })
})

app.post('/test', (req, res) => {
    // if user cannot be verified kick them out of the request
    getAuth()
        .verifyIdToken(req.body.idToken)
        .then((decodedToken) => {
            const uid = decodedToken.uid
            console.log('successful request by: ', uid)
            res.send('Hello World!')
            testCommand('weeeeeee')
        })
        .catch((err) => {
            console.log('user touched api without being logged in', err)
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

app.post('/get-logged-in', (req, res) => {
    try {
        console.log('request')
        const data = fetchLoggedInUser(req.body.userEmail)
        return res.json({ message: data })
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
            console.log('trying to create an account')
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
        console.log(data)
        return res.json(data)
    } catch (err) {
        console.log('user touched api without being logged in', err)
        res.status(500).json({ err: 'server error' })
    }
})

// init listen
app.listen(port, () => {
    console.log(`Example app listening on port ${port}`)
})

app.use(express.urlencoded({ extended: true })) // for parsing application/x-www-form-urlencoded
