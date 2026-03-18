import type {
  GetCallStatusInput,
  GetCallStatusResult,
  HangupCallInput,
  InitiateCallInput,
  InitiateCallResult,
  PlayTtsInput,
  ProviderName,
  ProviderWebhookParseResult,
  StartListeningInput,
  StopListeningInput,
  WebhookContext,
  WebhookParseOptions,
  WebhookVerificationResult,
} from "../types.js";
import type { VoiceCallProvider } from "./base.js";

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

  constructor(config: { apiUrl: string; apiToken: string }) {
    this.apiUrl = config.apiUrl.replace(/\/$/, ""); // Remove trailing slash
    this.apiToken = config.apiToken;
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
    // TODO(T20): Implement full WebSocket event parsing
    // For now, return empty events — WebSocket management added in T20
    try {
      JSON.parse(ctx.rawBody);
      // Event mapping will be implemented in T20 (bandwidth provider WebSocket integration)
    } catch {
      // Ignore parse errors for now
    }
    return { events: [] };
  }

  /**
   * Initiate an outbound voice call via ClawComm API.
   * ClawComm will call Jambonz, which routes through Bandwidth to the PSTN.
   */
  async initiateCall(input: InitiateCallInput): Promise<InitiateCallResult> {
    const response = await fetch(`${this.apiUrl}/api/v1/calls/initiate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiToken}`,
      },
      body: JSON.stringify({
        to: input.to,
        message: input.clientState?.message,
        mode: input.clientState?.mode ?? "conversation",
        internal_call_id: input.callId,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`ClawComm API error initiating call: ${response.status} ${error}`);
    }

    const data = (await response.json()) as { call_id: string; status: string };
    return {
      providerCallId: data.call_id,
      status: "initiated",
    };
  }

  /**
   * Hang up an active call via ClawComm API.
   */
  async hangupCall(input: HangupCallInput): Promise<void> {
    const response = await fetch(
      `${this.apiUrl}/api/v1/calls/${input.providerCallId}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${this.apiToken}` },
      },
    );

    if (!response.ok && response.status !== 404) {
      // 404 means call already ended — that's OK
      const error = await response.text();
      throw new Error(`ClawComm API error hanging up call: ${response.status} ${error}`);
    }
  }

  /**
   * Play TTS audio to the caller.
   * Sends the text to ClawComm API which instructs Jambonz to use the 'say' verb.
   * Jambonz handles the actual TTS synthesis and audio playback.
   */
  async playTts(input: PlayTtsInput): Promise<void> {
    const response = await fetch(
      `${this.apiUrl}/api/v1/calls/${input.providerCallId}/speak`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiToken}`,
        },
        body: JSON.stringify({ text: input.text }),
      },
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`ClawComm API error playing TTS: ${response.status} ${error}`);
    }
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
      const response = await fetch(
        `${this.apiUrl}/api/v1/calls/${input.providerCallId}`,
        {
          headers: { Authorization: `Bearer ${this.apiToken}` },
        },
      );

      if (response.status === 404) {
        return { status: "completed", isTerminal: true };
      }

      if (!response.ok) {
        // Transient error — return unknown so caller can retry
        return { status: "unknown", isTerminal: false, isUnknown: true };
      }

      const data = (await response.json()) as {
        status: string;
        is_terminal: boolean;
      };

      return {
        status: data.status,
        isTerminal: data.is_terminal,
      };
    } catch {
      // Network error — return unknown (transient)
      return { status: "unknown", isTerminal: false, isUnknown: true };
    }
  }
}
