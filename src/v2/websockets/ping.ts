// Websocket functions for gathering ping and location information
const { connectedUsers } = require('../websockets/maps')
const serverInfo = require('../../../keys/server')
const axios = require('axios')
const geoip = require('fast-geoip')
const geolib = require('geolib')

async function handleEstimatePing(data, ws) {
    const { data: userData } = data
    if (!userData.userA || !userData.userB) return

    const userAResponse = await axios.post(
        `http://${serverInfo.COTURN_IP}:${serverInfo.API_PORT}/get-user-server`,
        { userUID: userData.userA.id },
        {
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${serverInfo.SERVER_SECRET}`,
            },
        }
    )

    const userA = userAResponse.data
    const userB = connectedUsers.get(userData.userB.id)?.userData
    if (!userA?.pingLat || !userB?.pingLat) return

    let distance = 1
    try {
        distance = geolib.getDistance(
            { latitude: userA.pingLat, longitude: userA.pingLon },
            { latitude: userB.pingLat, longitude: userB.pingLon }
        )
    } catch (error) {
        console.error('geolib error:', error)
    }

    const estimatedRTT = Math.round(distance / 1000 / 200 + 20)
    const existingPings = Array.isArray(userA.lastKnownPings) ? userA.lastKnownPings : []
    const filteredPings = existingPings.filter((p) => p.id !== userData.userB.id)
    const updatedPings = [
        ...filteredPings,
        {
            id: userData.userB.id,
            ping: `${estimatedRTT}`,
            isUnstable: userData.userB.stability,
        },
    ]

    const body = {
        userData: {
            lastKnownPings: updatedPings,
        },
        uid: userData.userA.id,
    }

    try {
        await axios.post(
            `http://${serverInfo.COTURN_IP}:${serverInfo.API_PORT}/update-user-ping`,
            body,
            {
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${serverInfo.SERVER_SECRET}`,
                },
            }
        )
    } catch (err) {
        console.error('Failed to update user ping:', err)
        return
    }

    if (ws.uid === userData.userA.id) {
        ws.send(JSON.stringify({ type: 'update-user-pinged', data: body.userData }))
    }
}

function getPeerPingsForUser(sourceUser) {
    const results = []

    for (const [id, targetUser] of connectedUsers.entries()) {
        if (id === sourceUser.uid) continue

        if (
            !targetUser.pingLat ||
            !targetUser.pingLon ||
            !sourceUser.pingLat ||
            !sourceUser.pingLon
        ) {
            continue
        }

        const distance = geolib.getDistance(
            { latitude: sourceUser.pingLat, longitude: sourceUser.pingLon },
            { latitude: targetUser.pingLat, longitude: targetUser.pingLon }
        )

        const distanceKm = distance / 1000
        const estimatedRTT = Math.round(distanceKm / 200 + 20)

        results.push({
            id: targetUser.uid,
            ping: estimatedRTT,
            isUnstable: targetUser.stability ?? false,
            countryCode: targetUser.countryCode ?? 'xx',
        })
    }

    return results
}

function extractClientIp(req) {
    const forwarded = req.headers['x-forwarded-for']
    if (forwarded) return forwarded.split(',')[0].trim()

    const ip =
        req.headers['x-real-ip'] ||
        req.socket?.remoteAddress ||
        req.connection?.remoteAddress ||
        ''

    if (ip.includes('::ffff:')) return ip.split('::ffff:')[1]
    if (!ip || ip === '::1') return '127.0.0.1'

    return ip
}


async function getGeoLocation(req, user, ws) {
    const ip = extractClientIp(req)
    console.log('extracted Ip for user', ip)

    if (!ip) {
        console.log('failed to get ip string')
        return
    }

    const geo = await geoip.lookup(ip)
    if (!geo) {
        console.log('geo lookup failed for IP:', ip)
        return
    }

    const userGeoData = {
        pingLat: geo.ll[0],
        pingLon: geo.ll[1],
        countryCode: geo.country || 'xx',
    }
    const body = {
        userData: userGeoData,
        uid: user.uid,
    }

    try {
        await axios.post(
            `http://${serverInfo.COTURN_IP}:${serverInfo.API_PORT}/update-user-ping`,
            body,
            {
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${serverInfo.SERVER_SECRET}`,
                },
            }
        )
    } catch (error) {
        console.error('Geo update failed:', error)
    }

    const updatedUser = {
        ...user,
        ...userGeoData,
    }

    console.log('trying to update user with', updatedUser)
    try {
        connectedUsers.set(user.uid, { ws, ...updatedUser })
    } catch (error) {
        console.log('failed to set user', error)
    }

    const peerPings = getPeerPingsForUser(updatedUser)

    if (ws.uid === user.uid) {
        ws.send(
            JSON.stringify({
                type: 'update-user-pinged',
                data: { ...userGeoData, lastKnownPings: peerPings },
            })
        )
        // send ping out to every other user
        for (const peer of peerPings) {
            const peerConn = connectedUsers.get(peer.id)
            if (!peerConn || !peerConn.ws) continue

            const reversePing = {
                isNewPing: true, // we use this to sift on the front end and make the update.
                id: updatedUser.uid,
                ping: peer.ping,
                countryCode: updatedUser.countryCode || 'xx',
                isUnstable: updatedUser.stability ?? false,
            }

            peerConn.ws.send(
                JSON.stringify({
                    type: 'update-user-pinged',
                    data: reversePing,
                })
            )
        }
    }
}

export { handleEstimatePing, getGeoLocation, getPeerPingsForUser, extractClientIp }
