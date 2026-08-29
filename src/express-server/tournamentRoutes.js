const { getAuth } = require('firebase-admin/auth')
const data = require('./tournamentData')

function errorStatus(message) {
    if (message === 'Tournament not found' || message === 'Match not found' || message === 'User not found') return 404
    if (message === 'Only the organizer can do that') return 403
    return 400
}

function registerTournamentRoutes(app) {
    app.post('/tournament/create', async (req, res) => {
        try {
            const decodedToken = await getAuth().verifyIdToken(req.body.idToken)
            const { name, description, gameName, format, maxParticipants, startDate, timezone } = req.body
            const tournament = await data.createTournament({
                name,
                description,
                gameName,
                format,
                maxParticipants,
                startDate,
                timezone,
                organizerUid: decodedToken.uid,
            })
            res.json({ tournament })
        } catch (err) {
            console.error('tournament/create failed', err)
            res.status(errorStatus(err.message)).json({ error: err.message || 'Server error' })
        }
    })

    app.post('/tournament/get', async (req, res) => {
        try {
            await getAuth().verifyIdToken(req.body.idToken)
            const tournament = await data.getTournament(req.body.tournamentId)
            if (!tournament) return res.status(404).json({ error: 'Tournament not found' })
            res.json({ tournament })
        } catch (err) {
            console.error('tournament/get failed', err)
            res.status(500).json({ error: 'Server error' })
        }
    })

    app.post('/tournament/list', async (req, res) => {
        try {
            await getAuth().verifyIdToken(req.body.idToken)
            const { tournaments, nextCursor } = await data.listTournaments(req.body.limit, req.body.cursor)
            res.json({ tournaments, nextCursor })
        } catch (err) {
            console.error('tournament/list failed', err)
            res.status(500).json({ error: 'Server error' })
        }
    })

    app.post('/tournament/registrations', async (req, res) => {
        try {
            await getAuth().verifyIdToken(req.body.idToken)
            const registrations = await data.listRegistrations(req.body.tournamentId)
            res.json({ registrations })
        } catch (err) {
            console.error('tournament/registrations failed', err)
            res.status(500).json({ error: 'Server error' })
        }
    })

    app.post('/tournament/matches', async (req, res) => {
        try {
            await getAuth().verifyIdToken(req.body.idToken)
            const matches = await data.listMatches(req.body.tournamentId)
            res.json({ matches })
        } catch (err) {
            console.error('tournament/matches failed', err)
            res.status(500).json({ error: 'Server error' })
        }
    })

    app.post('/tournament/register', async (req, res) => {
        try {
            const decodedToken = await getAuth().verifyIdToken(req.body.idToken)
            const result = await data.registerForTournament(req.body.tournamentId, decodedToken.uid)
            res.json(result)
        } catch (err) {
            console.error('tournament/register failed', err)
            res.status(errorStatus(err.message)).json({ error: err.message || 'Server error' })
        }
    })

    app.post('/tournament/withdraw', async (req, res) => {
        try {
            const decodedToken = await getAuth().verifyIdToken(req.body.idToken)
            const result = await data.withdrawFromTournament(req.body.tournamentId, decodedToken.uid)
            res.json(result)
        } catch (err) {
            console.error('tournament/withdraw failed', err)
            res.status(errorStatus(err.message)).json({ error: err.message || 'Server error' })
        }
    })

    app.post('/tournament/generate-bracket', async (req, res) => {
        try {
            const decodedToken = await getAuth().verifyIdToken(req.body.idToken)
            const result = await data.generateBracket(req.body.tournamentId, decodedToken.uid, req.body.seedBy)
            res.json(result)
        } catch (err) {
            console.error('tournament/generate-bracket failed', err)
            res.status(errorStatus(err.message)).json({ error: err.message || 'Server error' })
        }
    })

    app.post('/tournament/assign-slot', async (req, res) => {
        try {
            const decodedToken = await getAuth().verifyIdToken(req.body.idToken)
            const { tournamentId, matchId, slotNum, uid } = req.body
            const result = await data.assignSlot(tournamentId, matchId, slotNum, uid || null, decodedToken.uid)
            res.json(result)
        } catch (err) {
            console.error('tournament/assign-slot failed', err)
            res.status(errorStatus(err.message)).json({ error: err.message || 'Server error' })
        }
    })

    app.post('/tournament/add-mock-players', async (req, res) => {
        try {
            const decodedToken = await getAuth().verifyIdToken(req.body.idToken)
            const { tournamentId, count } = req.body
            const result = await data.addMockRegistrations(tournamentId, count, decodedToken.uid)
            res.json(result)
        } catch (err) {
            console.error('tournament/add-mock-players failed', err)
            res.status(errorStatus(err.message)).json({ error: err.message || 'Server error' })
        }
    })

    app.post('/tournament/remove-registration', async (req, res) => {
        try {
            const decodedToken = await getAuth().verifyIdToken(req.body.idToken)
            const { tournamentId, uid } = req.body
            const result = await data.removeRegistration(tournamentId, uid, decodedToken.uid)
            res.json(result)
        } catch (err) {
            console.error('tournament/remove-registration failed', err)
            res.status(errorStatus(err.message)).json({ error: err.message || 'Server error' })
        }
    })

    app.post('/tournament/start', async (req, res) => {
        try {
            const decodedToken = await getAuth().verifyIdToken(req.body.idToken)
            const result = await data.startTournament(req.body.tournamentId, decodedToken.uid, req.body.seedBy)
            res.json(result)
        } catch (err) {
            console.error('tournament/start failed', err)
            res.status(errorStatus(err.message)).json({ error: err.message || 'Server error' })
        }
    })

    app.post('/tournament/pause', async (req, res) => {
        try {
            const decodedToken = await getAuth().verifyIdToken(req.body.idToken)
            const result = await data.pauseTournament(req.body.tournamentId, decodedToken.uid)
            res.json(result)
        } catch (err) {
            console.error('tournament/pause failed', err)
            res.status(errorStatus(err.message)).json({ error: err.message || 'Server error' })
        }
    })

    app.post('/tournament/resume', async (req, res) => {
        try {
            const decodedToken = await getAuth().verifyIdToken(req.body.idToken)
            const result = await data.resumeTournament(req.body.tournamentId, decodedToken.uid)
            res.json(result)
        } catch (err) {
            console.error('tournament/resume failed', err)
            res.status(errorStatus(err.message)).json({ error: err.message || 'Server error' })
        }
    })

    app.post('/tournament/cancel', async (req, res) => {
        try {
            const decodedToken = await getAuth().verifyIdToken(req.body.idToken)
            const result = await data.cancelTournament(req.body.tournamentId, decodedToken.uid)
            res.json(result)
        } catch (err) {
            console.error('tournament/cancel failed', err)
            res.status(errorStatus(err.message)).json({ error: err.message || 'Server error' })
        }
    })

    app.post('/tournament/report-match', async (req, res) => {
        try {
            const decodedToken = await getAuth().verifyIdToken(req.body.idToken)
            const { tournamentId, matchId, winnerUid } = req.body
            const result = await data.reportMatchWinner(tournamentId, matchId, winnerUid, decodedToken.uid)
            res.json(result)
        } catch (err) {
            console.error('tournament/report-match failed', err)
            res.status(errorStatus(err.message)).json({ error: err.message || 'Server error' })
        }
    })

    app.post('/tournament/revert-match', async (req, res) => {
        try {
            const decodedToken = await getAuth().verifyIdToken(req.body.idToken)
            const { tournamentId, matchId } = req.body
            const result = await data.revertMatchWinner(tournamentId, matchId, decodedToken.uid)
            res.json(result)
        } catch (err) {
            console.error('tournament/revert-match failed', err)
            res.status(errorStatus(err.message)).json({ error: err.message || 'Server error' })
        }
    })

    app.post('/tournament/update', async (req, res) => {
        try {
            const decodedToken = await getAuth().verifyIdToken(req.body.idToken)
            const { tournamentId, name, description, gameName, startDate, timezone, maxParticipants } = req.body
            const result = await data.updateTournamentDetails(tournamentId, decodedToken.uid, {
                name,
                description,
                gameName,
                startDate,
                timezone,
                maxParticipants,
            })
            res.json(result)
        } catch (err) {
            console.error('tournament/update failed', err)
            res.status(errorStatus(err.message)).json({ error: err.message || 'Server error' })
        }
    })

    app.post('/tournament/player-history', async (req, res) => {
        try {
            await getAuth().verifyIdToken(req.body.idToken)
            const { entries, nextCursor } = await data.getPlayerTournamentHistory(req.body.uid, req.body.limit, req.body.cursor)
            res.json({ entries, nextCursor })
        } catch (err) {
            console.error('tournament/player-history failed', err)
            res.status(500).json({ error: 'Server error' })
        }
    })
}

module.exports = { registerTournamentRoutes }
