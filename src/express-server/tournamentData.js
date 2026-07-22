// Firestore data access for the tournament feature. Kept separate from
// firebaseCalls.js (which is already large and covers the unrelated user/match
// domain) so this feature stays a self-contained module — see the tournament
// feature plan for why that matters here.
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

async function createTournament({ name, description, gameName, format, maxParticipants, startDate, organizerUid }) {
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
        // Planned/advertised date, set by the organizer at creation time — purely
        // informational. Distinct from `startedAt`, which is the real timestamp
        // stamped when the tournament actually moves to in_progress.
        startDate: startDate || null,
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

async function generateBracket(tournamentId, organizerUid) {
    const tournamentDocRef = tournamentsRef.doc(tournamentId)
    const tournamentDoc = await tournamentDocRef.get()
    const tournament = tournamentDocData(tournamentDoc)
    assertOrganizer(tournament, organizerUid)
    if (tournament.status !== 'registration_open') throw new Error(`Cannot generate a bracket from status ${tournament.status}`)

    const registrations = await listRegistrations(tournamentId)
    if (registrations.length < 2) throw new Error('At least 2 registered players are required')

    // Default seed order = registration order; organizer can rearrange via assignSlot afterwards.
    const participants = registrations.map((r) => ({ uid: r.uid, userName: r.userName }))
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

// Synthetic registrants for testing bracket layouts without needing real
// accounts. Marked isMock so the UI can label them and the organizer can
// remove them individually via removeRegistration.
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

// Organizer removal of any registrant (real or mock) while registration is
// still open — separate from self-withdraw, which only the registrant can do.
async function removeRegistration(tournamentId, uid, organizerUid) {
    const tournament = await getTournament(tournamentId)
    assertOrganizer(tournament, organizerUid)
    if (tournament.status !== 'registration_open') throw new Error('Registrations can only be removed while registration is open')
    await tournamentsRef.doc(tournamentId).collection('registrations').doc(uid).delete()
    return { removed: true }
}

// Combined generate-bracket + lock-start in a single step, for organizers who
// don't need to rearrange seeding first. Also usable from 'seeding' to lock in
// a bracket that was already generated and manually rearranged via assignSlot.
async function startTournament(tournamentId, organizerUid) {
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
        const participants = registrations.map((r) => ({ uid: r.uid, userName: r.userName }))
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

// "Move players around" — only valid for round-1 slots (the bracket's true
// leaves) while the tournament is still in the seeding phase, before any
// match has been played.
async function assignSlot(tournamentId, matchId, slotNum, uid, organizerUid) {
    const tournamentDocRef = tournamentsRef.doc(tournamentId)
    const tournament = await getTournament(tournamentId)
    assertOrganizer(tournament, organizerUid)
    if (tournament.status !== 'seeding') throw new Error('Slots can only be rearranged during seeding')
    if (slotNum !== 1 && slotNum !== 2) throw new Error('slotNum must be 1 or 2')

    const matchRef = tournamentDocRef.collection('matches').doc(matchId)
    const matchDoc = await matchRef.get()
    if (!matchDoc.exists) throw new Error('Match not found')
    const matchData = matchDoc.data()
    // Only the bracket's true leaves (winners round 1) are manually assignable —
    // every other slot is populated automatically via match-result propagation.
    if (matchData.bracketType !== 'winners' || matchData.round !== 1) {
        throw new Error('Only winners-bracket round-1 slots can be reassigned')
    }

    let slotData = { uid: null, userName: null, isBye: true }
    if (uid) {
        // Look up the name from this tournament's own registrations rather than
        // the global users collection — mock test registrants (see
        // addMockRegistrations) don't exist there, and a registrant's snapshot
        // name at registration time is the correct source of truth here anyway.
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
    getPlayerTournamentHistory,
}
