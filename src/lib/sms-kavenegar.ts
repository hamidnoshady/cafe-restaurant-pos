import { SmsProvider } from "./sms";

export class KavenegarProvider implements SmsProvider {
  constructor(private apiKey: string, private template: string) {}

  async sendOtp(phoneE164: string, otp: string): Promise<void> {
    // Normalise to Iranian local format if it has +98
    let receptor = phoneE164;
    if (receptor.startsWith("+98")) {
      receptor = "0" + receptor.slice(3);
    } else if (receptor.startsWith("98") && receptor.length === 12) {
      receptor = "0" + receptor.slice(2);
    }

    const url = `https://api.kavenegar.com/v1/${this.apiKey}/verify/lookup.json?receptor=${encodeURIComponent(
      receptor
    )}&token=${encodeURIComponent(otp)}&template=${encodeURIComponent(this.template)}`;

    let res;
    try {
      res = await fetch(url);
    } catch (err) {
      throw new Error(`Kavenegar network error: ${err}`);
    }

    if (!res.ok) {
      let bodyText = "";
      try {
        bodyText = await res.text();
      } catch {
        // ignore
      }
      throw new Error(
        `Kavenegar rejected with status ${res.status}: ${bodyText}. Request URL: ${redactKavenegarUrl(url)}`
      );
    }

    const data = await res.json();
    if (data.return?.status !== 200) {
      throw new Error(
        `Kavenegar verify/lookup failed with code ${data.return?.status}: ${data.return?.message}`
      );
    }
  }
}

export function redactKavenegarUrl(url: string): string {
  return url
    .replace(/\/v1\/[^/]+\//, "/v1/REDACTED/")
    .replace(/([?&]token=)[^&]*/, "$1REDACTED");
}
