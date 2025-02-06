const { initializeApp, applicationDefault, cert } = require('firebase-admin/app');
const { getFirestore, Timestamp, FieldValue, Filter } = require('firebase-admin/firestore');

const serviceAccount = require('./keys/service_account_key.json');
initializeApp({
    credential: cert(serviceAccount)
});

const db = getFirestore();

const docRef = db.collection('users').doc('alovelace');


// Write new user to db
async function test() {
    console.log(docRef)
    await docRef.set({
        first: 'Ada',
        last: 'Lovelace',
        born: 1815
    });
}

test()