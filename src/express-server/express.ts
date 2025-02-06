const express = require('express')
const app = express()
const port = 3478
const firebaseCommands = require('../firebase')

app.get('/test', (req, res) => {
    res.send('Hello World!')
    firebaseCommands.test('weeeeeee')
    console.log('hey we got a reques', JSON.stringify(req))
})

app.listen(port, () => {
    console.log(`Example app listening on port ${port}`)
})