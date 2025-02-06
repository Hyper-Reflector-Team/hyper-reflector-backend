const express = require('express')
const app = express()
const port = 8080

app.get('/test', (req, res) => {
    res.send('Hello World!')
    testCommand('weeeeeee')
    console.log('hey we got a reques', JSON.stringify(req))
})

app.listen(port, () => {
    console.log(`Example app listening on port ${port}`)
})