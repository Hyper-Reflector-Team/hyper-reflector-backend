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
    console.log(req.body)
    getAuth().verifyIdToken(req.body.idToken).then(() => {
        console.log('found user')
    }).catch(err => {
        console.log('user touched api without being logged in', err)
    })
    res.send('Hello World!')
    testCommand('weeeeeee')
    console.log('hey we got a request')
    // console.log(req)
})

app.listen(port, () => {
    console.log(`Example app listening on port ${port}`)
})


app.use(express.urlencoded({ extended: true })) // for parsing application/x-www-form-urlencoded
