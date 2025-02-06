const { initializeApp, applicationDefault, cert } = require('firebase-admin/app');
const { getFirestore, Timestamp, FieldValue, Filter } = import('firebase-admin/firestore');

const serviceAccount = import('./keys/service_account_key.json');
initializeApp({
    credential: cert(serviceAccount)
});

const db = getFirestore();

const docRef = db.collection('users').doc('alovelace');

await docRef.set({
    first: 'Ada',
    last: 'Lovelace',
    born: 1815
});

// export { }

// try {
//     const docRef = await addDoc(collection(db, "users"), {
//       first: "Ada",
//       last: "Lovelace",
//       born: 1815
//     });
//     console.log("Document written with ID: ", docRef.id);
//   } catch (e) {
//     console.error("Error adding document: ", e);
//   }