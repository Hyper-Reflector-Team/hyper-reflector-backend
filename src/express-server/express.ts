const express = require('express')
const app = express()
const port = 8080
// firebase
const { initializeApp, applicationDefault, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, Timestamp, FieldValue, Filter } = require('firebase-admin/firestore');
const serviceAccount = require('../../keys/service_account_key.json');

initializeApp({
    credential: cert(serviceAccount)
});

// firebase related commands 
const db = getFirestore();
const docRef = db.collection('users').doc('alovelace');

// Write new user to db
async function testCommand(name) {
    await docRef.set({
        first: name,
        last: 'Lovelace',
        born: 1815
    });
}

app.use(express.json()) // for parsing application/json


// SERVER
app.post('/test', (req, res) => {
    // if user cannot be verified kick them out of the request
    getAuth().verifyIdToken(req.body.idToken).then((decodedToken) => {
        const uid = decodedToken.uid;
        console.log('successful request by: ', uid)
        res.send('Hello World!')
        testCommand('weeeeeee')
    }).catch(err => {
        console.log('user touched api without being logged in', err)
    })
})

app.listen(port, () => {
    console.log(`Example app listening on port ${port}`)
})


app.use(express.urlencoded({ extended: true })) // for parsing application/x-www-form-urlencoded
