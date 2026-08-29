function nextPowerOfTwo(n) {
    let p = 1
    while (p < n) p *= 2
    return p
}

function isPowerOfTwo(n) {
    return n > 0 && (n & (n - 1)) === 0
}

function standardSeedOrder(n) {
    let seeds = [1, 2]
    while (seeds.length < n) {
        const total = seeds.length * 2 + 1
        const next = []
        for (const s of seeds) next.push(s, total - s)
        seeds = next
    }
    return seeds
}

function makeMatch(id, bracketType, round, matchIndex) {
    return {
        id,
        bracketType,
        round,
        matchIndex,
        slot1: null,
        slot2: null,
        winnerUid: null,
        loserUid: null,
        status: 'pending',
        nextMatchId: null,
        nextMatchSlot: null,
        nextLoserMatchId: null,
        nextLoserMatchSlot: null,
    }
}

function makeSlot(participant) {
    if (!participant) return { uid: null, userName: null, isBye: true }
    return { uid: participant.uid, userName: participant.userName, isBye: false }
}

function findMatch(matches, id) {
    const m = matches.find((x) => x.id === id)
    if (!m) throw new Error(`Unknown match id: ${id}`)
    return m
}

function fillSlot(matches, matchId, slotNum, slotData) {
    const match = findMatch(matches, matchId)
    if (slotNum === 1) match.slot1 = slotData
    else match.slot2 = slotData

    if (match.slot1 && match.slot2) {
        if (match.slot1.isBye && !match.slot2.isBye) {
            resolveMatch(matches, matchId, match.slot2.uid, { auto: true })
        } else if (match.slot2.isBye && !match.slot1.isBye) {
            resolveMatch(matches, matchId, match.slot1.uid, { auto: true })
        } else if (!match.slot1.isBye && !match.slot2.isBye) {
            match.status = 'ready'
        }
    }
}

function resolveMatch(matches, matchId, winnerUid, opts = {}) {
    const match = findMatch(matches, matchId)
    if (match.status === 'reported' || match.status === 'bye') {
        throw new Error(`Match ${matchId} has already been resolved`)
    }
    const slot1IsWinner = match.slot1 && match.slot1.uid === winnerUid
    const slot2IsWinner = match.slot2 && match.slot2.uid === winnerUid
    if (!slot1IsWinner && !slot2IsWinner) {
        throw new Error(`${winnerUid} is not a participant in match ${matchId}`)
    }
    const winnerSlot = slot1IsWinner ? match.slot1 : match.slot2
    const loserSlot = slot1IsWinner ? match.slot2 : match.slot1

    match.winnerUid = winnerUid
    match.loserUid = loserSlot && !loserSlot.isBye ? loserSlot.uid : null
    match.status = opts.auto ? 'bye' : 'reported'

    if (match.nextMatchId) {
        fillSlot(matches, match.nextMatchId, match.nextMatchSlot, makeSlot(winnerSlot))
    }
    if (match.nextLoserMatchId && match.loserUid) {
        fillSlot(matches, match.nextLoserMatchId, match.nextLoserMatchSlot, makeSlot(loserSlot))
    }
}

function linkToNext(match, nextMatch, nextSlotNum) {
    match.nextMatchId = nextMatch.id
    match.nextMatchSlot = nextSlotNum
}

function linkLoserToNext(match, nextMatch, nextSlotNum) {
    match.nextLoserMatchId = nextMatch.id
    match.nextLoserMatchSlot = nextSlotNum
}

function buildWinnersBracket(slots, matches) {
    const bracketSize = slots.length
    const numRounds = Math.log2(bracketSize)
    const rounds = []
    let prevRound = null

    for (let r = 1; r <= numRounds; r++) {
        const matchesInRound = bracketSize / Math.pow(2, r)
        const round = []
        for (let m = 1; m <= matchesInRound; m++) {
            const match = makeMatch(`w-r${r}-m${m}`, 'winners', r, m)
            round.push(match)
            matches.push(match)
        }
        if (r === 1) {
            for (let m = 0; m < round.length; m++) {
                round[m].slot1 = slots[m * 2]
                round[m].slot2 = slots[m * 2 + 1]
            }
        } else {
            for (let m = 0; m < prevRound.length; m++) {
                const targetIdx = Math.floor(m / 2)
                const slotNum = m % 2 === 0 ? 1 : 2
                linkToNext(prevRound[m], round[targetIdx], slotNum)
            }
        }
        rounds.push(round)
        prevRound = round
    }
    return { rounds }
}

function buildLosersBracket(winnersRounds, matches) {
    const k = winnersRounds.length
    if (k < 2) return { rounds: [], champion: null }

    const rounds = []
    let lrIndex = 1
    let wbRoundIndex = 0

    const wr1 = winnersRounds[0]
    let survivors = []
    let round = []
    for (let m = 0; m < wr1.length / 2; m++) {
        const match = makeMatch(`l-r${lrIndex}-m${m + 1}`, 'losers', lrIndex, m + 1)
        matches.push(match)
        round.push(match)
        linkLoserToNext(wr1[m * 2], match, 1)
        linkLoserToNext(wr1[m * 2 + 1], match, 2)
    }
    rounds.push(round)
    survivors = round
    wbRoundIndex = 1
    lrIndex++

    while (wbRoundIndex < k || survivors.length > 1) {
        const freshDrops = wbRoundIndex < k ? winnersRounds[wbRoundIndex] : null
        const isDropRound = freshDrops && freshDrops.length === survivors.length
        const nextRound = []

        if (isDropRound) {
            for (let i = 0; i < survivors.length; i++) {
                const match = makeMatch(`l-r${lrIndex}-m${i + 1}`, 'losers', lrIndex, i + 1)
                matches.push(match)
                nextRound.push(match)
                linkToNext(survivors[i], match, 1)
                linkLoserToNext(freshDrops[i], match, 2)
            }
            wbRoundIndex++
        } else {
            for (let i = 0; i < survivors.length / 2; i++) {
                const match = makeMatch(`l-r${lrIndex}-m${i + 1}`, 'losers', lrIndex, i + 1)
                matches.push(match)
                nextRound.push(match)
                linkToNext(survivors[i * 2], match, 1)
                linkToNext(survivors[i * 2 + 1], match, 2)
            }
        }

        rounds.push(nextRound)
        survivors = nextRound
        lrIndex++
    }

    return { rounds, champion: survivors[0] }
}

function generateBracket(participants, format) {
    if (!Array.isArray(participants) || participants.length < 2) {
        throw new Error('At least 2 participants are required')
    }
    if (format !== 'single-elim' && format !== 'double-elim') {
        throw new Error(`Unknown format: ${format}`)
    }
    if (format === 'double-elim' && !isPowerOfTwo(participants.length)) {
        throw new Error('Double elimination requires a power-of-2 participant count in this version — byes are single-elimination only for now.')
    }

    const bracketSize = nextPowerOfTwo(participants.length)
    const seedOrder = standardSeedOrder(bracketSize)
    const slots = seedOrder.map((seedNum) => makeSlot(participants[seedNum - 1] || null))

    const matches = []
    const { rounds: winnersRounds } = buildWinnersBracket(slots, matches)
    const winnersFinal = winnersRounds[winnersRounds.length - 1][0]

    if (format === 'double-elim') {
        const { champion: losersChampion } = buildLosersBracket(winnersRounds, matches)
        const gf1 = makeMatch('gf1', 'grand-finals', 1, 1)
        matches.push(gf1)
        linkToNext(winnersFinal, gf1, 1)
        if (losersChampion) linkToNext(losersChampion, gf1, 2)
    }

    let changed = true
    while (changed) {
        changed = false
        for (const match of matches) {
            if (match.status !== 'pending') continue
            if (match.slot1 && match.slot2) {
                if (match.slot1.isBye && !match.slot2.isBye) {
                    resolveMatch(matches, match.id, match.slot2.uid, { auto: true })
                    changed = true
                } else if (match.slot2.isBye && !match.slot1.isBye) {
                    resolveMatch(matches, match.id, match.slot1.uid, { auto: true })
                    changed = true
                } else if (!match.slot1.isBye && !match.slot2.isBye) {
                    match.status = 'ready'
                }
            }
        }
    }

    return { format, bracketSize, matches }
}

function eliminationLabel(match) {
    if (match.bracketType === 'winners') return `Eliminated in winners round ${match.round}`
    if (match.bracketType === 'losers') return `Eliminated in losers round ${match.round}`
    return 'Eliminated'
}

function advanceMatch(existingMatches, matchId, winnerUid) {
    const matches = existingMatches.map((m) => ({ ...m }))
    const match = findMatch(matches, matchId)
    if (match.status !== 'ready') {
        throw new Error(`Match ${matchId} is not ready to be reported (status: ${match.status})`)
    }

    resolveMatch(matches, matchId, winnerUid)

    if (match.bracketType === 'grand-finals' && match.id === 'gf1') {
        const winnersFinalist = existingMatches.find((m) => m.nextMatchId === 'gf1' && m.nextMatchSlot === 1)
        const isResetNeeded = winnersFinalist && winnersFinalist.winnerUid !== winnerUid
        if (isResetNeeded) {
            const gf2 = makeMatch('gf2', 'grand-finals', 2, 1)
            gf2.slot1 = match.slot1
            gf2.slot2 = match.slot2
            gf2.status = 'ready'
            matches.push(gf2)
            return { matches, completed: false, placements: null }
        }
    }

    const isDoubleElim = matches.some((m) => m.bracketType === 'grand-finals')
    const isFinal = isDoubleElim ? match.id === 'gf1' || match.id === 'gf2' : !match.nextMatchId
    if (!isFinal) {
        return { matches, completed: false, placements: null }
    }

    const championUid = match.winnerUid
    const runnerUpUid = match.loserUid
    const placements = [{ uid: championUid, placement: 1 }]
    if (runnerUpUid) placements.push({ uid: runnerUpUid, placement: 2 })

    const placed = new Set(placements.map((p) => p.uid))
    for (const m of matches) {
        if (m.loserUid && !placed.has(m.loserUid) && m.status !== 'pending') {
            placements.push({ uid: m.loserUid, placement: null, note: eliminationLabel(m) })
            placed.add(m.loserUid)
        }
    }

    return { matches, completed: true, placements }
}

function revertMatch(existingMatches, matchId) {
    const matches = existingMatches.map((m) => ({ ...m }))
    const match = findMatch(matches, matchId)
    if (match.status !== 'reported') {
        throw new Error(`Match ${matchId} has not been reported and cannot be reverted`)
    }

    const next = match.nextMatchId ? findMatch(matches, match.nextMatchId) : null
    if (next && (next.status === 'reported' || next.status === 'bye')) {
        throw new Error('The next match has already been played — cannot revert')
    }
    const nextLoser = match.nextLoserMatchId ? findMatch(matches, match.nextLoserMatchId) : null
    if (nextLoser && (nextLoser.status === 'reported' || nextLoser.status === 'bye')) {
        throw new Error('The next match has already been played — cannot revert')
    }
    if (match.id === 'gf1' && matches.some((m) => m.id === 'gf2')) {
        throw new Error('Grand Finals has already moved to a bracket reset — cannot revert')
    }

    const isDoubleElim = matches.some((m) => m.bracketType === 'grand-finals')
    const wasFinal = isDoubleElim ? match.id === 'gf1' || match.id === 'gf2' : !match.nextMatchId

    match.winnerUid = null
    match.loserUid = null
    match.status = 'ready'

    if (next) {
        next[match.nextMatchSlot === 1 ? 'slot1' : 'slot2'] = null
        if (next.status === 'ready') next.status = 'pending'
    }
    if (nextLoser) {
        nextLoser[match.nextLoserMatchSlot === 1 ? 'slot1' : 'slot2'] = null
        if (nextLoser.status === 'ready') nextLoser.status = 'pending'
    }

    return { matches, wasFinal }
}

module.exports = {
    isPowerOfTwo,
    nextPowerOfTwo,
    standardSeedOrder,
    generateBracket,
    advanceMatch,
    revertMatch,
}
