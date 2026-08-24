const { getFirestore, FieldValue } = require('firebase-admin/firestore')
const { randomUUID } = require('crypto')
const engine = require('./tournamentEngine')

const db = getFirestore()
const usersRef = db.collection('users')
const tournamentsRef = db.collection('tournaments')
const historyRef = db.collection('tournament-history')

const NON_TERMINAL_STATUSES = ['registration_open', 'seeding', 'in_progress', 'paused']

async function lookupUserSummary(uid) {
    const snapshot = await usersRef.where('uid', '==', uid).limit(1).get()
    if (snapshot.empty) return null
    const data = snapshot.docs[0].data()
    return {
        uid,
        userName: data.userName || uid,
        countryCode: data.countryCode || '',
        accountElo: typeof data.accountElo === 'number' ? data.accountElo : 1200,
    }
}

function tournamentDocData(doc) {
    if (!doc.exists) return null
    return { id: doc.id, ...doc.data() }
}

async function createTournament({ name, description, gameName, format, maxParticipants, startDate, timezone, organizerUid }) {
    if (!name || !organizerUid) throw new Error('name and organizerUid are required')
    if (format !== 'single-elim' && format !== 'double-elim') throw new Error('format must be single-elim or double-elim')
    if (startDate && new Date(startDate).getTime() < Date.now()) throw new Error('startDate must be in the future')

    const docRef = tournamentsRef.doc()
    const tournament = {
        name,
        description: description || '',
        gameName: gameName || null,
        format,
        organizerUid,
        maxParticipants: maxParticipants || null,
        startDate: startDate || null,
        timezone: timezone || null,
        status: 'registration_open',
        createdAt: FieldValue.serverTimestamp(),
        startedAt: null,
        completedAt: null,
        cancelledAt: null,
    }
    await docRef.set(tournament)
    return { id: docRef.id, ...tournament }
}

async function getTournament(tournamentId) {
    const doc = await tournamentsRef.doc(tournamentId).get()
    return tournamentDocData(doc)
}

async function listTournaments(limit = 25, cursorId = null) {
    const pageSize = Math.min(Number(limit) || 25, 50)
    let query = tournamentsRef.orderBy('createdAt', 'desc').limit(pageSize)
    if (cursorId) {
        const cursorDoc = await tournamentsRef.doc(cursorId).get()
        if (cursorDoc.exists) query = query.startAfter(cursorDoc)
    }
    const snapshot = await query.get()
    const tournaments = snapshot.docs.map((doc) => tournamentDocData(doc))
    const lastDoc = snapshot.docs[snapshot.docs.length - 1]
    return { tournaments, nextCursor: lastDoc ? lastDoc.id : null }
}

async function listRegistrations(tournamentId) {
    const snapshot = await tournamentsRef.doc(tournamentId).collection('registrations').orderBy('registeredAt', 'asc').get()
    return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }))
}

async function registerForTournament(tournamentId, uid) {
    const userSummary = await lookupUserSummary(uid)
    if (!userSummary) throw new Error('User not found')

    const tournamentDocRef = tournamentsRef.doc(tournamentId)
    const registrationRef = tournamentDocRef.collection('registrations').doc(uid)

    return db.runTransaction(async (tx) => {
        const tournamentDoc = await tx.get(tournamentDocRef)
        if (!tournamentDoc.exists) throw new Error('Tournament not found')
        const tournament = tournamentDoc.data()
        if (tournament.status !== 'registration_open') throw new Error('Registration is not open for this tournament')

        const existing = await tx.get(registrationRef)
        if (existing.exists) throw new Error('Already registered')

        if (tournament.maxParticipants) {
            const countSnapshot = await tx.get(tournamentDocRef.collection('registrations'))
            if (countSnapshot.size >= tournament.maxParticipants) throw new Error('Tournament is full')
        }

        tx.set(registrationRef, {
            ...userSummary,
            seed: null,
            registeredAt: FieldValue.serverTimestamp(),
        })
        return { registered: true }
    })
}

async function withdrawFromTournament(tournamentId, uid) {
    const tournamentDocRef = tournamentsRef.doc(tournamentId)
    const registrationRef = tournamentDocRef.collection('registrations').doc(uid)

    return db.runTransaction(async (tx) => {
        const tournamentDoc = await tx.get(tournamentDocRef)
        if (!tournamentDoc.exists) throw new Error('Tournament not found')
        if (tournamentDoc.data().status !== 'registration_open') {
            throw new Error('Cannot withdraw once seeding has started — contact the organizer')
        }
        tx.delete(registrationRef)
        return { withdrawn: true }
    })
}

function assertOrganizer(tournament, uid) {
    if (!tournament) throw new Error('Tournament not found')
    if (tournament.organizerUid !== uid) throw new Error('Only the organizer can do that')
}

function orderParticipants(registrations, seedBy) {
    const list = registrations.map((r) => ({ uid: r.uid, userName: r.userName, accountElo: r.accountElo }))
    if (seedBy === 'rating') {
        list.sort((a, b) => (b.accountElo ?? 1200) - (a.accountElo ?? 1200))
    }
    return list.map(({ uid, userName }) => ({ uid, userName }))
}

async function generateBracket(tournamentId, organizerUid, seedBy = 'registration') {
    const tournamentDocRef = tournamentsRef.doc(tournamentId)
    const tournamentDoc = await tournamentDocRef.get()
    const tournament = tournamentDocData(tournamentDoc)
    assertOrganizer(tournament, organizerUid)

    if (tournament.status !== 'registration_open' && tournament.status !== 'seeding') {
        throw new Error(`Cannot generate a bracket from status ${tournament.status}`)
    }

    const registrations = await listRegistrations(tournamentId)
    if (registrations.length < 2) throw new Error('At least 2 registered players are required')

    const participants = orderParticipants(registrations, seedBy)
    const { matches } = engine.generateBracket(participants, tournament.format)

    const batch = db.batch()
    const matchesRef = tournamentDocRef.collection('matches')
    for (const match of matches) {
        batch.set(matchesRef.doc(match.id), match)
    }
    batch.update(tournamentDocRef, { status: 'seeding' })
    await batch.commit()

    return { matches }
}

async function addMockRegistrations(tournamentId, count, organizerUid) {
    const tournamentDocRef = tournamentsRef.doc(tournamentId)
    const tournament = await getTournament(tournamentId)
    assertOrganizer(tournament, organizerUid)
    if (tournament.status !== 'registration_open') throw new Error('Mock players can only be added while registration is open')

    const existing = await listRegistrations(tournamentId)
    const safeCount = Math.min(Math.max(Number(count) || 0, 1), 64)

    const batch = db.batch()
    const created = []
    for (let i = 0; i < safeCount; i++) {
        if (tournament.maxParticipants && existing.length + created.length >= tournament.maxParticipants) break
        const uid = `mock-${randomUUID().slice(0, 8)}`
        const registration = {
            uid,
            userName: `Mock Player ${existing.length + created.length + 1}`,
            countryCode: '',
            accountElo: 1200,
            seed: null,
            isMock: true,
            registeredAt: FieldValue.serverTimestamp(),
        }
        batch.set(tournamentDocRef.collection('registrations').doc(uid), registration)
        created.push(registration)
    }
    await batch.commit()
    return { added: created.length }
}

async function removeRegistration(tournamentId, uid, organizerUid) {
    const tournament = await getTournament(tournamentId)
    assertOrganizer(tournament, organizerUid)
    if (tournament.status !== 'registration_open') throw new Error('Registrations can only be removed while registration is open')
    await tournamentsRef.doc(tournamentId).collection('registrations').doc(uid).delete()
    return { removed: true }
}

async function startTournament(tournamentId, organizerUid, seedBy = 'registration') {
    const tournamentDocRef = tournamentsRef.doc(tournamentId)
    const tournamentDoc = await tournamentDocRef.get()
    const tournament = tournamentDocData(tournamentDoc)
    assertOrganizer(tournament, organizerUid)
    if (tournament.status !== 'registration_open' && tournament.status !== 'seeding') {
        throw new Error(`Cannot start from status ${tournament.status}`)
    }

    if (tournament.status === 'registration_open') {
        const registrations = await listRegistrations(tournamentId)
        if (registrations.length < 2) throw new Error('At least 2 registered players are required')
        const participants = orderParticipants(registrations, seedBy)
        const { matches } = engine.generateBracket(participants, tournament.format)

        const batch = db.batch()
        const matchesRef = tournamentDocRef.collection('matches')
        for (const match of matches) {
            batch.set(matchesRef.doc(match.id), match)
        }
        batch.update(tournamentDocRef, { status: 'in_progress', startedAt: FieldValue.serverTimestamp() })
        await batch.commit()
    } else {
        await tournamentDocRef.update({ status: 'in_progress', startedAt: FieldValue.serverTimestamp() })
    }

    return { started: true }
}

async function listMatches(tournamentId) {
    const snapshot = await tournamentsRef.doc(tournamentId).collection('matches').get()
    return snapshot.docs.map((doc) => doc.data())
}
async function assignSlot(tournamentId, matchId, slotNum, uid, organizerUid) {
    const tournamentDocRef = tournamentsRef.doc(tournamentId)
    const tournament = await getTournament(tournamentId)
    assertOrganizer(tournament, organizerUid)
    if (tournament.status === 'cancelled') throw new Error('Cannot edit a cancelled tournament')
    if (slotNum !== 1 && slotNum !== 2) throw new Error('slotNum must be 1 or 2')

    const matchRef = tournamentDocRef.collection('matches').doc(matchId)
    const matchDoc = await matchRef.get()
    if (!matchDoc.exists) throw new Error('Match not found')
    const matchData = matchDoc.data()

    if (matchData.bracketType !== 'winners' || matchData.round !== 1) {
        throw new Error('Only winners-bracket round-1 slots can be reassigned')
    }
    if (matchData.status === 'reported' || matchData.status === 'bye') {
        throw new Error('This match has already been played and can no longer be reassigned')
    }

    let slotData = { uid: null, userName: null, isBye: true }
    if (uid) {
        const registrations = await listRegistrations(tournamentId)
        const registration = registrations.find((r) => r.uid === uid)
        if (!registration) throw new Error('User not found')
        slotData = { uid: registration.uid, userName: registration.userName, isBye: false }
    }

    const field = slotNum === 1 ? 'slot1' : 'slot2'
    await matchRef.update({ [field]: slotData })
    return { updated: true }
}

async function setStatus(tournamentId, organizerUid, fromStatuses, toStatus, extraFields = {}) {
    const tournament = await getTournament(tournamentId)
    assertOrganizer(tournament, organizerUid)
    if (!fromStatuses.includes(tournament.status)) {
        throw new Error(`Cannot move to ${toStatus} from status ${tournament.status}`)
    }
    await tournamentsRef.doc(tournamentId).update({ status: toStatus, ...extraFields })
    return { status: toStatus }
}

async function pauseTournament(tournamentId, organizerUid) {
    return setStatus(tournamentId, organizerUid, ['in_progress'], 'paused')
}

async function resumeTournament(tournamentId, organizerUid) {
    return setStatus(tournamentId, organizerUid, ['paused'], 'in_progress')
}

async function cancelTournament(tournamentId, organizerUid) {
    return setStatus(tournamentId, organizerUid, NON_TERMINAL_STATUSES, 'cancelled', {
        cancelledAt: FieldValue.serverTimestamp(),
    })
}

async function reportMatchWinner(tournamentId, matchId, winnerUid, organizerUid) {
    const tournamentDocRef = tournamentsRef.doc(tournamentId)
    const tournament = await getTournament(tournamentId)
    assertOrganizer(tournament, organizerUid)
    if (tournament.status !== 'in_progress') throw new Error(`Cannot report a match while tournament status is ${tournament.status}`)

    const existingMatches = await listMatches(tournamentId)
    const result = engine.advanceMatch(existingMatches, matchId, winnerUid)

    const batch = db.batch()
    const matchesRef = tournamentDocRef.collection('matches')
    for (const match of result.matches) {
        batch.set(matchesRef.doc(match.id), match)
    }

    if (result.completed) {
        batch.update(tournamentDocRef, { status: 'completed', completedAt: FieldValue.serverTimestamp() })
    }
    await batch.commit()

    if (result.completed) {
        const participantCount = result.placements.length
        await Promise.all(
            result.placements.map((p) =>
                historyRef
                    .doc(p.uid)
                    .collection('entries')
                    .doc(tournamentId)
                    .set({
                        tournamentName: tournament.name,
                        format: tournament.format,
                        placement: p.placement,
                        note: p.note || null,
                        participantCount,
                        completedAt: FieldValue.serverTimestamp(),
                    })
            )
        )
    }

    return result
}

async function revertMatchWinner(tournamentId, matchId, organizerUid) {
    const tournamentDocRef = tournamentsRef.doc(tournamentId)
    const tournament = await getTournament(tournamentId)
    assertOrganizer(tournament, organizerUid)
    if (!['in_progress', 'paused', 'completed'].includes(tournament.status)) {
        throw new Error(`Cannot revert a match while tournament status is ${tournament.status}`)
    }

    const existingMatches = await listMatches(tournamentId)
    const { matches, wasFinal } = engine.revertMatch(existingMatches, matchId)

    const batch = db.batch()
    const matchesRef = tournamentDocRef.collection('matches')
    for (const match of matches) {
        batch.set(matchesRef.doc(match.id), match)
    }

    const uncompleting = wasFinal && tournament.status === 'completed'
    if (uncompleting) {
        batch.update(tournamentDocRef, { status: 'in_progress', completedAt: null })
    }
    await batch.commit()

    if (uncompleting) {
        const registrations = await listRegistrations(tournamentId)
        await Promise.all(
            registrations.map((r) => historyRef.doc(r.uid).collection('entries').doc(tournamentId).delete())
        )
    }

    return { matches, reverted: true }
}

async function updateTournamentDetails(tournamentId, organizerUid, { name, description, gameName, startDate, timezone, maxParticipants }) {
    const tournament = await getTournament(tournamentId)
    assertOrganizer(tournament, organizerUid)

    if (name !== undefined && !name.trim()) throw new Error('name is required')
    if (maxParticipants !== undefined && maxParticipants !== null) {
        const registrations = await listRegistrations(tournamentId)
        if (maxParticipants < registrations.length) {
            throw new Error('maxParticipants cannot be lower than the current registration count')
        }
    }

    if (startDate !== undefined && startDate && tournament.status === 'registration_open') {
        if (new Date(startDate).getTime() < Date.now()) throw new Error('startDate must be in the future')
    }

    const fields = { name, description, gameName, startDate, timezone, maxParticipants }
    const updates = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined))
    if (Object.keys(updates).length === 0) return { updated: false }

    await tournamentsRef.doc(tournamentId).update(updates)
    return { updated: true }
}

async function getPlayerTournamentHistory(uid, limit = 10, cursorId = null) {
    const pageSize = Math.min(Number(limit) || 10, 50)
    let query = historyRef.doc(uid).collection('entries').orderBy('completedAt', 'desc').limit(pageSize)
    if (cursorId) {
        const cursorDoc = await historyRef.doc(uid).collection('entries').doc(cursorId).get()
        if (cursorDoc.exists) query = query.startAfter(cursorDoc)
    }
    const snapshot = await query.get()
    const entries = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }))
    const lastDoc = snapshot.docs[snapshot.docs.length - 1]
    return { entries, nextCursor: lastDoc ? lastDoc.id : null }
}

module.exports = {
    createTournament,
    getTournament,
    listTournaments,
    listRegistrations,
    registerForTournament,
    withdrawFromTournament,
    generateBracket,
    listMatches,
    assignSlot,
    addMockRegistrations,
    removeRegistration,
    startTournament,
    pauseTournament,
    resumeTournament,
    cancelTournament,
    reportMatchWinner,
    revertMatchWinner,
    updateTournamentDetails,
    getPlayerTournamentHistory,
}
