import {
  SerializedMediaEvent,
  serializeMediaEvent,
  deserializeMediaEvent,
  generateMediaEvent,
  MediaEvent,
} from "./mediaEvent";

/**
 * Interface describing Peer.
 */
export interface Peer {
  /**
   * Peer's id. It is assigned by user in custom logic that use backend API.
   */
  id: string;
  /**
   * Any information that was provided in {@link join}.
   */
  metadata: any;
  trackIdToMetadata: Map<string, any>;
}

/**
 * Config passed to {@link MembraneWebRTC}.
 */
export interface MembraneWebRTCConfig {
  callbacks: Callbacks;
  rtcConfig?: RTCConfiguration;
  /**
   * Determines wheater user want to receive media from other peers.
   */
  receiveMedia?: boolean;
}

/**
 * Track's context i.e. all data that can be usful when operating on track.
 */
export interface TrackContext {
  track: MediaStreamTrack;
  /**
   * Stream this track belongs to.
   */
  stream: MediaStream;
  /**
   * Peer this track comes from.
   */
  peer: Peer;
  trackId: string;
  /**
   * Any info that was passed in {@link addTrack}.
   */
  metadata: any;
}

type fnGetPeerMediaStreams = (peerId: string) => MediaStream[];
/**
 * Callbacks that has to be implemented by user.
 */
export interface Callbacks {
  /**
   * Called each time MembraneWebRTC need to send some data to the server.
   */
  onSendMediaEvent: (mediaEvent: SerializedMediaEvent) => void;

  /**
   * Called when peer was accepted. Triggered by {@link join}
   */
  onJoinSuccess?: (
    peerId: string,
    peersInRoom: [Peer],
    getPeerMediaStreams: fnGetPeerMediaStreams
  ) => void;
  /**
   * Called when peer was not accepted. Triggered by {@link join}
   * @param metadata - Passthru for client application to communicate further actions to frontend
   */
  onJoinError?: (metadata: any) => void;

  /**
   * Called when a new track appears.
   *
   * This callback is always called after a new peer joins so after calling {@link onPeerJoined}.
   * @param ctx - Contains information about the new track.
   */
  onTrackAdded?: (ctx: TrackContext) => void;
  /**
   * Called when some track will no longer be sent.
   *
   * At this moment there is only one situation in which this callback is invoked i.e. when peer
   * leaves the room. In such scenario, this callback will be invoked for each track this peer
   * was sending and then {@link onPeerLeft} will be called.
   */
  onTrackRemoved?: (ctx: TrackContext) => void;

  /**
   * Called each time new peer joins the room.
   */
  onPeerJoined?: (peer: Peer, getPeerMediaStreams: fnGetPeerMediaStreams) => void;
  /**
   * Called each time peer leaves the room.
   */
  onPeerLeft?: (peer: Peer) => void;

  /**
   * Called in case of errors related to multimedia session e.g. ICE connection.
   */
  onConnectionError?: (message: string) => void;
}

/**
 * Main class that is responsible for connecting to the SFU server, sending and receiving media.
 */
export class MembraneWebRTC {
  private id?: string;

  private receiveMedia: boolean;

  private localTracksWithStreams: {
    track: MediaStreamTrack;
    stream: MediaStream;
  }[] = [];
  private trackIdToTrack: Map<string, TrackContext> = new Map();
  private localTrackIdToMetadata: Map<string, any> = new Map();
  private midToStream: Map<String, MediaStream> = new Map();
  private connection?: RTCPeerConnection;
  private idToPeer: Map<String, Peer> = new Map();
  private midToTrackId: Map<string, string> = new Map();
  private readonly rtcConfig: RTCConfiguration = {
    iceServers: [
      {
        urls: "stun:stun.l.google.com:19302",
      },
    ],
  };

  private readonly callbacks: Callbacks;

  constructor(config: MembraneWebRTCConfig) {
    const { receiveMedia = true, callbacks, rtcConfig } = config;

    this.receiveMedia = receiveMedia;

    this.callbacks = callbacks;
    this.rtcConfig = rtcConfig || this.rtcConfig;
  }

  /**
   * Tries to join to the SFU server. If user is accepted then {@link onJoinSuccess}
   * will be called. In other case {@link onJoinError} is invoked.
   *
   * @param peerMetadata - Any information that other peers will receive in {@link onPeerJoined}
   * after accepting this peer
   *
   * @example
   * ```ts
   * let webrtc = new MembraneWebRTC(...)
   * webrtc.join({displayName: "Bob"})
   * ```
   */
  public join = (peerMetadata: any): void => {
    try {
      let relayAudio = false;
      let relayVideo = false;

      this.localTracksWithStreams.forEach(({ stream }) => {
        if (stream.getAudioTracks().length != 0) relayAudio = true;
        if (stream.getVideoTracks().length != 0) relayVideo = true;
      });

      let mediaEvent = generateMediaEvent("join", {
        relayAudio: relayAudio,
        relayVideo: relayVideo,
        receiveMedia: this.receiveMedia,
        metadata: peerMetadata,
        tracksMetadata: Array.from(this.localTrackIdToMetadata.values()),
      });
      this.sendMediaEvent(mediaEvent);
    } catch (e: any) {
      this.callbacks.onConnectionError?.(e);
      this.leave();
    }
  };

  /**
   * Feeds media event received from SFU server to {@link MembraneWebRTC}.
   * This function should be called whenever some media event from SFU server
   * was received and can result in {@link MembraneWebRTC} generating some other
   * media events.
   *
   * @param mediaEvent - String data received over custom signalling layer.
   *
   * @example
   * This example assumes pheonix channels as signalling layer.
   * As pheonix channels require objects, SFU server encapsulates binary data into
   * map with one field that is converted to object with one field on the TS side.
   * ```ts
   * webrtcChannel.on("mediaEvent", (event) => webrtc.receiveMediaEvent(event.data));
   * ```
   */
  public receiveMediaEvent = (mediaEvent: SerializedMediaEvent) => {
    const deserializedMediaEvent = deserializeMediaEvent(mediaEvent);
    let peer;
    console.log(deserializedMediaEvent.type);
    switch (deserializedMediaEvent.type) {
      case "peerAccepted":
        this.id = deserializedMediaEvent.data.id;
        this.callbacks.onJoinSuccess?.(
          deserializedMediaEvent.data.id,
          deserializedMediaEvent.data.peersInRoom,
          this.getPeerMediaStreams
        );
        console.log("PeersInRoom", deserializedMediaEvent.data.peersInRoom);
        let peers = deserializedMediaEvent.data.peersInRoom as Peer[];
        peers.forEach((peer) => {
          this.addPeer(peer);
        });
        break;

      case "peerDenied":
        this.callbacks.onJoinError?.(deserializedMediaEvent.data);
        break;

      case "newTracks":
        const offerData = new Map<string, number>(Object.entries(deserializedMediaEvent.data));
        this.onOfferData(offerData);
        break;

      case "sdpAnswer":
        this.midToTrackId = new Map(Object.entries(deserializedMediaEvent.data.midToTrackId));
        this.onAnswer(deserializedMediaEvent.data);
        break;

      case "candidate":
        this.onRemoteCandidate(deserializedMediaEvent.data);
        break;

      case "peerJoined":
        peer = deserializedMediaEvent.data.peer;
        if (peer.id != this.id) {
          this.addPeer(peer);
          this.callbacks.onPeerJoined?.(peer, this.getPeerMediaStreams);
        }
        break;

      case "peerLeft":
        peer = this.idToPeer.get(deserializedMediaEvent.data.peerId);
        if (peer) {
          this.removePeer(peer);
          this.callbacks.onPeerLeft?.(peer);
        }
        break;

      case "error":
        this.callbacks.onConnectionError?.(deserializedMediaEvent.data.message);
        this.leave();
        break;
    }
  };

  /**
   * Adds track that will be sent to the SFU server.
   * At this moment only one audio and one video track can be added.
   * @param track - Audio or video track e.g. from your microphone or camera.
   * @param stream  - Stream that this track belongs to.
   * @param trackMetadata - Any information about this track that other peers will
   * receive in {@link onPeerJoined}. E.g. this can source of the track - wheather it's
   * screensharing, webcam or some other media device.
   *
   * @example
   * ```ts
   * let localStream: MediaStream = new MediaStream();
   * try {
   *   localAudioStream = await navigator.mediaDevices.getUserMedia(
   *     AUDIO_CONSTRAINTS
   *   );
   *   localAudioStream
   *     .getTracks()
   *     .forEach((track) => localStream.addTrack(track));
   * } catch (error) {
   *   console.error("Couldn't get microphone permission:", error);
   * }
   *
   * try {
   *   localVideoStream = await navigator.mediaDevices.getUserMedia(
   *     VIDEO_CONSTRAINTS
   *   );
   *   localVideoStream
   *     .getTracks()
   *     .forEach((track) => localStream.addTrack(track));
   * } catch (error) {
   *  console.error("Couldn't get camera permission:", error);
   * }
   *
   * localStream
   *  .getTracks()
   *  .forEach((track) => webrtc.addTrack(track, localStream));
   * ```
   */
  public addTrack(track: MediaStreamTrack, stream: MediaStream, trackMetadata: any = {}) {
    this.localTracksWithStreams.push({ track, stream });
    this.localTrackIdToMetadata.set(track.id, trackMetadata);

    if (this.connection) {
      this.connection.addTrack(track, stream);

      this.connection
        .getTransceivers()
        .forEach(
          (trans) =>
            (trans.direction = trans.direction == "sendrecv" ? "sendonly" : trans.direction)
        );

      let mediaEvent = generateMediaEvent("restartIce", {});
      this.sendMediaEvent(mediaEvent);
    }
  }

  private getPeerMediaStreams = (peerId: string): MediaStream[] => {
    const peer: Peer = this.idToPeer.get(peerId)!;

    return Array.from(peer.trackIdToMetadata.keys())
      .map((trackId) => this.trackIdToTrack.get(trackId)!)
      .map((trackContext) => trackContext.stream!);
  };

  /**
   * Replaces a track that is being sent to the SFU server.
   * At the moment this assumes that only one video and one audio track is being sent.
   * @param track - Audio or video track.
   *
   * @example
   * ```ts
   * // setup camera
   * let localStream: MediaStream = new MediaStream();
   * try {
   *   localVideoStream = await navigator.mediaDevices.getUserMedia(
   *     VIDEO_CONSTRAINTS
   *   );
   *   localVideoStream
   *     .getTracks()
   *     .forEach((track) => localStream.addTrack(track));
   * } catch (error) {
   *   console.error("Couldn't get camera permission:", error);
   * }
   *
   * localStream
   *  .getTracks()
   *  .forEach((track) => webrtc.addTrack(track, localStream));
   *
   * // change camera
   * const oldTrackId = localStream.getVideoTracks()[0].id;
   * let videoDeviceId = "abcd-1234";
   * navigator.mediaDevices.getUserMedia({
   *      video: {
   *        ...(VIDEO_CONSTRAINTS as {}),
   *        deviceId: {
   *          exact: videoDeviceId,
   *        },
   *      }
   *   })
   *   .then((stream) => {
   *     let videoTrack = stream.getVideoTracks()[0];
   *     webrtc.replaceTrack(oldTrackId, videoTrack);
   *   })
   *   .catch((error) => {
   *     console.error('Error switching camera', error);
   *   })
   * ```
   */
  public async replaceTrack(oldTrackId: string, newTrack: MediaStreamTrack): Promise<any> {
    const sender = this.connection!.getSenders().find((sender) => {
      return sender!.track!.id === oldTrackId;
    });
    return sender!.replaceTrack(newTrack);
  }

  /**
   * Leaves the room. This function should be called when user leaves the room
   * in a clean way e.g. by clicking a dedicated, custom button `disconnect`.
   * As a result there will be generated one more media event that should be
   * sent to the SFU server. Thanks to it each other peer will be notified
   * that peer left in {@link onPeerLeft},
   */
  public leave = () => {
    let mediaEvent = generateMediaEvent("leave");
    this.sendMediaEvent(mediaEvent);
    this.cleanUp();
  };

  /**
   * Cleans up {@link MembraneWebRTC} instance.
   */
  public cleanUp = () => {
    if (this.connection) {
      this.connection.onicecandidate = null;
      this.connection.ontrack = null;
    }

    this.localTracksWithStreams.forEach(({ track }) => track.stop());
    this.localTracksWithStreams = [];
    this.connection = undefined;
  };

  private sendMediaEvent = (mediaEvent: MediaEvent) => {
    this.callbacks.onSendMediaEvent(serializeMediaEvent(mediaEvent));
  };

  private onAnswer = async (answer: RTCSessionDescriptionInit) => {
    this.connection!.ontrack = this.onTrack();
    try {
      await this.connection!.setRemoteDescription(answer);
    } catch (err) {
      console.log(err);
    }
  };

  private addTransceiversIfNeeded = (serverTracks: Map<string, number>) => {
    const recvTransceivers = this.connection!.getTransceivers().filter(
      (elem) => elem.direction === "recvonly"
    );
    let toAdd: string[] = [];

    const getNeededTransceiversTypes = (type: string): string[] => {
      let typeNumber = serverTracks.get(type);
      typeNumber = typeNumber !== undefined ? typeNumber : 0;
      const typeTransceiversNumber = recvTransceivers.filter(
        (elem) => elem.receiver.track.kind === type
      ).length;
      return Array(typeNumber - typeTransceiversNumber).fill(type);
    };

    const audio = getNeededTransceiversTypes("audio");
    const video = getNeededTransceiversTypes("video");
    toAdd = toAdd.concat(audio);
    toAdd = toAdd.concat(video);

    for (let kind of toAdd) this.connection?.addTransceiver(kind, { direction: "recvonly" });
  };

  async restartIce() {
    if (this.connection) {
      await this.createAndSendOffer();
    }
  }

  private async createAndSendOffer() {
    if (!this.connection) return;
    try {
      const offer = await this.connection.createOffer();
      await this.connection.setLocalDescription(offer);
      const localTrackMidToMetadata = {} as any;

      this.connection.getTransceivers().forEach((transceiver) => {
        const trackId = transceiver.sender.track?.id;
        const mid = transceiver.mid;
        if (trackId && mid) localTrackMidToMetadata[mid] = this.localTrackIdToMetadata.get(trackId);
      });
      let mediaEvent = generateMediaEvent("sdpOffer", {
        sdpOffer: offer,
        midToTrackMetadata: localTrackMidToMetadata,
      });
      this.sendMediaEvent(mediaEvent);
    } catch (error) {
      console.error(error);
    }
  }

  private onOfferData = async (offerData: Map<string, number>) => {
    if (!this.connection) {
      this.connection = new RTCPeerConnection(this.rtcConfig);
      this.connection.onicecandidate = this.onLocalCandidate();

      this.localTracksWithStreams.forEach(({ track, stream }) => {
        this.connection!.addTrack(track, stream);
      });

      this.connection.getTransceivers().forEach((trans) => (trans.direction = "sendonly"));
    } else {
      await this.connection.restartIce();
    }

    this.addTransceiversIfNeeded(offerData);

    await this.createAndSendOffer();
  };

  private onRemoteCandidate = (candidate: RTCIceCandidate) => {
    try {
      const iceCandidate = new RTCIceCandidate(candidate);
      if (!this.connection) {
        throw new Error("Received new remote candidate but RTCConnection is undefined");
      }
      this.connection.addIceCandidate(iceCandidate);
    } catch (error) {
      console.error(error);
    }
  };

  private onLocalCandidate = () => {
    return (event: RTCPeerConnectionIceEvent) => {
      if (event.candidate) {
        let mediaEvent = generateMediaEvent("candidate", {
          candidate: event.candidate.candidate,
          sdpMLineIndex: event.candidate.sdpMLineIndex,
        });
        this.sendMediaEvent(mediaEvent);
      }
    };
  };

  private onTrack = () => {
    return (event: RTCTrackEvent) => {
      const [stream] = event.streams;
      const mid = event.transceiver.mid!;

      const trackId = this.midToTrackId.get(mid)!;
      console.log(this.idToPeer);
      const peer = Array.from(this.idToPeer.values()).filter((peer) =>
        Array.from(peer.trackIdToMetadata.keys()).includes(trackId)
      )[0];
      const metadata = peer.trackIdToMetadata.get(trackId);
      const trackContext = {
        stream,
        track: event.track,
        peer: peer,
        trackId,
        metadata,
      };

      this.midToStream.set(mid, stream);
      this.trackIdToTrack.set(trackId, trackContext);

      stream.onremovetrack = (e) => {
        const hasTracks = stream.getTracks().length > 0;

        if (!hasTracks) {
          this.midToStream.delete(mid);
          stream.onremovetrack = null;
        }

        this.callbacks.onTrackRemoved?.(trackContext);
      };

      this.callbacks.onTrackAdded?.(trackContext);
    };
  };

  private addPeer = (peer: Peer): void => {
    peer.trackIdToMetadata = new Map(Object.entries(peer.trackIdToMetadata));
    this.idToPeer.set(peer.id, peer);
  };

  private removePeer = (peer: Peer): void => {
    const tracksId = Array.from(peer.trackIdToMetadata.keys());
    tracksId.forEach((trackId) => this.trackIdToTrack.delete(trackId));
    Array.from(this.midToTrackId.entries()).forEach(([mid, trackId]) => {
      if (tracksId.includes(trackId)) this.midToTrackId.delete(mid);
    });
    this.idToPeer.delete(peer.id);
  };
}
