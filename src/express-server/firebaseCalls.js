const { getAuth } = require('firebase-admin/auth')
const { getFirestore, FieldValue } = require('firebase-admin/firestore')
const gravatar = require('gravatar.js')
const axios = require('axios')
const dataConverter = require('./data')
const { calculateNewElo } = require('./utils')
const serverInfo = require('../../keys/server.ts')

// firebase related commands
const db = getFirestore()

const usersRef = db.collection('users')
const logInUserRef = db.collection('logged-in')
const winStreaksRef = db.collection('user-win-streaks')
const SIGNAL_PORT = process.env.VNEW_SIGNAL_PORT || serverInfo?.SIGNAL_PORT || '3004'
const SIGNAL_HOST = process.env.VNEW_SIGNAL_HOST || serverInfo?.COTURN_IP || '127.0.0.1'
const DEFAULT_RPS_ELO = 1200

function sanitizeUserRecord(data) {
    if (!data) return null
const allowedFields = [
        'uid',
        'userName',
        'userProfilePic',
        'userTitle',
        'accountElo',
        'countryCode',
        'knownAliases',
        'winStreak',
        'longestWinStreak',
        'lastKnownPings',
        'pingLat',
        'pingLon',
        'gravEmail',
        'role',
        'assignedFlairs',
        'rpsElo',
        'sidePreferences',
    ]
    const sanitized = {}
    allowedFields.forEach((field) => {
        if (data[field] !== undefined) {
            sanitized[field] = data[field]
        }
    })
    if (sanitized.winStreak === undefined && typeof data.winstreak === 'number') {
        sanitized.winStreak = data.winstreak
    }
    delete sanitized.winstreak
    sanitized.sidePreferences = sanitizeSidePreferencesMap(data.sidePreferences)
    return sanitized
}

function sanitizeSidePreferencesMap(input) {
    if (!input || typeof input !== 'object') return {}
    const now = Date.now()
    return Object.entries(input).reduce((acc, [key, value]) => {
        if (!value || typeof value !== 'object') return acc
        const side = value.side === 'player2' ? 'player2' : value.side === 'player1' ? 'player1' : null
        const expiresAt = typeof value.expiresAt === 'number' ? value.expiresAt : 0
        if (!side || expiresAt <= now) return acc
        const ownerUid =
            typeof value.ownerUid === 'string' && value.ownerUid.length ? value.ownerUid : ''
        const opponentUid =
            typeof value.opponentUid === 'string' && value.opponentUid.length ? value.opponentUid : key
        if (!ownerUid || !opponentUid) return acc
        acc[key] = { side, ownerUid, opponentUid, expiresAt }
        return acc
    }, {})
}

async function getUserDocByUid(uid) {
    if (!uid) return null
    const snapshot = await usersRef.where('uid', '==', uid).limit(1).get()
    if (snapshot.empty) return null
    return snapshot.docs[0]
}

function resolveRpsElo(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_RPS_ELO
}

function calculateEloRating(current, opponent, score, k = 32) {
    const expected = 1 / (1 + Math.pow(10, (opponent - current) / 400))
    const nextRating = current + k * (score - expected)
    return Math.max(0, Math.round(nextRating))
}

async function upsertUserWinStreak(uid, current, longest) {
    if (!uid) return
    const userDoc = await getUserDocByUid(uid)
    if (userDoc) {
        await userDoc.ref.set(
            {
                winStreak: current,
                longestWinStreak: longest,
            },
            { merge: true }
        )
    }
}

async function updateWinStreakRecord(uid, playerWon) {
    if (!uid) return null
    const result = await db.runTransaction(async (transaction) => {
        const docRef = winStreaksRef.doc(uid)
        const snapshot = await transaction.get(docRef)
        const data = snapshot.exists ? snapshot.data() : {}
        const safeCurrent = typeof data.current === 'number' ? data.current : 0
        const safeLongest = typeof data.longest === 'number' ? data.longest : 0
        const nextCurrent = playerWon ? safeCurrent + 1 : 0
        const nextLongest = Math.max(nextCurrent, safeLongest)
        transaction.set(
            docRef,
            {
                current: nextCurrent,
                longest: nextLongest,
                lastResult: playerWon ? 'win' : 'loss',
                updatedAt: Date.now(),
            },
            { merge: true }
        )
        return { current: nextCurrent, longest: nextLongest }
    })
    await upsertUserWinStreak(uid, result.current, result.longest)
    return result
}

async function notifySocketWinStreak(uid, winStreak) {
    if (!uid || typeof winStreak !== 'number') return
    try {
        await axios.post(
            `http://${SIGNAL_HOST}:${SIGNAL_PORT}/internal/win-streak`,
            {
                uid,
                winStreak,
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${serverInfo.SERVER_SECRET}`,
                },
                timeout: 2500,
            }
        )
    } catch (error) {
        console.warn('Failed to notify websocket server about win streak update', error.message || error)
    }
}

async function recordRpsResult({ challengerUid, opponentUid, winnerUid }) {
    if (!challengerUid || !opponentUid) {
        return { ratings: {} }
    }
    const [challengerDoc, opponentDoc] = await Promise.all([
        getUserDocByUid(challengerUid),
        getUserDocByUid(opponentUid),
    ])
    if (!challengerDoc || !opponentDoc) {
        return { ratings: {} }
    }
    const challengerData = challengerDoc.data() || {}
    const opponentData = opponentDoc.data() || {}
    const challengerElo = resolveRpsElo(challengerData.rpsElo)
    const opponentElo = resolveRpsElo(opponentData.rpsElo)
    const challengerScore =
        winnerUid === challengerUid ? 1 : winnerUid === opponentUid ? 0 : 0.5
    const opponentScore = 1 - challengerScore
    const nextChallenger = calculateEloRating(challengerElo, opponentElo, challengerScore)
    const nextOpponent = calculateEloRating(opponentElo, challengerElo, opponentScore)

    await Promise.all([
        challengerDoc.ref.set({ rpsElo: nextChallenger }, { merge: true }),
        opponentDoc.ref.set({ rpsElo: nextOpponent }, { merge: true }),
    ])

    return {
        ratings: {
            [challengerUid]: nextChallenger,
            [opponentUid]: nextOpponent,
        },
    }
}

async function setSidePreference(ownerUid, opponentUid, side) {
    if (!ownerUid || !opponentUid) return null
    if (ownerUid === opponentUid) return null
    const normalizedSide = side === 'player2' ? 'player2' : side === 'player1' ? 'player1' : null
    if (!normalizedSide) return null

    const [ownerDoc, opponentDoc] = await Promise.all([
        getUserDocByUid(ownerUid),
        getUserDocByUid(opponentUid),
    ])
    if (!ownerDoc || !opponentDoc) return null

    const expiresAt = Date.now() + 60 * 60 * 1000
    const ownerPrefs = sanitizeSidePreferencesMap(ownerDoc.data()?.sidePreferences || {})
    const opponentPrefs = sanitizeSidePreferencesMap(opponentDoc.data()?.sidePreferences || {})

    ownerPrefs[opponentUid] = {
        side: normalizedSide,
        ownerUid,
        opponentUid,
        expiresAt,
    }
    opponentPrefs[ownerUid] = {
        side: normalizedSide === 'player1' ? 'player2' : 'player1',
        ownerUid,
        opponentUid: ownerUid,
        expiresAt,
    }

    await Promise.all([
        ownerDoc.ref.set({ sidePreferences: ownerPrefs }, { merge: true }),
        opponentDoc.ref.set({ sidePreferences: opponentPrefs }, { merge: true }),
    ])

    return {
        ownerEntry: ownerPrefs[opponentUid],
        opponentEntry: opponentPrefs[ownerUid],
    }
}

async function addLoggedInUser(userEmail, token) {
    if (userEmail && token) {
        await logInUserRef.doc(userEmail).set({
            token,
        })
    }
}

async function fetchLoggedInUser(userEmail) {
    if (userEmail && userEmail.length) {
        const doc = await logInUserRef.doc(userEmail).get()
        if (doc.exists) {
            return true
        }
        return false
    }
    return 'something something'
}

async function removeLoggedInUser(userEmail) {
    if (!userEmail?.length) return
    const data = await logInUserRef.doc(userEmail).delete()
    if (data) {
        console.log(data)
    }
}

async function createAccount({ name, email }, token) {
    if (!token) return
    const querySnapshot = await usersRef.where('uid', '==', token).get()
    if (querySnapshot.empty) {
        // create a new user
        await usersRef.doc(email).set({
            userEmail: email,
            userName: name,
            userProfilePic: null,
            uid: token,
        })
    } else {
        return null
    }
}

async function updateUserData(data, token) {
    if (!token) return

    const allowedFields = [
        'userName',
        'userTitle',
        'knownAliases',
        'countryCode',
        'lastKnownPings',
        'pingLat',
        'pingLon',
        'userProfilePic',
        'gravEmail',
        'winStreak',
        'elo',
    ]
    const validData = Object.keys(data)
        .filter((key) => allowedFields.includes(key))
        .reduce((obj, key) => ({ ...obj, [key]: data[key] }), {})

    if (Object.keys(validData).length === 0) return null

    const currentUserSnapshot = await usersRef.where('uid', '==', token).get()
    if (currentUserSnapshot.empty) return null

    const userDocRef = currentUserSnapshot.docs[0].ref
    const currentUserData = currentUserSnapshot.docs[0].data()

    const updates = {}

    for (const key of Object.keys(validData)) {
        const newValue = validData[key]
        const currentValue = currentUserData[key]

        if (newValue !== currentValue) {
            updates[key] = newValue
        }
    }

    if (validData.gravEmail) {
        try {
            const newProfilePic = await gravatar.resolve(validData.gravEmail)

            if (newProfilePic && newProfilePic !== currentUserData.userProfilePic) {
                updates.userProfilePic = newProfilePic
                if (validData.gravEmail !== currentUserData.gravEmail) {
                    updates.gravEmail = validData.gravEmail
                }
            }
        } catch (err) {
            updates.userProfilePic = null
        }
    }

    if (Object.keys(updates).length === 0) {
        console.log('No changes to update.')
        return
    }

    await userDocRef.set(updates, { merge: true })

    if (updates.userName) {
        await userDocRef.update({
            knownAliases: FieldValue.arrayUnion(updates.userName),
        })
    }

    // console.log('User updated:', updates)
}

async function getUserData(uid) {
    if (!uid) return
    const querySnapshot = await usersRef.where('uid', '==', uid).get()
    if (!querySnapshot.empty) {
        const doc = querySnapshot.docs[0]
        const { userEmail, ...filteredData } = doc.data() // exclude email
        return sanitizeUserRecord(filteredData)
    } else {
        return null
    }
}

async function getUserAccountByAuth(token) {
    if (!token) return
    const querySnapshot = await usersRef.where('uid', '==', token).get()
    if (!querySnapshot.empty) {
        console.log(querySnapshot.docs[0].data())
        return querySnapshot.docs[0].data()
    } else {
        return null
    }
}

// get custom token for auto log in
async function getCustomToken(idToken) {
    if (!idToken) return
    const customToken = await getAuth().createCustomToken(idToken)
    return customToken
}

// match related functions
async function getUserName(uid) {
    if (!uid) return
    const querySnapshot = await usersRef.where('uid', '==', uid).get()
    if (!querySnapshot.empty) {
        return querySnapshot.docs[0].data().userName
    } else {
        return null
    }
}

//get elo
async function getUserElo(uid) {
    if (!uid) return
    const querySnapshot = await usersRef.where('uid', '==', uid).get()
    if (!querySnapshot.empty) {
        return querySnapshot.docs[0].data().accountElo || 1200
    } else {
        return null
    }
}

async function uploadMatchData(matchData, uid) {
    if (!uid || !matchData.matchId) return
    if (uid === !matchData.player1) return

    const sessionRef = db.collection('global-matches').doc(matchData.matchId)
    const parsed = dataConverter.parseMatchData(matchData.matchData.raw)
    const p1Char = dataConverter.getCharacterByCode(parsed['player1-char'])
    const p2Char = dataConverter.getCharacterByCode(parsed['player2-char'])
    const matchResult = parsed['p1-win'] ? '1' : '2'
    const parsedMatchUuid = parsed['match-uuid'] || parsed['matchUuid']
    const matchUuid =
        (typeof parsedMatchUuid === 'string' && parsedMatchUuid.length > 0
            ? parsedMatchUuid
            : undefined) || `${matchData.matchId}-${Date.now()}`
    // used for updating counts
    let p1Wins = 0
    let p2Wins = 0

    const matchEntry = {
        // TODO fix this
        matchData: matchData.matchData, // this is a temporary fix to prevent massive raw data explosions
        timestamp: Date.now(),
        matchUuid,
        player1Char: p1Char || 'unknown',
        player2Char: p2Char || 'unknown',
        result: matchResult,
        player1Super: parsed['player1-super'],
        player2Super: parsed['player2-super'],
    }

    const entryGuardRef = db.collection('global-match-entries').doc(matchUuid)
    const didReserveEntry = await db.runTransaction(async (transaction) => {
        const entrySnapshot = await transaction.get(entryGuardRef)
        if (entrySnapshot.exists) {
            return false
        }
        transaction.set(entryGuardRef, {
            matchUuid,
            matchId: matchData.matchId,
            createdAt: Date.now(),
        })
        return true
    })

    if (!didReserveEntry) {
        console.log('Duplicate match detected globally, skipping upload:', matchUuid)
        return
    }

    const sessionSnap = await sessionRef.get()

    if (!sessionSnap.exists) {
        console.log('snap shot did not exist')
        // First match in session, create new document
        const firstP1Wins = matchResult === '1' ? 1 : 0
        const firstP2Wins = matchResult === '2' ? 1 : 0
        const session = {
            sessionId: matchData.matchId,
            player1: matchData.player1,
            player2: matchData.player2,
            player1Name: await getUserName(matchData.player1),
            player2Name: await getUserName(matchData.player2),
            matches: [matchEntry],
            player1Wins: firstP1Wins,
            player2Wins: firstP2Wins,
            timestamp: Date.now(),
        }

        await sessionRef.set(session)
        p1Wins = firstP1Wins
        p2Wins = firstP2Wins
    } else {
        console.log('snap shot did exist')
        // Get current matches first (avoid fetching *after* the update)
        const existingSession = sessionSnap.data()

        const allMatches = [...(existingSession.matches || []), matchEntry]

        for (const match of allMatches) {
            if (match.result === '1') p1Wins++
            if (match.result === '2') p2Wins++
        }

        // Single update
        await sessionRef.update({
            matches: FieldValue.arrayUnion(matchEntry),
            player1Wins: p1Wins,
            player2Wins: p2Wins,
        })
    }

    // recent match session meta data for player profile
    const player1Elo = (await getUserElo(matchData.player1)) || 1200
    const player2Elo = (await getUserElo(matchData.player2)) || 1200

    const p1Won = matchResult === '1'

    const streakUpdates = new Map()
    const streakPairs = [
        { uid: matchData.player1, didWin: matchResult === '1' },
        { uid: matchData.player2, didWin: matchResult === '2' },
    ]

    await Promise.all(
        streakPairs.map(async ({ uid, didWin }) => {
            if (!uid) return
            const result = await updateWinStreakRecord(uid, didWin)
            if (result) {
                streakUpdates.set(uid, result)
            }
        })
    )

    const newP1Elo = calculateNewElo(player1Elo, player2Elo, p1Won)
    const newP2Elo = calculateNewElo(player2Elo, player1Elo, !p1Won)

    console.log('P1 ELO before:', player1Elo, 'P2 ELO before:', player2Elo)
    console.log('P1 won?', p1Won, '→ P1 new ELO:', newP1Elo, 'P2 new ELO:', newP2Elo)

    await setUserElo(matchData.player1, newP1Elo)
    await setUserElo(matchData.player2, newP2Elo)

    const batch = db.batch()
    for (const player of [matchData.player1, matchData.player2]) {
        if (!player) continue
        const ref = db
            .collection('recent-matches')
            .doc(player)
            .collection('sessions')
            .doc(matchData.matchId)
        batch.set(
            ref,
            {
                player1Name: await getUserName(matchData.player1),
                player2Name: await getUserName(matchData.player2),
                sessionId: matchData.matchId,
                timestamp: Date.now(),
                p1Wins,
                p2Wins,
            },
            { merge: true }
        )

        const statsRef = db.collection('player-stats').doc(player)
        const whichPlayer = matchData.player1 === player ? '1' : '2'
        const playerWon = matchResult === whichPlayer ? true : false
        const character = whichPlayer === '1' ? p1Char : p2Char
        const superIndex = whichPlayer === '1' ? parsed['player1-super'] : parsed['player2-super']
        const accountElo = whichPlayer === '1' ? newP1Elo : newP2Elo
        const streakInfo = streakUpdates.get(player) || null
        batch.set(
            statsRef,
            {
                accountElo: accountElo,
                totalGames: FieldValue.increment(1),
                totalWins: playerWon ? FieldValue.increment(1) : FieldValue.increment(0),
                totalLosses: !playerWon ? FieldValue.increment(1) : FieldValue.increment(0),
                winStreak: streakInfo ? streakInfo.current : 0,
                longestWinStreak: streakInfo
                    ? streakInfo.longest
                    : FieldValue.increment(0),
                // send data back to increase streak on websocket end
                characters: {
                    [`${character}`]: {
                        picks: FieldValue.increment(1),
                        superChoice: {
                            [`${superIndex}`]: {
                                wins:
                                    matchResult === whichPlayer
                                        ? FieldValue.increment(1)
                                        : FieldValue.increment(0),
                                losses:
                                    matchResult !== whichPlayer
                                        ? FieldValue.increment(1)
                                        : FieldValue.increment(0),
                            },
                        },
                    },
                },
                lastUpdated: Date.now(),
            },
            { merge: true }
        )
    }

    await batch.commit()

    if (streakUpdates.size) {
        await Promise.allSettled(
            [...streakUpdates.entries()].map(([uid, info]) => notifySocketWinStreak(uid, info.current))
        )
    }

    // Update global stats
    const globalStatsRef = db.collection('global-stats').doc('global-match-stats')
    try {
        await globalStatsRef.set(
            {
                globalNumberOfMatches: FieldValue.increment(1),
                globalWinCount: {
                    [`${matchResult}`]: FieldValue.increment(1),
                },
                globalCharacterChoice: {
                    [`${p1Char}`]: {
                        picks: FieldValue.increment(1),
                        superChoice: {
                            [`${parsed['player1-super']}`]: {
                                wins:
                                    matchResult === '1'
                                        ? FieldValue.increment(1)
                                        : FieldValue.increment(0),
                                losses:
                                    matchResult === '2'
                                        ? FieldValue.increment(1)
                                        : FieldValue.increment(0),
                            },
                        },
                    },
                    [`${p2Char}`]: {
                        picks: FieldValue.increment(1),
                        superChoice: {
                            [`${parsed['player2-super']}`]: {
                                wins:
                                    matchResult === '1'
                                        ? FieldValue.increment(1)
                                        : FieldValue.increment(0),
                                losses:
                                    matchResult === '2'
                                        ? FieldValue.increment(1)
                                        : FieldValue.increment(0),
                            },
                        },
                    },
                },
            },
            { merge: true }
        )

        console.log(`Match ${matchData.matchId} successfully uploaded and stats updated.`)
    } catch (error) {
        console.error('Error updating global stats:', error)
    }

    console.log(`Uploaded match (as part of session ${matchData.matchId})`)
}

async function getGlobalSet(uid, matchId) {
    if (!uid) return null
    const setCollectionRef = db.collection('global-matches').doc(matchId)
    const data = await setCollectionRef.get()
    if (!data.empty) {
        if (!data.data()) return null
        return data.data()
    } else {
        return null
    }
}

async function getGlobalStats(uid) {
    if (!uid) return null

    const statDocRef = db.collection('global-stats').doc('global-match-stats')
    const docSnap = await statDocRef.get()
    console.log(docSnap)
    if (!docSnap.exists) {
        return null
    }

    const data = docSnap.data()
    console.log(data)
    if (!data) {
        return null
    }

    return data
}
async function getPlayerStats(uid) {
    if (!uid) return null
    const statCollection = db.collection('player-stats').doc(uid)
    const data = await statCollection.get()
    if (!data.empty) {
        if (!data.data()) return null
        return data.data()
    } else {
        return null
    }
}

async function getAllTitles(uid) {
    if (!uid) return null
    const titleCollectionRef = db.collection('titles').doc('data')
    const data = await titleCollectionRef.get()
    if (!data.empty) {
        if (!data.data()) return null
        console.log(data.data())
        return data.data()
    } else {
        return null
    }
}

function normalizeFlair(flair) {
    if (!flair || typeof flair !== 'object') return null
    const title =
        typeof flair.title === 'string' && flair.title.trim().length
            ? flair.title.trim()
            : null
    if (!title) {
        return null
    }
    return {
        title,
        bgColor:
            typeof flair.bgColor === 'string' && flair.bgColor.trim().length
                ? flair.bgColor
                : '#1f1f24',
        color:
            typeof flair.color === 'string' && flair.color.trim().length
                ? flair.color
                : '#f2f2f7',
        border:
            typeof flair.border === 'string' && flair.border.trim().length
                ? flair.border
                : '#37373f',
    }
}

async function createTitleFlair(flair) {
    const normalized = normalizeFlair(flair)
    if (!normalized) return null
    const titleCollectionRef = db.collection('titles').doc('data')
    const doc = await titleCollectionRef.get()
    const existing = Array.isArray(doc.data()?.titles) ? doc.data().titles : []
    const alreadyExists = existing.some((entry) => entry.title === normalized.title)
    if (alreadyExists) {
        return normalized
    }
    const updated = [...existing, normalized]
    await titleCollectionRef.set({ titles: updated }, { merge: true })
    return normalized
}

async function assignTitleFlair(targetUid, flair) {
    if (!targetUid) return false
    const normalized = normalizeFlair(flair)
    if (!normalized) return false
    const snapshot = await usersRef.where('uid', '==', targetUid).limit(1).get()
    if (snapshot.empty) return false
    await snapshot.docs[0].ref.update({
        userTitle: normalized,
        assignedFlairs: FieldValue.arrayUnion(normalized),
    })
    return true
}

async function addAssignedFlair(targetUid, flair) {
    if (!targetUid) return false
    const normalized = normalizeFlair(flair)
    if (!normalized) return false
    const snapshot = await usersRef.where('uid', '==', targetUid).limit(1).get()
    if (snapshot.empty) return false
    await snapshot.docs[0].ref.update({
        assignedFlairs: FieldValue.arrayUnion(normalized),
    })
    return true
}

const conditionalCollectionRef = db.collection('conditional-flairs').doc('data')

async function createConditionalFlair(flair) {
    const normalized = normalizeFlair(flair)
    if (!normalized) return null
    const doc = await conditionalCollectionRef.get()
    const existing = Array.isArray(doc.data()?.flairs) ? doc.data().flairs : []
    const alreadyExists = existing.some((entry) => entry.title === normalized.title)
    if (alreadyExists) {
        return normalized
    }
    const updated = [...existing, normalized]
    await conditionalCollectionRef.set({ flairs: updated }, { merge: true })
    return normalized
}

async function getConditionalFlairs() {
    const doc = await conditionalCollectionRef.get()
    if (!doc.exists) return []
    const data = doc.data()
    if (!data) return []
    return Array.isArray(data.flairs) ? data.flairs : []
}

async function grantConditionalFlair(targetUid, flair) {
    return addAssignedFlair(targetUid, flair)
}

async function isAdminUser(uid) {
    if (!uid) return false
    const snapshot = await usersRef.where('uid', '==', uid).limit(1).get()
    if (snapshot.empty) return false
    const data = snapshot.docs[0].data()
    return typeof data.role === 'string' && data.role.toLowerCase() === 'admin'
}

async function searchUsers(query = '', limit = 25, cursorName = null) {
    const normalizedQuery = (query || '').trim()
    const pageSize = Math.min(Number(limit) || 25, 50)
    let ref = usersRef.orderBy('userName')
    if (normalizedQuery) {
        const end = `${normalizedQuery}\uf8ff`
        ref = ref.where('userName', '>=', normalizedQuery).where('userName', '<=', end)
    }
    if (cursorName) {
        ref = ref.startAfter(cursorName)
    }
    const snapshot = await ref.limit(pageSize).get()
    if (snapshot.empty) {
        return { users: [], nextCursor: null }
    }
    const users = snapshot.docs.map((doc) => sanitizeUserRecord(doc.data())).filter(Boolean)
    const lastDoc = snapshot.docs[snapshot.docs.length - 1]
    return {
        users,
        nextCursor: lastDoc ? lastDoc.get('userName') : null,
    }
}

async function getLeaderboard(sortBy = 'elo', limit = 25, cursorValue = null) {
    const pageSize = Math.min(Number(limit) || 25, 50)
    if (sortBy === 'wins') {
        let statsRef = db.collection('player-stats').orderBy('totalWins', 'desc')
        if (cursorValue !== undefined && cursorValue !== null) {
            statsRef = statsRef.startAfter(Number(cursorValue))
        }
        const snapshot = await statsRef.limit(pageSize).get()
        if (snapshot.empty) {
            return { entries: [], nextCursor: null }
        }
        const entries = []
        for (const doc of snapshot.docs) {
            const stats = doc.data() || {}
            const user = await getUserData(doc.id)
            if (user) {
                entries.push({
                    user,
                    stats: {
                        totalWins: stats.totalWins || 0,
                        totalLosses: stats.totalLosses || 0,
                        totalGames: stats.totalGames || 0,
                    },
                })
            }
        }
        const lastDoc = snapshot.docs[snapshot.docs.length - 1]
        return {
            entries,
            nextCursor: lastDoc ? lastDoc.get('totalWins') : null,
        }
    }

    let userRef = usersRef.orderBy('accountElo', 'desc')
    if (cursorValue !== undefined && cursorValue !== null) {
        userRef = userRef.startAfter(Number(cursorValue))
    }
    const snapshot = await userRef.limit(pageSize).get()
    if (snapshot.empty) {
        return { entries: [], nextCursor: null }
    }
    const entries = snapshot.docs
        .map((doc) => {
            const user = sanitizeUserRecord(doc.data())
            if (!user) return null
            return {
                user,
                stats: {
                    accountElo: doc.get('accountElo') || 0,
                },
            }
        })
        .filter(Boolean)
    const lastDoc = snapshot.docs[snapshot.docs.length - 1]
    return {
        entries,
        nextCursor: lastDoc ? lastDoc.get('accountElo') : null,
    }
}

async function getUserName(uid) {
    if (!uid) return
    const querySnapshot = await usersRef.where('uid', '==', uid).get()
    if (!querySnapshot.empty) {
        console.log('trying to get docs', querySnapshot.docs)
        return querySnapshot.docs[0].data().userName
    } else {
        return null
    }
}

// set elo
async function setUserElo(uid, newElo) {
    if (!uid) return

    const querySnapshot = await usersRef.where('uid', '==', uid).get()

    if (!querySnapshot.empty) {
        const userDoc = querySnapshot.docs[0]
        await userDoc.ref.update({ accountElo: newElo })
        return true
    } else {
        return false
    }
}

async function getUserMatches(uid, limit = 10, lastMatchId = null, firstMatchId = null) {
    if (!uid) return null

    const matchCollectionRef = db.collection('recent-matches').doc(uid).collection('sessions')
    const totalMatchesSnapshot = await matchCollectionRef.count().get()
    const totalMatches = totalMatchesSnapshot.data().count

    let query = matchCollectionRef.orderBy('timestamp', 'desc').limit(limit)

    if (lastMatchId) {
        console.log('getting match data from last id', lastMatchId)
        const lastDoc = await matchCollectionRef.doc(lastMatchId).get()
        if (lastDoc.exists) {
            query = query.startAfter(lastDoc)
        }
    }
    if (firstMatchId) {
        console.log('getting match data from first id', firstMatchId)
        const firstDoc = await matchCollectionRef.doc(firstMatchId).get()
        if (firstDoc.exists) {
            query = matchCollectionRef
                .orderBy('timestamp', 'desc')
                .endBefore(firstDoc)
                .limitToLast(limit) // Ensure correct ordering when going backward
        }
    }

    const querySnapshot = await query.get()
    const matches = querySnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }))
    return {
        matches,
        lastVisible: querySnapshot.docs[querySnapshot.docs.length - 1] || null,
        firstVisible: querySnapshot.docs[0] || null,
        totalMatches,
    }
}

module.exports = {
    getUserMatches,
    getGlobalSet,
    getGlobalStats,
    getPlayerStats,
    uploadMatchData,
    getUserName,
    getUserElo,
    getCustomToken,
    getUserAccountByAuth,
    getUserData,
    getAllTitles,
    updateUserData,
    createAccount,
    removeLoggedInUser,
    fetchLoggedInUser,
    addLoggedInUser,
    searchUsers,
    getLeaderboard,
    createTitleFlair,
    assignTitleFlair,
    isAdminUser,
    createConditionalFlair,
    getConditionalFlairs,
    grantConditionalFlair,
    addAssignedFlair,
    recordRpsResult,
    setSidePreference,
}
