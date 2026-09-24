import type { NumberProvider } from "./types.js";

/**
 * Buys a dedicated Australian number per user and registers it with ElevenLabs so
 * the voice agent answers every inbound call.
 *
 * PHASE 0 VERIFY: Australian numbers need a Twilio regulatory bundle and address
 * (TWILIO_AU_BUNDLE_SID / TWILIO_AU_ADDRESS_SID). Not yet run against a live account.
 */
export class TwilioNumbers implements NumberProvider {
  constructor(
    private accountSid: string,
    private authToken: string,
    private elevenLabsApiKey: string,
    private opts: { bundleSid?: string; addressSid?: string; smsWebhookUrl: string; label: (userId: string) => string },
  ) {}

  private auth() {
    return "Basic " + Buffer.from(`${this.accountSid}:${this.authToken}`).toString("base64");
  }

  async provisionAssistantNumber(userId: string) {
    const base = `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}`;
    const search = await fetch(`${base}/AvailablePhoneNumbers/AU/Local.json?VoiceEnabled=true&SmsEnabled=true&PageSize=1`, {
      headers: { authorization: this.auth() },
    });
    if (!search.ok) throw new Error(`Twilio number search failed: ${search.status}`);
    const candidate = ((await search.json()) as { available_phone_numbers: Array<{ phone_number: string }> })
      .available_phone_numbers[0];
    if (!candidate) throw new Error("No Australian numbers available");

    const form = new URLSearchParams({
      PhoneNumber: candidate.phone_number,
      FriendlyName: this.opts.label(userId),
      SmsUrl: this.opts.smsWebhookUrl,
    });
    if (this.opts.bundleSid) form.set("BundleSid", this.opts.bundleSid);
    if (this.opts.addressSid) form.set("AddressSid", this.opts.addressSid);
    const buy = await fetch(`${base}/IncomingPhoneNumbers.json`, {
      method: "POST",
      headers: { authorization: this.auth(), "content-type": "application/x-www-form-urlencoded" },
      body: form,
    });
    if (!buy.ok) throw new Error(`Twilio number purchase failed: ${buy.status} ${await buy.text()}`);
    const bought = (await buy.json()) as { phone_number: string };

    // Import into ElevenLabs so its agent answers calls to this number.
    const imp = await fetch("https://api.elevenlabs.io/v1/convai/phone-numbers", {
      method: "POST",
      headers: { "xi-api-key": this.elevenLabsApiKey, "content-type": "application/json" },
      body: JSON.stringify({
        phone_number: bought.phone_number,
        label: this.opts.label(userId),
        sid: this.accountSid,
        token: this.authToken,
        provider: "twilio",
      }),
    });
    if (!imp.ok) throw new Error(`ElevenLabs number import failed: ${imp.status} ${await imp.text()}`);
    const { phone_number_id } = (await imp.json()) as { phone_number_id: string };
    return { number: bought.phone_number, voicePhoneNumberId: phone_number_id };
  }
}
