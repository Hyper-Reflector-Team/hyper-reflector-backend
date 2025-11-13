import { IncomingMessage } from 'http';
import WebSocket, { WebSocketServer } from 'ws';

export interface SocketUser {
    uid: string;
    email?: string;
    displayName?: string;
    lobbyId?: string;
    winStreak?: number;
    stability?: boolean;
    [key: string]: unknown;
}

export interface ConnectedUser extends SocketUser {
    ws: AugmentedWebSocket;
    joinedAt: number;
    lastHeartbeat: number;
    ip?: string;
    pingLat?: number;
    pingLon?: number;
    countryCode?: string;
    lastKnownPings?: Array<{ id: string; ping: number | string; isUnstable?: boolean }>;
}

export interface LobbyMeta {
    pass?: string;
    isPrivate?: boolean;
    ownerUid?: string;
}

export type UpdateSocketStatePayload = {
    uid: string;
    lobbyId: string;
    stateToUpdate: {
        key: string;
        value: any;
    };
};

export type EstimatePingUsersPayload = {
    userA: { id: string; stability?: boolean };
    userB: { id: string; stability?: boolean };
    __tries?: number;
};

export type SignalMessage =
    | { type: 'join'; user: SocketUser; lobbyId?: string }
    | { type: 'updateSocketState'; data: UpdateSocketStatePayload }
    | { type: 'createLobby'; lobbyId: string; pass?: string; user: SocketUser; isPrivate?: boolean }
    | { type: 'changeLobby'; newLobbyId: string; pass?: string; user: SocketUser }
    | {
          type: 'request-match';
          challengerId: string;
          opponentId: string;
          requestedBy: string;
          lobbyId?: string;
          gameName?: string;
      }
    | { type: 'userDisconnect'; userUID?: string }
    | { type: 'sendMessage'; sender: SocketUser; message: string; messageId?: string }
    | { type: 'matchEnd'; userUID: string }
    | { type: 'webrtc-ping-offer'; to: string; from: string; offer: unknown }
    | { type: 'webrtc-ping-answer'; to: string; from: string; answer: unknown }
    | { type: 'webrtc-ping-decline'; to: string; from: string }
    | { type: 'webrtc-ping-candidate'; to: string; from: string; candidate: unknown }
    | { type: 'estimate-ping-users'; data: EstimatePingUsersPayload }
    | {
          type: 'peer-latency-offer';
          to: string;
          from: string;
          measurementId: string;
          offer: unknown;
      }
    | {
          type: 'peer-latency-answer';
          to: string;
          from: string;
          measurementId: string;
          answer: unknown;
      }
    | {
          type: 'peer-latency-candidate';
          to: string;
          from: string;
          measurementId: string;
          candidate: unknown;
      }
    | {
          type: 'peer-latency-decline';
          to: string;
          from: string;
          measurementId: string;
          reason?: string;
      };

export type MessageHandler = (ctx: MessageContext, message: SignalMessage) => Promise<void> | void;

export type AugmentedWebSocket = WebSocket & {
    uid?: string;
    isAlive?: boolean;
};

export interface MessageContext {
    ws: AugmentedWebSocket;
    req: IncomingMessage;
    wss: WebSocketServer;
    logger: typeof console;
}
