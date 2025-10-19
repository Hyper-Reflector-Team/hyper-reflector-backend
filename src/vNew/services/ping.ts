import axios from 'axios';
import geoip from 'fast-geoip';
import geolib from 'geolib';
import { IncomingMessage } from 'http';

import { connectedUsers } from '../state';
import { ConnectedUser, EstimatePingUsersPayload, MessageContext } from '../types';
import { broadcastUserList, syncUserToLobby } from './lobby';
import { DEFAULT_LOBBY_ID } from '../config';

const serverInfo = require('../../../keys/server');

export function extractClientIp(req: IncomingMessage) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
        return forwarded.split(',')[0].trim();
    }

    const ip =
        (req.headers['x-real-ip'] as string | undefined) ||
        req.socket?.remoteAddress ||
        (req.connection as any)?.remoteAddress ||
        '';

    if (ip.includes('::ffff:')) return ip.split('::ffff:')[1];
    if (!ip || ip === '::1') return '127.0.0.1';

    return ip;
}

export async function populateGeoForUser(ctx: MessageContext, user: ConnectedUser) {
    const ip = extractClientIp(ctx.req);
    ctx.logger.log('extracted ip for user', user.uid, ip);

    if (!ip) return;

    const geo = await geoip.lookup(ip);
    if (!geo) {
        ctx.logger.warn('geo lookup failed for IP:', ip);
        return;
    }

    const geoData = {
        pingLat: geo.ll[0],
        pingLon: geo.ll[1],
        countryCode: geo.country || 'xx',
        ip,
    };

    const body = {
        userData: geoData,
        uid: user.uid,
    };

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
        );
    } catch (error) {
        ctx.logger.error('Geo update failed:', error);
    }

    const updatedUser = {
        ...user,
        ...geoData,
        lastHeartbeat: Date.now(),
    };

    connectedUsers.set(user.uid, updatedUser);
    syncUserToLobby(user.uid, updatedUser.lobbyId ?? DEFAULT_LOBBY_ID);
    broadcastUserList(updatedUser.lobbyId ?? DEFAULT_LOBBY_ID);

    const peerPings = getPeerPingsForUser(updatedUser);

    if (ctx.ws.uid === user.uid) {
        ctx.ws.send(
            JSON.stringify({
                type: 'update-user-pinged',
                data: { ...geoData, lastKnownPings: peerPings },
            })
        );

        for (const peer of peerPings) {
            const peerConn = connectedUsers.get(peer.id);
            if (!peerConn || !peerConn.ws) continue;

            peerConn.ws.send(
                JSON.stringify({
                    type: 'update-user-pinged',
                    data: {
                        isNewPing: true,
                        id: updatedUser.uid,
                        ping: peer.ping,
                        countryCode: updatedUser.countryCode ?? 'xx',
                        isUnstable: updatedUser.stability ?? false,
                    },
                })
            );
        }
    }
}

function getPeerPingsForUser(sourceUser: ConnectedUser) {
    const results: Array<{ id: string; ping: number; isUnstable?: boolean; countryCode?: string }> = [];

    for (const [id, targetUser] of connectedUsers.entries()) {
        if (id === sourceUser.uid) continue;

        if (
            !targetUser.pingLat ||
            !targetUser.pingLon ||
            !sourceUser.pingLat ||
            !sourceUser.pingLon
        ) {
            continue;
        }

        const distance = geolib.getDistance(
            { latitude: sourceUser.pingLat, longitude: sourceUser.pingLon },
            { latitude: targetUser.pingLat, longitude: targetUser.pingLon }
        );

        const distanceKm = distance / 1000;
        const estimatedRTT = Math.round(distanceKm / 200 + 20);

        results.push({
            id: targetUser.uid,
            ping: estimatedRTT,
            isUnstable: targetUser.stability ?? false,
            countryCode: targetUser.countryCode ?? 'xx',
        });
    }

    return results;
}

export async function handleEstimatePing(ctx: MessageContext, data: EstimatePingUsersPayload) {
    if (!data.userA || !data.userB) return;

    const userAResponse = await axios.post(
        `http://${serverInfo.COTURN_IP}:${serverInfo.API_PORT}/get-user-server`,
        { userUID: data.userA.id },
        {
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${serverInfo.SERVER_SECRET}`,
            },
        }
    );

    const userA = userAResponse.data;
    const userB = connectedUsers.get(data.userB.id);

    if (!userA?.pingLat || !userB?.pingLat) {
        const tries = (data.__tries ?? 0) + 1;
        if (tries <= 5) {
            setTimeout(() => {
                handleEstimatePing(ctx, { ...data, __tries: tries });
            }, 250);
        }
        return;
    }

    let distance = 1;
    try {
        distance = geolib.getDistance(
            { latitude: userA.pingLat, longitude: userA.pingLon },
            { latitude: userB.pingLat, longitude: userB.pingLon }
        );
    } catch (error) {
        ctx.logger.error('geolib error:', error);
    }

    const estimatedRTT = Math.round(distance / 1000 / 200 + 20);
    const existingPings = Array.isArray(userA.lastKnownPings) ? userA.lastKnownPings : [];
    const filteredPings = existingPings.filter((p: any) => p.id !== data.userB.id);
    const updatedPings = [
        ...filteredPings,
        {
            id: data.userB.id,
            ping: `${estimatedRTT}`,
            isUnstable: data.userB.stability,
        },
    ];

    const body = {
        userData: {
            lastKnownPings: updatedPings,
        },
        uid: data.userA.id,
    };

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
        );
    } catch (err) {
        ctx.logger.error('Failed to update user ping:', err);
        return;
    }

    if (ctx.ws.uid === data.userA.id) {
        ctx.ws.send(JSON.stringify({ type: 'update-user-pinged', data: body.userData }));
    }
}
