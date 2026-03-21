import type {
  CallState,
  EndReason,
  GetCallStatusInput,
  GetCallStatusResult,
  HangupCallInput,
  InitiateCallInput,
  InitiateCallResult,
  NormalizedEvent,
  PlayTtsInput,
  ProviderName,
  ProviderWebhookParseResult,
  StartListeningInput,
  StopListeningInput,
  WebhookContext,
  WebhookParseOptions,
  WebhookVerificationResult,
} from "../types.js";
import { TerminalStates } from "../types.js";
import type { VoiceCallProvider } from "./base.js";
import { guardedJsonApiRequest } from "./shared/guarded-json-api.js";

/**
 * ClawComm/Bandwidth provider for OpenClaw voice calls.
 *
 * This provider connects to the ClawComm API service which proxies through
 * Jambonz + Bandwidth for telecom. Phase 1 uses signaling-only mode
 * (Jambonz handles all STT/TTS). WebSocket connection management is added in T20.
 *
 * Audio Architecture (Phase 1 - Signaling Only):
 * - TTS: OpenClaw calls playTts() → ClawComm REST API → Jambonz 'say' verb → caller hears audio
 * - STT: Jambonz 'gather' verb handles speech → sends transcript to ClawComm → forwarded via WebSocket
 * - startListening/stopListening are no-ops (Jambonz gather handles the STT lifecycle)
 */
export class BandwidthProvider implements VoiceCallProvider {
  readonly name: ProviderName = "bandwidth";

  private readonly apiUrl: string;
  private readonly apiToken: string;
  private _ws: WebSocket | null = null;
  private _reconnectTimer: NodeJS.Timeout | null = null;
  private _reconnectDelay = 1000;
  private readonly _maxReconnectDelay = 60000;
  private _shouldConnect = false;
  private _eventCallback: ((events: NormalizedEvent[]) => void) | null = null;

  constructor(config: { apiUrl: string; apiToken: string }) {
    if (!config.apiUrl) {
      throw new Error("BandwidthProvider requires apiUrl");
    }
    if (!config.apiToken) {
      throw new Error("BandwidthProvider requires apiToken");
    }

    this.apiUrl = config.apiUrl.replace(/\/$/, ""); // Remove trailing slash
    this.apiToken = config.apiToken;
  }

  setEventCallback(callback: (events: NormalizedEvent[]) => void): void {
    this._eventCallback = callback;
  }

  async connect(eventCallback: (events: NormalizedEvent[]) => void): Promise<void> {
    this._shouldConnect = true;
    this.setEventCallback(eventCallback);
    this._startConnection();
  }

  disconnect(): void {
    this._shouldConnect = false;

    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }

    console.log("[ClawComm] WebSocket disconnected");
  }

  private _startConnection(): void {
    if (!this._shouldConnect) {
      return;
    }

    if (
      this._ws &&
      (this._ws.readyState === WebSocket.OPEN || this._ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    const wsUrl =
      this.apiUrl.replace(/^https?:\/\//, (match) =>
        match.startsWith("https") ? "wss://" : "ws://",
      ) + `/ws?token=${encodeURIComponent(this.apiToken)}`;

    try {
      this._ws = new WebSocket(wsUrl);

      this._ws.onopen = () => {
        this._reconnectDelay = 1000;
        if (this._reconnectTimer) {
          clearTimeout(this._reconnectTimer);
          this._reconnectTimer = null;
        }
        console.log("[ClawComm] WebSocket connected");
      };

      this._ws.onmessage = (event) => {
        if (typeof event.data !== "string") {
          return;
        }

        const result = this.parseWebhookEvent({
          headers: {},
          rawBody: event.data,
          url: "/ws",
          method: "POST",
        });

        if (result.events.length > 0 && this._eventCallback) {
          this._eventCallback(result.events);
        }
      };

      this._ws.onerror = (err) => {
        console.warn("[ClawComm] WebSocket error:", err);
      };

      this._ws.onclose = () => {
        this._ws = null;
        if (this._shouldConnect) {
          this._scheduleReconnect();
        }
      };
    } catch (err) {
      console.warn("[ClawComm] Failed to create WebSocket:", err);
      this._scheduleReconnect();
    }
  }

  private _scheduleReconnect(): void {
    if (!this._shouldConnect) {
      return;
    }

    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

    const delay = this._reconnectDelay;
    this._reconnectDelay = Math.min(this._reconnectDelay * 2, this._maxReconnectDelay);
    console.log(`[ClawComm] Reconnecting in ${delay}ms...`);

    this._reconnectTimer = globalThis.setTimeout(() => {
      this._startConnection();
    }, delay);
  }

  /**
   * Verify webhook authenticity.
   * For WebSocket-based events, all events are pre-authenticated via the WS token.
   * Always returns ok: true. Actual auth happens during WebSocket handshake.
   */
  verifyWebhook(_ctx: WebhookContext): WebhookVerificationResult {
    return { ok: true };
  }

  /**
   * Parse incoming WebSocket event from ClawComm into NormalizedEvents.
   * WebSocket messages arrive as JSON with type and data fields.
   * This method converts ClawComm event types to OpenClaw NormalizedEvent types.
   *
   * Note: In WebSocket mode, the ctx.rawBody contains the ClawComm event JSON.
   */
  parseWebhookEvent(
    ctx: WebhookContext,
    _options?: WebhookParseOptions,
  ): ProviderWebhookParseResult {
    try {
      const message = JSON.parse(ctx.rawBody) as Record<string, unknown>;

      if (message.type === "call.event" && message.data) {
        const event = message.data as Record<string, unknown>;
        const normalized = this._normalizeEvent(event);
        if (normalized) {
          return { events: [normalized] };
        }
      }

      if (typeof message.type === "string" && message.type.startsWith("call.")) {
        const normalized = this._normalizeEvent(message);
        if (normalized) {
          return { events: [normalized] };
        }
      }
    } catch {}

    return { events: [] };
  }

  private _normalizeEvent(event: Record<string, unknown>): NormalizedEvent | null {
    const type = event.type as string;
    const callId = (event.callId ?? event.call_id) as string | undefined;
    const id = (event.id as string) ?? globalThis.crypto.randomUUID();
    const timestamp = (event.timestamp as number) ?? Date.now();
    const providerCallId = event.providerCallId as string | undefined;

    if (!callId) {
      return null;
    }

    const base = {
      id,
      callId,
      providerCallId,
      timestamp,
      dedupeKey: `${callId}:${type}:${timestamp}`,
    };

    switch (type) {
      case "call.initiated":
        return { ...base, type: "call.initiated" };
      case "call.ringing":
        return { ...base, type: "call.ringing" };
      case "call.answered":
        return { ...base, type: "call.answered" };
      case "call.active":
        return { ...base, type: "call.active" };
      case "call.speaking":
        return {
          ...base,
          type: "call.speaking",
          text: (event.text as string) ?? "",
        };
      case "call.speech":
        return {
          ...base,
          type: "call.speech",
          transcript: (event.transcript as string) ?? "",
          isFinal: (event.isFinal as boolean) ?? true,
          confidence: (event.confidence as number) ?? 1,
        };
      case "call.silence":
        return {
          ...base,
          type: "call.silence",
          durationMs: (event.durationMs as number) ?? 0,
        };
      case "call.dtmf":
        return {
          ...base,
          type: "call.dtmf",
          digits: (event.digits as string) ?? "",
        };
      case "call.ended":
        return {
          ...base,
          type: "call.ended",
          reason: (event.reason as EndReason) ?? "completed",
        };
      case "call.error":
        return {
          ...base,
          type: "call.error",
          error: (event.error as string) ?? "Unknown error",
          retryable: (event.retryable as boolean) ?? false,
        };
      default:
        return null;
    }
  }

  /**
   * Initiate an outbound voice call via ClawComm API.
   * ClawComm will call Jambonz, which routes through Bandwidth to the PSTN.
   */
  async initiateCall(input: InitiateCallInput): Promise<InitiateCallResult> {
    const data = await guardedJsonApiRequest<{ call_id: string; status: string }>({
      url: `${this.apiUrl}/api/v1/calls/initiate`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiToken}`,
      },
      body: {
        to: input.to,
        message: input.clientState?.message,
        mode: input.clientState?.mode ?? "conversation",
        internal_call_id: input.callId,
      },
      allowedHostnames: [new URL(this.apiUrl).hostname],
      auditContext: "voice-call.bandwidth.initiate-call",
      errorPrefix: "ClawComm API error initiating call",
    });

    return {
      providerCallId: data.call_id,
      status: "initiated",
    };
  }

  /**
   * Hang up an active call via ClawComm API.
   */
  async hangupCall(input: HangupCallInput): Promise<void> {
    await guardedJsonApiRequest({
      url: `${this.apiUrl}/api/v1/calls/${input.providerCallId}`,
      method: "DELETE",
      headers: { Authorization: `Bearer ${this.apiToken}` },
      allowNotFound: true,
      allowedHostnames: [new URL(this.apiUrl).hostname],
      auditContext: "voice-call.bandwidth.hangup-call",
      errorPrefix: "ClawComm API error hanging up call",
    });
  }

  /**
   * Play TTS audio to the caller.
   * Sends the text to ClawComm API which instructs Jambonz to use the 'say' verb.
   * Jambonz handles the actual TTS synthesis and audio playback.
   */
  async playTts(input: PlayTtsInput): Promise<void> {
    await guardedJsonApiRequest({
      url: `${this.apiUrl}/api/v1/calls/${input.providerCallId}/speak`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiToken}`,
      },
      body: { text: input.text },
      allowedHostnames: [new URL(this.apiUrl).hostname],
      auditContext: "voice-call.bandwidth.play-tts",
      errorPrefix: "ClawComm API error playing TTS",
    });
  }

  /**
   * Start listening for user speech (Phase 1 signaling-only: no-op).
   * In Phase 1, Jambonz's 'gather' verb handles the STT lifecycle automatically.
   * The gather verb starts listening as soon as it's sent, so no explicit start is needed.
   *
   * TODO(Phase 2): When adding audio streaming, this will activate the audio passthrough.
   */
  async startListening(_input: StartListeningInput): Promise<void> {
    // No-op: Jambonz gather verb controls STT lifecycle in signaling-only mode.
    // Phase 2 will add bidirectional audio streaming here.
  }

  /**
   * Stop listening for user speech (Phase 1 signaling-only: no-op).
   * In Phase 1, Jambonz handles the gather/listen cycle automatically.
   *
   * TODO(Phase 2): When adding audio streaming, this will stop the audio passthrough.
   */
  async stopListening(_input: StopListeningInput): Promise<void> {
    // No-op: Jambonz gather verb controls STT lifecycle in signaling-only mode.
    // Phase 2 will stop audio streaming here.
  }

  /**
   * Query call status from ClawComm API.
   */
  async getCallStatus(input: GetCallStatusInput): Promise<GetCallStatusResult> {
    try {
      const data = await guardedJsonApiRequest<{
        status: string;
        is_terminal?: boolean;
      } | null>({
        url: `${this.apiUrl}/api/v1/calls/${input.providerCallId}`,
        method: "GET",
        headers: { Authorization: `Bearer ${this.apiToken}` },
        allowNotFound: true,
        allowedHostnames: [new URL(this.apiUrl).hostname],
        auditContext: "voice-call.bandwidth.get-call-status",
        errorPrefix: "ClawComm API error getting call status",
      });

      if (!data) {
        return { status: "completed", isTerminal: true };
      }

      const statusMap: Record<string, CallState> = {
        initiated: "initiated",
        ringing: "ringing",
        answered: "answered",
        active: "active",
        speaking: "speaking",
        completed: "completed",
        ended: "completed",
        failed: "failed",
        "no-answer": "no-answer",
        busy: "busy",
      };

      const state = statusMap[data.status] ?? "completed";
      const isTerminal = data.is_terminal ?? TerminalStates.has(state);

      return {
        status: state,
        isTerminal,
      };
    } catch {
      return { status: "unknown", isTerminal: false, isUnknown: true };
    }
  }
}
